/**
 * Cria uma cobrança PIX na ZuckPay.
 *
 * POST { plano, bumps?, pedido, nome, cpf, email, telefone, rastreio? }
 * -> { transactionId, qrcode, qrcode_image, checkout_url, expiracao, valor, plano, itens, pedido }
 */
import crypto from 'node:crypto';
import { config, PLANOS, BUMPS, json, registrarErro, cpfValido, chamarZuckpay } from './_zuckpay.js';

const RASTREIO_PERMITIDO = [
    'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term',
    'fbc', 'fbp', 'fbclid', 'gclid', 'ttclid', 'wbraid', 'gbraid',
    'kclid', 'click_id', 'src', 'sck',
];

export async function POST(request) {
    const cfg = config();
    if (!cfg.clientId || !cfg.clientSecret) {
        registrarErro('pix', 'credenciais ausentes nas variáveis de ambiente');
        return json(500, { erro: 'Pagamento indisponível no momento. Já estamos verificando.' });
    }

    let corpo = {};
    try { corpo = await request.json(); } catch { /* corpo inválido: tratado abaixo */ }
    if (!corpo || typeof corpo !== 'object') corpo = {};

    const planoId = typeof corpo.plano === 'string' ? corpo.plano : '';
    const plano = Object.hasOwn(PLANOS, planoId) ? PLANOS[planoId] : null;
    if (!plano) return json(400, { erro: 'Plano inválido.' });

    // Bumps: só ids conhecidos, sem repetição e fora dos já inclusos no plano.
    const pedidos = Array.isArray(corpo.bumps) ? corpo.bumps : [];
    const bumps = Object.entries(BUMPS).filter(([id, b]) => pedidos.includes(id) && !b.inclusoEm.includes(planoId));

    // Soma em centavos para não acumular erro de ponto flutuante.
    const centavos = bumps.reduce((soma, [, b]) => soma + Math.round(b.valor * 100), Math.round(plano.valor * 100));
    const valorTotal = centavos / 100;
    const itens = [plano.nome, ...bumps.map(([, b]) => b.nome)];
    const codigos = bumps.map(([, b]) => b.codigo).join('');

    const nome = String(corpo.nome ?? '').trim();
    const cpf = String(corpo.cpf ?? '').replace(/\D/g, '');
    const email = String(corpo.email ?? '').trim();
    const telefone = String(corpo.telefone ?? '').replace(/\D/g, '');

    const campos = {};
    if (nome.length < 3 || nome.length > 100) campos.nome = 'Informe seu nome completo.';
    if (!cpfValido(cpf)) campos.cpf = 'CPF inválido.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 150) campos.email = 'E-mail inválido.';
    if (telefone.length < 10 || telefone.length > 11) campos.telefone = 'Telefone inválido. Use DDD + número.';
    if (Object.keys(campos).length) return json(422, { erro: 'Dados inválidos.', campos });

    /*
     * Idempotência: o navegador manda o mesmo "pedido" se o comprador clicar
     * duas vezes. Plano e bumps entram no id, então mudar os bumps gera outra
     * cobrança em vez de devolver uma antiga com outro valor.
     */
    let pedido = String(corpo.pedido ?? '').replace(/[^A-Za-z0-9-]/g, '');
    if (pedido.length < 8 || pedido.length > 60) pedido = crypto.randomBytes(12).toString('hex');

    const payload = {
        nome,
        cpf,
        valor: valorTotal,
        email,
        telefone,
        urlnoty: cfg.webhookUrl,
        descricao: itens.join(' + ').slice(0, 250),
        external_id_client: `BS-${planoId}-${codigos || '0'}-${pedido}`,
    };
    if (plano.productId && /^\d+$/.test(plano.productId)) payload.product_id = Number(plano.productId);

    const rastreio = corpo.rastreio && typeof corpo.rastreio === 'object' ? corpo.rastreio : {};
    for (const chave of RASTREIO_PERMITIDO) {
        if (typeof rastreio[chave] === 'string' && rastreio[chave] !== '') payload[chave] = rastreio[chave].slice(0, 255);
    }

    const { status, corpo: resposta, destino } = await chamarZuckpay(cfg, 'POST', '/qrcode', payload);

    if (status === 429) {
        registrarErro('pix', 'rate limit da ZuckPay');
        return json(429, { erro: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.' });
    }
    if (status === 403) {
        registrarErro('pix', 'HTTP 403 — provável IP whitelist bloqueando o servidor');
        return json(502, { erro: 'Pagamento indisponível no momento. Já estamos verificando.' });
    }
    if (status !== 200 || !resposta.transactionId) {
        const ref = crypto.randomBytes(4).toString('hex');
        registrarErro('pix', `ref=${ref} HTTP ${status} ${destino ? '-> ' + destino + ' ' : ''}${JSON.stringify(resposta)}`);
        const saida = { erro: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.', ref };
        if (cfg.debug) {
            const { cpf: _c, email: _e, telefone: _t, ...enviado } = payload;
            saida.debug = { http: status, redirect: destino, resposta, enviado };
        }
        return json(502, saida);
    }

    // Só o que o navegador precisa. Nada de credencial, nada de valor líquido.
    return json(200, {
        transactionId: String(resposta.transactionId),
        qrcode:        String(resposta.qrcode ?? resposta.pix_code ?? ''),
        qrcode_image:  String(resposta.qrcode_image ?? ''),
        checkout_url:  String(resposta.checkout_url ?? ''),
        expiracao:     Number(resposta.calendar?.expiration ?? 1200) || 1200,
        valor:         valorTotal,
        plano:         plano.nome,
        itens,
        pedido,
    });
}
