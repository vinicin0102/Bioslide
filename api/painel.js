/**
 * Dados do painel de comportamento (/painel.html).
 *
 * GET /api/painel?de=AAAA-MM-DD&ate=AAAA-MM-DD   funil, ao vivo e sessões recentes
 * GET /api/painel?sessao=<sid>                   linha do tempo de uma sessão
 *
 * Protegido pela senha da variável PAINEL_SENHA (header Authorization: Bearer).
 */
import crypto from 'node:crypto';
import { redisConfigurado, pipeline, paraObjeto, dataBR, PREFIXO } from './_redis.js';

function json(status, dados) {
    return new Response(JSON.stringify(dados), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
}

function senhaConfere(request) {
    const senha = process.env.PAINEL_SENHA || '';
    const enviada = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!senha || !enviada) return false;
    const a = crypto.createHash('sha256').update(senha).digest();
    const b = crypto.createHash('sha256').update(enviada).digest();
    return crypto.timingSafeEqual(a, b);
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function diasEntre(de, ate) {
    const dias = [];
    let atual = new Date(de + 'T12:00:00Z');
    const fim = new Date(ate + 'T12:00:00Z');
    while (atual <= fim && dias.length < 92) {
        dias.push(atual.toISOString().slice(0, 10));
        atual = new Date(atual.getTime() + 86400000);
    }
    return dias;
}

/** Só os campos que o painel usa. */
function resumoSessao(sid, h) {
    return {
        sid,
        inicio: Number(h.inicio || 0), ultimo: Number(h.ultimo || 0),
        secao: h.secao || '', rolagem: Number(h.rolagem || 0), compra: Number(h.compra ?? -1),
        plano: h.plano || '', valor: h.valor || '', pago: h.pago === '1', saiu: h.saiu === '1',
        video: Number(h.video || 0), viuVideo: h.r_video_play === '1', eventos: Number(h.eventos || 0),
        origem: h.origem || '', campanha: h.campanha || '', anuncio: h.anuncio || '', referencia: h.referencia || '',
        dispositivo: h.dispositivo || '', cidade: h.cidade || '', uf: h.uf || '',
    };
}

export async function GET(request) {
    if (!process.env.PAINEL_SENHA) return json(503, { erro: 'Defina a variável PAINEL_SENHA no Vercel e faça Redeploy.' });
    if (!senhaConfere(request)) return json(401, { erro: 'Senha incorreta.' });
    if (!redisConfigurado()) return json(503, { erro: 'Banco não conectado. No Vercel: Storage > Upstash Redis > Connect ao projeto bioslide, e faça Redeploy.' });

    const url = new URL(request.url);
    const agora = Date.now();

    try {
        // Linha do tempo de uma sessão
        const sid = url.searchParams.get('sessao');
        if (sid) {
            if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return json(400, { erro: 'Sessão inválida.' });
            const [h, eventos] = await pipeline([['HGETALL', PREFIXO + 's:' + sid], ['LRANGE', PREFIXO + 'e:' + sid, 0, 399]]);
            const eventosLista = (eventos || []).map(e => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean).reverse();
            return json(200, { sessao: resumoSessao(sid, paraObjeto(h)), eventos: eventosLista, agora });
        }

        const hoje = dataBR(agora);
        const de = DATA.test(url.searchParams.get('de') || '') ? url.searchParams.get('de') : hoje;
        const ate = DATA.test(url.searchParams.get('ate') || '') ? url.searchParams.get('ate') : hoje;
        const dias = diasEntre(de <= ate ? de : ate, de <= ate ? ate : de);

        const [aoVivoIds, ...resto] = await pipeline([
            ['ZRANGEBYSCORE', PREFIXO + 'ult', agora - 45000, '+inf'],
            ...dias.map(d => ['HGETALL', PREFIXO + 'f:' + d]),
            ...dias.map(d => ['ZREVRANGE', PREFIXO + 'd:' + d, 0, 199]),
        ]);

        const funil = {};
        resto.slice(0, dias.length).forEach(h => {
            for (const [etapa, n] of Object.entries(paraObjeto(h))) funil[etapa] = (funil[etapa] || 0) + Number(n);
        });

        const idsPeriodo = [...new Set(resto.slice(dias.length).flat().filter(Boolean))].slice(0, 300);
        const ids = [...new Set([...(aoVivoIds || []).slice(0, 100), ...idsPeriodo])];
        const hashes = await pipeline(ids.map(id => ['HGETALL', PREFIXO + 's:' + id]));
        const sessoes = ids.map((id, i) => resumoSessao(id, paraObjeto(hashes[i]))).filter(s => s.inicio);

        const vivos = new Set(aoVivoIds || []);
        return json(200, {
            agora, de: dias[0], ate: dias[dias.length - 1],
            funil,
            aoVivo: sessoes.filter(s => vivos.has(s.sid) && !s.saiu).sort((a, b) => b.ultimo - a.ultimo),
            recentes: sessoes.filter(s => idsPeriodo.includes(s.sid)).sort((a, b) => b.inicio - a.inicio).slice(0, 200),
        });
    } catch (erro) {
        console.error('[painel]', erro.message);
        return json(502, { erro: 'Não foi possível ler os dados agora.' });
    }
}
