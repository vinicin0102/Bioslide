/**
 * Coleta o comportamento dos visitantes para o painel (/painel.html).
 *
 * POST { sid, vid, ctx?, eventos: [{ t, tipo, d? }] }
 *
 * Nada de dado pessoal: não recebe nome, CPF, e-mail nem telefone — só um id
 * anônimo por aba (sid) e por navegador (vid), a seção vista e as ações.
 */
import { redisConfigurado, pipeline, dataBR, PREFIXO, DIAS_SESSAO } from './_redis.js';

const TIPOS = new Set([
    'page_view', 'secao', 'ping', 'saiu', 'voltou', 'clique', 'faq',
    'video_play', 'video_pause', 'video_progresso', 'video_fim',
    'checkout_aberto', 'checkout_fechado', 'upgrade', 'bump', 'form_inicio',
    'pix_solicitado', 'pix_gerado', 'pix_erro', 'pix_copiado', 'pago',
]);
const SECOES = new Set(['topo', 'slides', 'dor', 'conteudo', 'estrutura', 'publico', 'biobox', 'depoimentos', 'planos', 'faq', 'rodape']);
const ID = /^[A-Za-z0-9-]{8,64}$/;

/** Texto curto e sem quebras, para nada estranho chegar ao painel. */
function curto(valor, max = 80) {
    return String(valor ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

/** Mantém só campos simples e curtos em "d". */
function limparDados(d) {
    const saida = {};
    if (!d || typeof d !== 'object') return saida;
    for (const [chave, valor] of Object.entries(d).slice(0, 8)) {
        if (!/^[a-z_]{1,20}$/.test(chave)) continue;
        if (typeof valor === 'number' && Number.isFinite(valor)) saida[chave] = Math.round(valor * 100) / 100;
        else if (typeof valor === 'boolean') saida[chave] = valor;
        else if (typeof valor === 'string') saida[chave] = curto(valor);
    }
    return saida;
}

/** Etapa do funil que o evento representa (contada uma vez por sessão). */
function etapaDoEvento(e) {
    switch (e.tipo) {
        case 'page_view':       return 'entrou';
        case 'secao':           return SECOES.has(e.d.nome) ? 's_' + e.d.nome : null;
        case 'checkout_aberto': return 'checkout';
        case 'form_inicio':     return 'dados';
        case 'pix_gerado':      return 'pix';
        case 'pix_copiado':     return 'copiou';
        case 'pago':            return 'pago';
        case 'video_play':      return 'video_play';
        case 'video_progresso': return [25, 50, 75, 100].includes(e.d.pct) ? 'video_' + e.d.pct : null;
        default:                return null;
    }
}

const ORDEM_COMPRA = ['entrou', 'checkout', 'dados', 'pix', 'copiou', 'pago'];

export async function POST(request) {
    if (!redisConfigurado()) return new Response(null, { status: 204 });

    let corpo;
    try { corpo = JSON.parse(await request.text()); } catch { return new Response(null, { status: 400 }); }
    const sid = String(corpo?.sid ?? '');
    const vid = String(corpo?.vid ?? '');
    if (!ID.test(sid) || !Array.isArray(corpo.eventos)) return new Response(null, { status: 400 });

    const agora = Date.now();
    const eventos = corpo.eventos.slice(0, 60)
        .filter(e => e && TIPOS.has(e.tipo))
        .map(e => ({ t: Number.isFinite(e.t) ? Math.round(e.t) : agora, tipo: e.tipo, d: limparDados(e.d) }));
    if (!eventos.length) return new Response(null, { status: 204 });

    const s = PREFIXO + 's:' + sid;
    const lista = PREFIXO + 'e:' + sid;
    const hoje = dataBR(agora);
    const ttl = DIAS_SESSAO * 86400;

    const campos = { ultimo: agora };
    let etapaCompra = -1;
    const etapas = new Set();

    for (const e of eventos) {
        const etapa = etapaDoEvento(e);
        if (etapa) etapas.add(etapa);
        if (ORDEM_COMPRA.includes(etapa)) etapaCompra = Math.max(etapaCompra, ORDEM_COMPRA.indexOf(etapa));

        if (e.tipo === 'secao' && SECOES.has(e.d.nome)) campos.secao = e.d.nome;
        if (typeof e.d.rolagem === 'number') campos.rolagem = Math.min(100, Math.max(0, Math.round(e.d.rolagem)));
        if (e.tipo === 'checkout_aberto' || e.tipo === 'upgrade') campos.plano = curto(e.d.plano, 20);
        if (e.tipo === 'pix_gerado') { campos.valor = e.d.valor ?? ''; campos.pedido = curto(e.d.pedido, 64); }
        if (e.tipo === 'pago') campos.pago = 1;
        if (e.tipo === 'video_progresso' && typeof e.d.pct === 'number') campos.video = e.d.pct;
        if (e.tipo === 'saiu') campos.saiu = 1;
        if (e.tipo === 'voltou' || e.tipo === 'ping' || e.tipo === 'page_view') campos.saiu = 0;
    }

    const cmds = [
        ['HSETNX', s, 'inicio', agora],
        ['HSET', s, ...Object.entries(campos).flat()],
        ['HINCRBY', s, 'eventos', eventos.length],
        ['LPUSH', lista, ...eventos.map(e => JSON.stringify(e))],
        ['LTRIM', lista, 0, 399],
        ['EXPIRE', s, ttl],
        ['EXPIRE', lista, ttl],
        ['ZADD', PREFIXO + 'ult', agora, sid],
        ['ZREMRANGEBYSCORE', PREFIXO + 'ult', 0, agora - ttl * 1000],
        ['ZADD', PREFIXO + 'd:' + hoje, 'NX', agora, sid],
        ['EXPIRE', PREFIXO + 'd:' + hoje, 40 * 86400],
    ];

    // Contexto (origem, dispositivo, cidade) só no primeiro envio da sessão.
    if (corpo.ctx && typeof corpo.ctx === 'object') {
        const c = limparDados(corpo.ctx);
        const cidade = decodeURIComponent(request.headers.get('x-vercel-ip-city') || '');
        cmds.push(['HSET', s,
            'vid', ID.test(vid) ? vid : '',
            'origem', c.origem ?? '', 'campanha', c.campanha ?? '', 'anuncio', c.anuncio ?? '', 'meio', c.meio ?? '',
            'referencia', c.referencia ?? '', 'dispositivo', c.dispositivo ?? '', 'largura', c.largura ?? '',
            'cidade', curto(cidade, 40), 'uf', curto(request.headers.get('x-vercel-ip-country-region') || '', 4),
            'pais', curto(request.headers.get('x-vercel-ip-country') || '', 4),
        ]);
    }

    // PIX gerado: guarda pedido -> sessão para o webhook marcar o pagamento
    // mesmo se o comprador fechar a página.
    if (campos.pedido) cmds.push(['SET', PREFIXO + 'p:' + campos.pedido, sid, 'EX', ttl]);

    const etapasLista = [...etapas];
    etapasLista.forEach(etapa => cmds.push(['HSETNX', s, 'r_' + etapa, 1]));
    if (etapaCompra >= 0) cmds.push(['HGET', s, 'compra']);

    try {
        const res = await pipeline(cmds);
        const base = res.length - etapasLista.length - (etapaCompra >= 0 ? 1 : 0);
        const segundo = [];

        // Conta no funil do dia só as etapas que esta sessão atingiu agora.
        etapasLista.forEach((etapa, i) => {
            if (Number(res[base + i]) === 1) segundo.push(['HINCRBY', PREFIXO + 'f:' + hoje, etapa, 1]);
        });
        if (segundo.length) segundo.push(['EXPIRE', PREFIXO + 'f:' + hoje, 400 * 86400]);

        // Etapa de compra mais avançada (nunca volta).
        if (etapaCompra >= 0) {
            const atual = Number(res[res.length - 1] ?? -1);
            if (!(atual >= etapaCompra)) segundo.push(['HSET', s, 'compra', etapaCompra]);
        }
        await pipeline(segundo);
    } catch (erro) {
        console.error('[rastro]', erro.message);
    }

    return new Response(null, { status: 204 });
}
