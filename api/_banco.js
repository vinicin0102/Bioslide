/**
 * Banco do painel: Postgres (Supabase conectado pelo Vercel).
 *
 * Usa POSTGRES_URL, criada pela integração. As tabelas ficam no schema
 * "bioslide", que a API pública do Supabase não expõe, e são criadas sozinhas
 * no primeiro uso.
 */
import postgres from 'postgres';

const URL_BANCO = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

export function bancoConfigurado() {
    return Boolean(URL_BANCO);
}

let conexao = null;
let preparado = null;

function sql() {
    if (!conexao) {
        // Parâmetros extras da URL (ex.: "supa=") iriam para o servidor como
        // opções de conexão e seriam recusados: o SSL é configurado aqui.
        const url = new URL(URL_BANCO);
        url.search = '';
        conexao = postgres(url.toString(), {
            ssl: /localhost|127\.0\.0\.1/.test(url.hostname) ? false : 'require',
            prepare: false,          // pooler do Supabase (modo transação)
            max: 1,
            idle_timeout: 20,
            connect_timeout: 10,
            onnotice: () => {},
        });
    }
    return conexao;
}

/** Cria o schema e as tabelas uma vez por instância. */
export async function banco() {
    const db = sql();
    if (!preparado) {
        preparado = db.unsafe(`
            CREATE SCHEMA IF NOT EXISTS bioslide;
            CREATE TABLE IF NOT EXISTS bioslide.sessoes (
                sid         text PRIMARY KEY,
                vid         text NOT NULL DEFAULT '',
                dia         date NOT NULL,
                inicio      bigint NOT NULL,
                ultimo      bigint NOT NULL,
                secao       text NOT NULL DEFAULT '',
                rolagem     int  NOT NULL DEFAULT 0,
                compra      int  NOT NULL DEFAULT -1,
                plano       text NOT NULL DEFAULT '',
                valor       numeric,
                pedido      text,
                pago        boolean NOT NULL DEFAULT false,
                saiu        boolean NOT NULL DEFAULT false,
                video       int  NOT NULL DEFAULT 0,
                eventos     int  NOT NULL DEFAULT 0,
                etapas      text[] NOT NULL DEFAULT '{}',
                origem      text NOT NULL DEFAULT '',
                campanha    text NOT NULL DEFAULT '',
                anuncio     text NOT NULL DEFAULT '',
                meio        text NOT NULL DEFAULT '',
                referencia  text NOT NULL DEFAULT '',
                dispositivo text NOT NULL DEFAULT '',
                largura     int,
                cidade      text NOT NULL DEFAULT '',
                uf          text NOT NULL DEFAULT '',
                pais        text NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS sessoes_ultimo ON bioslide.sessoes (ultimo DESC);
            CREATE INDEX IF NOT EXISTS sessoes_dia    ON bioslide.sessoes (dia, inicio DESC);
            CREATE INDEX IF NOT EXISTS sessoes_pedido ON bioslide.sessoes (pedido);
            CREATE TABLE IF NOT EXISTS bioslide.eventos (
                id   bigserial PRIMARY KEY,
                sid  text   NOT NULL,
                t    bigint NOT NULL,
                tipo text   NOT NULL,
                d    jsonb  NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS eventos_sid ON bioslide.eventos (sid, t);
            CREATE TABLE IF NOT EXISTS bioslide.funil (
                dia   date NOT NULL,
                etapa text NOT NULL,
                n     int  NOT NULL DEFAULT 0,
                PRIMARY KEY (dia, etapa)
            );
            ALTER TABLE bioslide.sessoes ENABLE ROW LEVEL SECURITY;
            ALTER TABLE bioslide.eventos ENABLE ROW LEVEL SECURITY;
            ALTER TABLE bioslide.funil   ENABLE ROW LEVEL SECURITY;
        `).catch(erro => { preparado = null; throw erro; });
    }
    await preparado;
    return db;
}

/** Data de hoje (ou de um instante) no fuso de Brasília, formato AAAA-MM-DD. */
export function dataBR(ms = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms));
}

export const DIAS_SESSAO = 7;

/**
 * Marca etapas novas da sessão e soma no funil do dia — cada etapa conta
 * uma única vez por sessão, mesmo com envios repetidos ou simultâneos.
 */
export async function registrarEtapas(tx, sid, etapas, dia) {
    if (!etapas.length) return;
    const novas = await tx`
        WITH atual AS (SELECT etapas FROM bioslide.sessoes WHERE sid = ${sid} FOR UPDATE),
             novas AS (SELECT DISTINCT e FROM unnest(${etapas}::text[]) AS e, atual WHERE NOT (e = ANY (atual.etapas)))
        UPDATE bioslide.sessoes s SET etapas = s.etapas || ARRAY(SELECT e FROM novas)
        WHERE s.sid = ${sid}
        RETURNING ARRAY(SELECT e FROM novas) AS novas`;
    const lista = novas[0]?.novas || [];
    if (!lista.length) return;
    await tx`
        INSERT INTO bioslide.funil (dia, etapa, n)
        SELECT ${dia}::date, e, 1 FROM unnest(${lista}::text[]) AS e
        ON CONFLICT (dia, etapa) DO UPDATE SET n = bioslide.funil.n + 1`;
}
