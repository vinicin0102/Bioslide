/**
 * Consulta o status de uma cobrança.
 * GET /api/status?transactionId=...  ->  { status, pago, final, confirmado_em, proxima_consulta }
 */
import { config, json, registrarErro, chamarZuckpay, cacheLer, cacheGravar, ID_TRANSACAO } from './_zuckpay.js';

export async function GET(request) {
    const id = new URL(request.url).searchParams.get('transactionId') || '';
    if (!ID_TRANSACAO.test(id)) return json(400, { erro: 'transactionId inválido.' });

    const cache = cacheLer(id);
    if (cache) return json(200, { ...cache, cache: true });

    const cfg = config();
    const { status, corpo } = await chamarZuckpay(cfg, 'GET', '/status?transactionId=' + encodeURIComponent(id));

    // 429 = rate limit da ZuckPay. Pede à página para consultar mais devagar.
    if (status === 429) {
        registrarErro('status', 'rate limit ao consultar ' + id);
        return json(200, { status: 'PENDING', pago: false, final: false, confirmado_em: '', proxima_consulta: 30 });
    }
    if (status !== 200 || corpo.status === undefined) {
        registrarErro('status', `HTTP ${status} para ${id}`);
        return json(502, { erro: 'Não foi possível consultar o pagamento.' });
    }

    const situacao = String(corpo.status).toUpperCase();
    const saida = {
        status: situacao,
        pago: situacao === 'PAID',
        final: ['PAID', 'FAILED', 'REFUSED', 'EXPIRADO', 'REFUNDED'].includes(situacao),
        confirmado_em: String(corpo.confirmed_date ?? ''),
        proxima_consulta: 5,
    };
    cacheGravar(id, saida);
    return json(200, saida);
}
