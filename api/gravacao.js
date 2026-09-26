/**
 * Gravação de tela das visitas (rrweb).
 *
 * POST /api/gravacao?sid=<sid>&seq=<n>&z=<1|0>   pedaço da gravação (página de vendas)
 *      corpo: JSON de eventos do rrweb, compactado em gzip quando z=1.
 * GET  /api/gravacao?sid=<sid>&apos=<seq>        pedaços a partir de um número (painel, com senha)
 *
 * Os campos do formulário são mascarados no navegador antes de sair — nome,
 * CPF, e-mail e telefone nunca chegam aqui.
 */
import { bancoConfigurado, banco, DIAS_GRAVACAO } from './_banco.js';
import { senhaConfere } from './_senha.js';

const ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PEDACO = 900 * 1024;          // por envio
const MAX_SESSAO = 8 * 1024 * 1024;     // por visita
const MAX_RESPOSTA = 2.5 * 1024 * 1024; // por leitura do painel (limite do Vercel é 4,5 MB)

function json(status, dados) {
    return new Response(JSON.stringify(dados), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
}

export async function POST(request) {
    if (!bancoConfigurado()) return new Response(null, { status: 204 });

    const url = new URL(request.url);
    const sid = url.searchParams.get('sid') || '';
    const seq = Number(url.searchParams.get('seq'));
    const gzip = url.searchParams.get('z') === '1';
    if (!ID.test(sid) || !Number.isInteger(seq) || seq < 0 || seq > 20000) return new Response(null, { status: 400 });

    const dados = Buffer.from(await request.arrayBuffer());
    if (!dados.length || dados.length > MAX_PEDACO) return new Response(null, { status: 413 });
    // gzip começa com 1f 8b; JSON de eventos começa com "[".
    if (gzip ? !(dados[0] === 0x1f && dados[1] === 0x8b) : dados[0] !== 0x5b) return new Response(null, { status: 400 });

    try {
        const db = await banco();
        const [total] = await db`SELECT COALESCE(SUM(tamanho), 0)::int AS bytes FROM bioslide.gravacoes WHERE sid = ${sid}`;
        if (total.bytes + dados.length > MAX_SESSAO) return new Response(null, { status: 413 });

        const agora = Date.now();
        await db`
            INSERT INTO bioslide.gravacoes (sid, seq, t, gzip, tamanho, dados)
            VALUES (${sid}, ${seq}, ${agora}, ${gzip}, ${dados.length}, ${dados})
            ON CONFLICT (sid, seq) DO NOTHING`;
        await db`UPDATE bioslide.sessoes SET gravacao = true WHERE sid = ${sid} AND NOT gravacao`;

        if (Math.random() < 0.02) {
            await db`DELETE FROM bioslide.gravacoes WHERE t < ${agora - DIAS_GRAVACAO * 86400000}`;
        }
    } catch (erro) {
        console.error('[gravacao]', erro.message);
    }
    return new Response(null, { status: 204 });
}

export async function GET(request) {
    if (!senhaConfere(request)) return json(401, { erro: 'Senha incorreta.' });
    if (!bancoConfigurado()) return json(503, { erro: 'Banco não conectado.' });

    const url = new URL(request.url);
    const sid = url.searchParams.get('sid') || '';
    const apos = Number(url.searchParams.get('apos') ?? -1);
    if (!ID.test(sid) || !Number.isInteger(apos)) return json(400, { erro: 'Parâmetros inválidos.' });

    try {
        const db = await banco();
        const linhas = await db`
            SELECT seq, gzip, tamanho, dados FROM bioslide.gravacoes
            WHERE sid = ${sid} AND seq > ${apos} ORDER BY seq LIMIT 400`;

        const partes = [];
        let bytes = 0;
        for (const l of linhas) {
            if (partes.length && bytes + l.tamanho > MAX_RESPOSTA) break;
            bytes += l.tamanho;
            partes.push({ seq: l.seq, gzip: l.gzip, b64: Buffer.from(l.dados).toString('base64') });
        }
        const [sessao] = await db`SELECT ultimo, saiu FROM bioslide.sessoes WHERE sid = ${sid}`;
        return json(200, {
            partes,
            mais: partes.length < linhas.length,
            ultimo: Number(sessao?.ultimo || 0),
            aoVivo: sessao ? !sessao.saiu && Date.now() - Number(sessao.ultimo) < 45000 : false,
        });
    } catch (erro) {
        console.error('[gravacao]', erro.message);
        return json(502, { erro: 'Não foi possível ler a gravação.' });
    }
}
