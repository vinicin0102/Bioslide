/**
 * Utilitários compartilhados pelas funções da API (Vercel).
 * Arquivos com "_" na frente não viram rota — este não responde nada sozinho.
 *
 * Configuração: variáveis de ambiente do projeto no Vercel.
 * O client_secret nunca vai para o navegador.
 */
import crypto from 'node:crypto';

/** Lê a primeira variável de ambiente preenchida entre os nomes aceitos. */
function env(...nomes) {
    for (const nome of nomes) {
        const valor = process.env[nome];
        if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
    }
    return '';
}

export function config() {
    const site = env('SITE_URL') || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');
    return {
        // Aceita também os nomes já cadastrados no painel (cliend_id / Client_Secret).
        clientId:      env('ZUCKPAY_CLIENT_ID', 'CLIENT_ID', 'client_id', 'cliend_id', 'Client_Id', 'Client_ID'),
        clientSecret:  env('ZUCKPAY_CLIENT_SECRET', 'CLIENT_SECRET', 'client_secret', 'Client_Secret'),
        webhookSecret: env('ZUCKPAY_WEBHOOK_SECRET', 'WEBHOOK_SECRET', 'webhook_secret', 'Webhook_Secret'),
        /*
         * Use exatamente o host da tela de Credenciais API da ZuckPay (com ou
         * sem www). Com o host errado a API responde um redirecionamento e o
         * POST autenticado não é reenviado — a cobrança nunca chega.
         */
        apiBase:    (env('ZUCKPAY_API_BASE') || 'https://www.zuckpay.com.br/conta/v3/pix').replace(/\/+$/, ''),
        webhookUrl: env('ZUCKPAY_WEBHOOK_URL') || (site ? site.replace(/\/+$/, '') + '/api/webhook' : ''),
        debug:      env('ZUCKPAY_DEBUG') === '1',
    };
}

/**
 * Planos e order bumps. O PREÇO FICA AQUI, no servidor: o navegador manda só
 * os ids, e qualquer valor vindo do cliente é ignorado.
 */
export const PLANOS = {
    slides: { nome: 'BIO SLIDES — +250 Slides de Biologia Prontos', valor: 12.90, productId: env('ZUCKPAY_PRODUCT_ID_SLIDES') },
    biobox: { nome: 'BIOBOX PROFESSOR — Biblioteca Completa',      valor: 27.00, productId: env('ZUCKPAY_PRODUCT_ID_BIOBOX') },
};

/**
 * codigo:    letra gravada no external_id_client (BS-<plano>-<códigos>-<pedido>)
 *            para saber o que entregar.
 * inclusoEm: planos que já trazem esse conteúdo — não é oferecido nem cobrado.
 */
export const BUMPS = {
    jogos:      { nome: '50 Jogos de Biologia',         valor: 4.90, codigo: 'j', inclusoEm: ['biobox'] },
    provas:     { nome: '50 Provas + Gabaritos',        valor: 7.90, codigo: 'p', inclusoEm: ['biobox'] },
    praticas:   { nome: '30 Aulas Práticas',            valor: 7.90, codigo: 'x', inclusoEm: ['biobox'] },
    atividades: { nome: '100 Atividades de Fixação',    valor: 4.90, codigo: 'a', inclusoEm: ['biobox'] },
    genetica:   { nome: 'Kit Genética',                 valor: 4.90, codigo: 'g', inclusoEm: [] },
    ecologia:   { nome: 'Kit Ecologia',                 valor: 4.90, codigo: 'e', inclusoEm: [] },
    prompts:    { nome: '100 Prompts para Professores', valor: 7.90, codigo: 'i', inclusoEm: [] },
};

export function json(status, dados) {
    return new Response(JSON.stringify(dados), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

export function registrarErro(contexto, detalhe) {
    console.error(`[zuckpay][${contexto}] ${detalhe}`);
}

/** Valida CPF incluindo os dígitos verificadores. */
export function cpfValido(cpf) {
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    for (let posicao = 9; posicao < 11; posicao++) {
        let soma = 0;
        for (let i = 0; i < posicao; i++) soma += Number(cpf[i]) * (posicao + 1 - i);
        if (Number(cpf[posicao]) !== ((10 * soma) % 11) % 10) return false;
    }
    return true;
}

/**
 * Chamada autenticada à API da ZuckPay.
 *
 * Redirecionamentos NÃO são seguidos: seguir um 3xx num POST autenticado
 * reenviaria o Authorization e o corpo costuma se perder. O destino volta
 * para que o ZUCKPAY_API_BASE seja corrigido.
 *
 * @returns {Promise<{status:number, corpo:object, destino:string}>}
 */
export async function chamarZuckpay(cfg, metodo, caminho, payload) {
    const cabecalhos = {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
    };
    const opcoes = { method: metodo, headers: cabecalhos, redirect: 'manual', signal: AbortSignal.timeout(25000) };
    if (metodo === 'POST') {
        cabecalhos['Content-Type'] = 'application/json';
        opcoes.body = JSON.stringify(payload);
    }

    let resposta;
    try {
        resposta = await fetch(cfg.apiBase + caminho, opcoes);
    } catch (erro) {
        registrarErro('fetch', String(erro && erro.message || erro));
        return { status: 0, corpo: {}, destino: '' };
    }

    const destino = resposta.status >= 300 && resposta.status < 400 ? (resposta.headers.get('location') || '') : '';
    if (destino) registrarErro('redirect', `HTTP ${resposta.status} -> ${destino}`);

    const texto = await resposta.text();
    let corpo = {};
    try { corpo = JSON.parse(texto); } catch { registrarErro('resposta', `HTTP ${resposta.status} com corpo não-JSON`); }
    return { status: resposta.status, corpo: corpo && typeof corpo === 'object' ? corpo : {}, destino };
}

/**
 * Valida o header X-ZuckPay-Signature: t=<timestamp>,v1=<hmac_sha256_hex>
 * sobre "<timestamp>.<corpo_raw>", com janela anti-replay de 5 minutos.
 */
export function assinaturaWebhookValida(header, corpoRaw, segredo) {
    if (!header) return [false, 'header X-ZuckPay-Signature ausente'];
    const partes = Object.fromEntries(header.split(',').map(p => p.trim().split('=')));
    const ts = partes.t || '';
    const v1 = partes.v1 || '';
    if (!/^\d+$/.test(ts) || !/^[0-9a-f]+$/i.test(v1)) return [false, 'header malformado'];
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return [false, 'timestamp fora da janela de 5 minutos'];

    const esperado = crypto.createHmac('sha256', segredo).update(`${ts}.${corpoRaw}`).digest('hex');
    const a = Buffer.from(esperado, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return [false, 'assinatura não confere'];
    return [true, ''];
}

/** Lê plano e bumps do external_id_client (BS-<plano>-<códigos>-<pedido>). */
export function itensDoPedido(externalId) {
    const m = /^BS-([a-z]+)-([a-z0-9]+)-/.exec(externalId || '');
    if (!m) return { plano: '', bumps: [] };
    const bumps = m[2] === '0' ? [] : Object.entries(BUMPS).filter(([, b]) => m[2].includes(b.codigo)).map(([id]) => id);
    return { plano: m[1], bumps };
}

/**
 * Cache curto das consultas de status, em memória da instância.
 * A ZuckPay aplica rate limit (429); várias abas consultando juntas não
 * devem gerar chamadas repetidas.
 */
const cacheStatus = new Map();
export function cacheLer(id, validadeMs = 8000) {
    const item = cacheStatus.get(id);
    return item && Date.now() - item.em < validadeMs ? item.dados : null;
}
export function cacheGravar(id, dados) {
    if (cacheStatus.size > 500) cacheStatus.clear();
    cacheStatus.set(id, { em: Date.now(), dados });
}

export const ID_TRANSACAO = /^[A-Za-z0-9._-]{8,128}$/;
