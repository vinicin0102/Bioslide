/**
 * Coleta o comportamento dos visitantes para o painel (/painel.html).
 *
 * POST { sid, vid, ctx?, eventos: [{ t, tipo, d? }] }
 *
 * Nada de dado pessoal: não recebe nome, CPF, e-mail nem telefone — só um id
 * anônimo por aba (sid) e por navegador (vid), a seção vista e as ações.
 */
import { bancoConfigurado, banco, dataBR, registrarEtapas, DIAS_SESSAO } from './_banco.js';

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
    if (!bancoConfigurado()) return new Response(null, { status: 204 });

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

    const hoje = dataBR(agora);
    let secao = null, rolagem = null, plano = null, valor = null, pedido = null, pago = null, video = null, saiu = null;
    let etapaCompra = -1;
    const etapas = new Set();

    for (const e of eventos) {
        const etapa = etapaDoEvento(e);
        if (etapa) etapas.add(etapa);
        if (ORDEM_COMPRA.includes(etapa)) etapaCompra = Math.max(etapaCompra, ORDEM_COMPRA.indexOf(etapa));

        if (e.tipo === 'secao' && SECOES.has(e.d.nome)) secao = e.d.nome;
        if (typeof e.d.rolagem === 'number') rolagem = Math.min(100, Math.max(0, Math.round(e.d.rolagem)));
        if (e.tipo === 'checkout_aberto' || e.tipo === 'upgrade') plano = curto(e.d.plano, 20);
        if (e.tipo === 'pix_gerado') { valor = typeof e.d.valor === 'number' ? e.d.valor : null; pedido = curto(e.d.pedido, 64) || null; }
        if (e.tipo === 'pago') pago = true;
        if (e.tipo === 'video_progresso' && typeof e.d.pct === 'number') video = e.d.pct;
        if (e.tipo === 'saiu') saiu = true;
        if (e.tipo === 'voltou' || e.tipo === 'ping' || e.tipo === 'page_view') saiu = false;
    }

    // Contexto (origem, dispositivo, cidade) vem só no primeiro envio da sessão.
    const c = corpo.ctx && typeof corpo.ctx === 'object' ? limparDados(corpo.ctx) : null;
    const cidade = c ? curto(decodeURIComponent(request.headers.get('x-vercel-ip-city') || ''), 40) : '';

    try {
        const db = await banco();
        await db.begin(async tx => {
            await tx`
                INSERT INTO bioslide.sessoes (sid, vid, dia, inicio, ultimo)
                VALUES (${sid}, ${ID.test(vid) ? vid : ''}, ${hoje}, ${agora}, ${agora})
                ON CONFLICT (sid) DO NOTHING`;

            await tx`
                UPDATE bioslide.sessoes SET
                    ultimo  = ${agora},
                    eventos = eventos + ${eventos.length},
                    secao   = COALESCE(${secao}, secao),
                    rolagem = GREATEST(rolagem, COALESCE(${rolagem}, 0)),
                    compra  = GREATEST(compra, ${etapaCompra}),
                    plano   = COALESCE(${plano}, plano),
                    valor   = COALESCE(${valor}, valor),
                    pedido  = COALESCE(${pedido}, pedido),
                    pago    = pago OR COALESCE(${pago}, false),
                    video   = GREATEST(video, COALESCE(${video}, 0)),
                    saiu    = COALESCE(${saiu}, saiu)
                WHERE sid = ${sid}`;

            if (c) {
                await tx`
                    UPDATE bioslide.sessoes SET
                        origem = ${c.origem ?? ''}, campanha = ${c.campanha ?? ''}, anuncio = ${c.anuncio ?? ''},
                        meio = ${c.meio ?? ''}, referencia = ${c.referencia ?? ''}, dispositivo = ${c.dispositivo ?? ''},
                        largura = ${typeof c.largura === 'number' ? Math.round(c.largura) : null},
                        cidade = ${cidade}, uf = ${curto(request.headers.get('x-vercel-ip-country-region') || '', 4)},
                        pais = ${curto(request.headers.get('x-vercel-ip-country') || '', 4)}
                    WHERE sid = ${sid}`;
            }

            await tx`
                INSERT INTO bioslide.eventos ${tx(eventos.map(e => ({ sid, t: e.t, tipo: e.tipo, d: tx.json(e.d) })), 'sid', 't', 'tipo', 'd')}`;

            await registrarEtapas(tx, sid, [...etapas], hoje);
        });

        // Limpeza ocasional: sessões e eventos com mais de 7 dias.
        if (Math.random() < 0.01) {
            const limite = agora - DIAS_SESSAO * 86400000;
            await db`DELETE FROM bioslide.eventos WHERE t < ${limite}`;
            await db`DELETE FROM bioslide.sessoes WHERE ultimo < ${limite}`;
        }
    } catch (erro) {
        console.error('[rastro]', erro.message);
    }

    return new Response(null, { status: 204 });
}
