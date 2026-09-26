/**
 * Cliente mínimo da API REST do Upstash Redis (sem dependências).
 *
 * Ao conectar o Upstash Redis ao projeto pelo Vercel (Storage), as variáveis
 * KV_REST_API_URL / KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_URL / _TOKEN)
 * são criadas automaticamente.
 */
export function redisConfigurado() {
    return Boolean(redisUrl() && redisToken());
}

function redisUrl() {
    return (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
}

function redisToken() {
    return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
}

/**
 * Executa vários comandos numa única requisição.
 * @param {Array<Array<string|number>>} comandos
 * @returns {Promise<Array<any>>} resultado de cada comando, na ordem
 */
export async function pipeline(comandos) {
    if (!comandos.length) return [];
    const resposta = await fetch(redisUrl() + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + redisToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify(comandos.map(c => c.map(String))),
        signal: AbortSignal.timeout(8000),
    });
    if (!resposta.ok) throw new Error('Redis HTTP ' + resposta.status);
    const itens = await resposta.json();
    return itens.map(i => (i && 'error' in i ? null : i.result));
}

/** Converte a resposta de HGETALL ([campo, valor, ...]) em objeto. */
export function paraObjeto(lista) {
    const obj = {};
    for (let i = 0; Array.isArray(lista) && i < lista.length; i += 2) obj[lista[i]] = lista[i + 1];
    return obj;
}

/** Data de hoje (ou de um instante) no fuso de Brasília, formato AAAA-MM-DD. */
export function dataBR(ms = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms));
}

export const PREFIXO = 'bs:';
export const DIAS_SESSAO = 7;
