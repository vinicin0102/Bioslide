/**
 * Checagem rápida da integração: GET /api/saude
 *
 * Diz se as credenciais foram encontradas e se a ZuckPay as aceita, sem
 * mostrar nenhum valor. Faz uma consulta de status com um id inexistente —
 * não cria cobrança.
 */
import { config, json, chamarZuckpay } from './_zuckpay.js';
import { bancoConfigurado, banco } from './_banco.js';

let ultima = null;

export async function GET() {
    if (ultima && Date.now() - ultima.em < 60000) return json(200, { ...ultima.dados, cache: true });

    const cfg = config();
    const dados = {
        client_id: cfg.clientId ? 'encontrado' : 'FALTANDO',
        client_secret: cfg.clientSecret ? 'encontrado' : 'FALTANDO',
        webhook_secret: cfg.webhookSecret ? 'encontrado' : 'não configurado (opcional)',
        webhook_url: cfg.webhookUrl || 'FALTANDO',
        api_base: cfg.apiBase,
    };

    if (cfg.clientId && cfg.clientSecret) {
        const { status, corpo, destino } = await chamarZuckpay(cfg, 'GET', '/status?transactionId=TESTE-SAUDE-000');
        dados.zuckpay_http = status;
        // Mensagem da ZuckPay (sem dados sensíveis: é uma consulta de id inexistente).
        dados.zuckpay_mensagem = String(corpo.message ?? corpo.mensagem ?? corpo.error ?? corpo.erro ?? '').slice(0, 200);
        dados.diagnostico =
            status === 0 ? 'FALHA DE CONEXÃO com a ZuckPay' :
            status >= 300 && status < 400 ? `REDIRECIONAMENTO — ajuste ZUCKPAY_API_BASE para o host de ${destino}` :
            status === 401 ? 'NÃO AUTORIZADO — client_id/client_secret errados ou sem permissão' :
            status === 403 ? 'BLOQUEADO — a ZuckPay recusou o IP do servidor (IP whitelist)' :
            status === 429 ? 'RATE LIMIT — aguarde alguns minutos' :
            status === 200 || status === 404 || status === 400 || status === 422 ? 'OK — credenciais aceitas pela ZuckPay' :
            `resposta inesperada (HTTP ${status})`;
    } else {
        dados.diagnostico = 'Credenciais não encontradas nas variáveis de ambiente';
    }

    // Banco do painel: conecta, cria as tabelas se faltarem e conta as visitas de hoje.
    dados.painel_senha = process.env.PAINEL_SENHA ? 'definida' : 'FALTANDO';
    if (!bancoConfigurado()) {
        dados.banco = 'FALTANDO — conecte o Supabase ao projeto (cria a POSTGRES_URL)';
    } else {
        try {
            const db = await banco();
            const [linha] = await db`SELECT COUNT(*)::int AS n FROM bioslide.sessoes WHERE ultimo > ${Date.now() - 86400000}`;
            dados.banco = `OK — ${linha.n} visitas registradas nas últimas 24h`;
        } catch (erro) {
            dados.banco = 'ERRO — ' + String(erro.message).slice(0, 160);
        }
    }

    ultima = { em: Date.now(), dados };
    return json(200, dados);
}
