/**
 * Dados do painel de comportamento (/painel.html).
 *
 * GET /api/painel?de=AAAA-MM-DD&ate=AAAA-MM-DD   funil, ao vivo e sessões recentes
 * GET /api/painel?sessao=<sid>                   linha do tempo de uma sessão
 *
 * Protegido pela senha da variável PAINEL_SENHA (header Authorization: Bearer).
 */
import { bancoConfigurado, banco, dataBR } from './_banco.js';
import { senhaConfere } from './_senha.js';

function json(status, dados) {
    return new Response(JSON.stringify(dados), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Só os campos que o painel usa. */
function resumoSessao(h) {
    return {
        sid: h.sid,
        inicio: Number(h.inicio || 0), ultimo: Number(h.ultimo || 0),
        secao: h.secao || '', rolagem: Number(h.rolagem || 0), compra: Number(h.compra ?? -1),
        plano: h.plano || '', valor: h.valor ?? '', pago: Boolean(h.pago), saiu: Boolean(h.saiu),
        video: Number(h.video || 0), viuVideo: (h.etapas || []).includes('video_play'), eventos: Number(h.eventos || 0),
        origem: h.origem || '', campanha: h.campanha || '', anuncio: h.anuncio || '', referencia: h.referencia || '',
        dispositivo: h.dispositivo || '', cidade: h.cidade || '', uf: h.uf || '',
        gravacao: Boolean(h.gravacao),
    };
}

export async function GET(request) {
    if (!process.env.PAINEL_SENHA) return json(503, { erro: 'Defina a variável PAINEL_SENHA no Vercel e faça Redeploy.' });
    if (!senhaConfere(request)) return json(401, { erro: 'Senha incorreta.' });
    if (!bancoConfigurado()) return json(503, { erro: 'Banco não conectado. No Vercel: Storage > Supabase > Connect ao projeto bioslide, e faça Redeploy.' });

    const url = new URL(request.url);
    const agora = Date.now();

    try {
        const db = await banco();

        // Linha do tempo de uma sessão
        const sid = url.searchParams.get('sessao');
        if (sid) {
            if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return json(400, { erro: 'Sessão inválida.' });
            const [sessao] = await db`SELECT * FROM bioslide.sessoes WHERE sid = ${sid}`;
            if (!sessao) return json(404, { erro: 'Sessão não encontrada.' });
            const eventos = await db`SELECT t, tipo, d FROM bioslide.eventos WHERE sid = ${sid} ORDER BY t, id LIMIT 400`;
            return json(200, { sessao: resumoSessao(sessao), eventos: eventos.map(e => ({ t: Number(e.t), tipo: e.tipo, d: e.d })), agora });
        }

        const hoje = dataBR(agora);
        let de = DATA.test(url.searchParams.get('de') || '') ? url.searchParams.get('de') : hoje;
        let ate = DATA.test(url.searchParams.get('ate') || '') ? url.searchParams.get('ate') : hoje;
        if (de > ate) [de, ate] = [ate, de];

        const [funilLinhas, aoVivo, recentes] = await Promise.all([
            db`SELECT etapa, SUM(n)::int AS n FROM bioslide.funil WHERE dia BETWEEN ${de} AND ${ate} GROUP BY etapa`,
            db`SELECT * FROM bioslide.sessoes WHERE ultimo > ${agora - 45000} AND NOT saiu ORDER BY ultimo DESC LIMIT 100`,
            db`SELECT * FROM bioslide.sessoes WHERE dia BETWEEN ${de} AND ${ate} ORDER BY inicio DESC LIMIT 200`,
        ]);

        return json(200, {
            agora, de, ate,
            funil: Object.fromEntries(funilLinhas.map(l => [l.etapa, l.n])),
            aoVivo: aoVivo.map(resumoSessao),
            recentes: recentes.map(resumoSessao),
        });
    } catch (erro) {
        console.error('[painel]', erro.message);
        return json(502, { erro: 'Não foi possível ler os dados agora.' });
    }
}
