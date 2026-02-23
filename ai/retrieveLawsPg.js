// ai/retrieveLawsPg.js (ESM)
import { Pool } from "pg";
import OpenAI from "openai";

function truncate(str, max = 1200) {
  if (!str) return "";
  const s = String(str).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function getActiveVersionTag(pool) {
  const q = `
    SELECT version_tag
    FROM law_dataset_versions
    WHERE status = 'active'
    ORDER BY imported_at DESC
    LIMIT 1
  `;
  try {
    const r = await pool.query(q);
    if (r.rows?.[0]?.version_tag) return r.rows[0].version_tag;
  } catch {
    // fallback below
  }
  return "legacy";
}

function vectorToSqlLiteral(arr) {
  return `[${arr.join(",")}]`;
}

/**
 * Postgres + pgvector retriever for law chunks.
 * Requires DATABASE_URL and OPENAI_API_KEY.
 */
function createLawRetrieverPg() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Нет DATABASE_URL в .env");
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("Нет OPENAI_API_KEY в .env");
  }

  const embedModel =
    process.env.OPENAI_EMBED_MODEL ||
    process.env.OPENAI_EMBEDDING_MODEL ||
    "text-embedding-3-small";

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  const openai = new OpenAI({ apiKey: openaiKey });

  return async function retrieveLaws(query, { topK = 5, maxChunkChars = 900 } = {}) {
    const q = String(query || "").trim();
    if (!q) return "";

    const emb = await openai.embeddings.create({
      model: embedModel,
      input: q,
    });

    const vec = emb.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== 1536) {
      throw new Error(
        `Embedding не 1536 dims. Получено: ${Array.isArray(vec) ? vec.length : typeof vec}`
      );
    }

    const versionTag = await getActiveVersionTag(pool);

    const sql = `
      SELECT law, section, title, text, source
      FROM law_chunks
      WHERE version_tag = $2
      ORDER BY embedding <-> $1::vector
      LIMIT $3
    `;

    const vectorLiteral = vectorToSqlLiteral(vec);
    const res = await pool.query(sql, [vectorLiteral, versionTag, topK]);
    if (!res.rows?.length) return "";

    const blocks = res.rows.map((r, i) => {
      const headerParts = [
        r.law ? `LAW: ${r.law}` : null,
        r.section ? `SECTION: ${r.section}` : null,
        r.title ? `TITLE: ${r.title}` : null,
        r.source ? `SOURCE: ${r.source}` : null,
      ].filter(Boolean);

      const header = headerParts.join(" | ");
      const body = truncate(r.text, maxChunkChars);
      return `[#${i + 1}] ${header}\nTEXT:\n${body}`;
    });

    return blocks.join("\n\n---\n\n");
  };
}

export { createLawRetrieverPg };
