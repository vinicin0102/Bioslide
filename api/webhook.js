/**
 * Recebe as notificações da ZuckPay (urlnoty da cobrança).
 *
 * 1. Assinatura HMAC (X-ZuckPay-Signature), quando há webhook secret: prova
 *    que o POST veio da ZuckPay.
 * 2. Reconsulta do status na API: prova que está pago agora. O corpo do POST
 *    nunca é a fonte da verdade.
 */
import { config, json, registrarErro, chamarZuckpay, assinaturaWebhookValida, itensDoPedido, ID_TRANSACAO } from './_zuckpay.js';
import { redisConfigurado, pipeline, dataBR, PREFIXO } from './_redis.js';

/**
 * Marca a venda na sessão do painel (via pedido -> sessão gravado quando o
 * PIX foi gerado), mesmo que o comprador tenha fechado a página.
 */
async function marcarPagoNoPainel(externalId, valor) {
    const m = /^BS-[a-z]+-[a-z0-9]+-(.+)$/.exec(externalId);
    if (!m || !redisConfigurado()) return;
    try {
        const [sid] = await pipeline([['GET', PREFIXO + 'p:' + m[1]]]);
        if (!sid) return;
        const s = PREFIXO + 's:' + sid;
        const agora = Date.now();
        const [novo] = await pipeline([
            ['HSETNX', s, 'r_pago', 1],
            ['HSET', s, 'pago', 1, 'compra', 5],
            ['LPUSH', PREFIXO + 'e:' + sid, JSON.stringify({ t: agora, tipo: 'pago', d: { confirmado: 'webhook', valor } })],
        ]);
        if (Number(novo) === 1) await pipeline([['HINCRBY', PREFIXO + 'f:' + dataBR(agora), 'pago', 1]]);
    } catch (erro) {
        registrarErro('webhook', 'painel: ' + erro.message);
    }
}

const processadas = new Set(); // melhor esforço, por instância

export async function POST(request) {
    const cfg = config();
    // O HMAC é calculado sobre os bytes exatos que chegaram.
    const corpoRaw = await request.text();

    if (cfg.webhookSecret) {
        const [valida, motivo] = assinaturaWebhookValida(request.headers.get('x-zuckpay-signature') || '', corpoRaw, cfg.webhookSecret);
        if (!valida) {
            registrarErro('webhook', 'assinatura recusada: ' + motivo);
            return json(401, { erro: 'Assinatura inválida.' });
        }
    }

    let corpo = {};
    try { corpo = JSON.parse(corpoRaw); } catch { /* tratado abaixo */ }
    if (!corpo || typeof corpo !== 'object') corpo = {};

    // Pagamento: { event, transaction: { id, ... } } — SPEI: { transactionId, ... }
    const transacao = corpo.transaction && typeof corpo.transaction === 'object' ? corpo.transaction : {};
    const id = String(transacao.id ?? corpo.transactionId ?? corpo.transaction_id ?? '');
    const evento = String(corpo.event ?? '');

    if (!ID_TRANSACAO.test(id)) {
        registrarErro('webhook', 'id ausente no payload: ' + corpoRaw.slice(0, 300));
        return json(400, { erro: 'transactionId ausente ou inválido.' });
    }

    // Eventos que não exigem entrega: responde sem gastar chamada de API.
    if (['payment_refused', 'payment_pending', 'checkout_abandoned'].includes(evento)) {
        return json(200, { ok: true, ignorado: evento });
    }

    const { status, corpo: resposta } = await chamarZuckpay(cfg, 'GET', '/status?transactionId=' + encodeURIComponent(id));
    if (status !== 200 || resposta.status === undefined) {
        registrarErro('webhook', `falha ao verificar ${id} (HTTP ${status})`);
        return json(502, { erro: 'Não foi possível verificar a transação.' });
    }
    if (String(resposta.status).toUpperCase() !== 'PAID') {
        return json(200, { ok: true, ignorado: 'nao_pago' });
    }

    const duplicado = processadas.has(id);
    if (!duplicado) {
        processadas.add(id);
        const externalId = String(transacao.external_id_client ?? corpo.external_id_client ?? '');
        const itens = itensDoPedido(externalId);

        // Registro da venda nos logs do Vercel (Deployments > Logs).
        console.log('[venda]', JSON.stringify({
            transactionId: id,
            evento,
            external_id_client: externalId,
            plano: itens.plano,
            bumps: itens.bumps,
            nome: transacao.nome ?? null,
            email: transacao.email ?? resposta.email ?? null,
            valor: resposta.amount ?? transacao.amount ?? null,
            confirmado_em: resposta.confirmed_date ?? transacao.confirmed_date ?? null,
        }));

        await marcarPagoNoPainel(externalId, Number(resposta.amount ?? transacao.amount ?? 0) || 0);

        /*
         * TODO — entrega do produto (e-mail com o link / área de membros).
         * itens.plano ("slides" ou "biobox") e itens.bumps dizem o que foi pago.
         * A ZuckPay reenvia notificações e cada instância tem memória própria:
         * para garantir entrega única, grave o transactionId num banco.
         */
    }

    return json(200, { ok: true, duplicado });
}
