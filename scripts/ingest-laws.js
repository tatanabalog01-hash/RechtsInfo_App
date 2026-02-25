import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const DATABASE_URL = process.env.DATABASE_URL;
const LAW_XML_DIR = process.env.LAW_XML_DIR || path.join(process.cwd(), "kb", "laws_xml");
const CHUNK_MAX_CHARS = Number(process.env.LAW_CHUNK_MAX_CHARS || 1800);
const EMB_BATCH_SIZE = Number(process.env.LAW_EMBED_BATCH_SIZE || 32);
const LAW_VERSION_TAG =
  process.env.LAW_VERSION_TAG || new Date().toISOString().slice(0, 10);
const LAW_SOURCE_URL = process.env.LAW_SOURCE_URL || "";
const LAW_INGEST_MODE = process.env.LAW_INGEST_MODE || "replace"; // replace | append

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function markVersionFailed(versionTag) {
  const c = await pool.connect();
  try {
    await c.query(
      "UPDATE law_dataset_versions SET status = 'failed', imported_at = NOW() WHERE version_tag = $1",
      [versionTag]
    );
  } finally {
    c.release();
  }
}

function textBetween(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? stripTags(m[1]).trim() : "";
}

function allMatches(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(stripTags(m[1]).trim());
  return out.filter(Boolean);
}

function stripTags(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function splitText(text, maxChars) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let idx = rest.lastIndexOf(" ", maxChars);
    if (idx < Math.floor(maxChars * 0.6)) idx = maxChars;
    chunks.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function parseNormBlocks(xml, sourcePath) {
  const normBlocks = xml.match(/<norm\b[\s\S]*?<\/norm>/gi) || [];
  const rows = [];

  for (const block of normBlocks) {
    const law =
      textBetween(block, "jurabk") ||
      textBetween(block, "amtabk") ||
      path.basename(sourcePath, ".xml");
    const section =
      textBetween(block, "enbez") ||
      textBetween(block, "gliederungseinheit") ||
      textBetween(block, "titel");
    const title = textBetween(block, "titel") || textBetween(block, "langue");

    const textParts = [
      ...allMatches(block, "text"),
      ...allMatches(block, "Content"),
      ...allMatches(block, "P"),
      ...allMatches(block, "p"),
    ];
    const mergedText = stripTags(textParts.join("\n")).trim();
    if (!mergedText) continue;

    for (const piece of splitText(mergedText, CHUNK_MAX_CHARS)) {
      rows.push({
        law: law || "UNKNOWN",
        section: section || null,
        title: title || null,
        text: piece,
        source: sourcePath,
      });
    }
  }

  return rows;
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".xml")) {
      out.push(p);
    }
  }
  return out;
}

async function embedBatch(inputs) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: inputs,
    }),
  });
  if (!res.ok) throw new Error(`Embeddings HTTP ${res.status}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

async function insertRows(client, rows, embeddings) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const vector = `[${embeddings[i].join(",")}]`;
    await client.query(
      `
        INSERT INTO law_chunks (version_tag, law, section, title, text, source, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
      `,
      [LAW_VERSION_TAG, r.law, r.section, r.title, r.text, r.source, vector]
    );
  }
}

async function main() {
  const xmlFiles = await walk(LAW_XML_DIR);
  console.log(`XML files found: ${xmlFiles.length}`);
  if (!xmlFiles.length) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
      INSERT INTO law_dataset_versions (version_tag, source_url, status)
      VALUES ($1, $2, 'loading')
      ON CONFLICT (version_tag)
      DO UPDATE SET source_url = EXCLUDED.source_url, status = 'loading', imported_at = NOW()
      `,
      [LAW_VERSION_TAG, LAW_SOURCE_URL || null]
    );

    if (LAW_INGEST_MODE === "replace") {
      await client.query("DELETE FROM law_chunks WHERE version_tag = $1", [LAW_VERSION_TAG]);
    }

    let totalChunks = 0;
    for (const filePath of xmlFiles) {
      const xml = await fs.readFile(filePath, "utf8");
      const rows = parseNormBlocks(xml, filePath);
      if (!rows.length) continue;

      for (let i = 0; i < rows.length; i += EMB_BATCH_SIZE) {
        const batch = rows.slice(i, i + EMB_BATCH_SIZE);
        const embeddings = await embedBatch(batch.map((r) => r.text));
        await insertRows(client, batch, embeddings);
      }

      totalChunks += rows.length;
      console.log(`Ingested ${rows.length} chunks from ${path.basename(filePath)}`);
    }

    await client.query("UPDATE law_dataset_versions SET status = 'archived' WHERE status = 'active' AND version_tag <> $1", [LAW_VERSION_TAG]);
    await client.query("UPDATE law_dataset_versions SET status = 'active' WHERE version_tag = $1", [LAW_VERSION_TAG]);
    await client.query(
      `
      INSERT INTO law_dataset_meta (key, value)
      VALUES ('active_version_tag', $1)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [LAW_VERSION_TAG]
    );
    await client.query("COMMIT");
    console.log(`Done. Total chunks inserted: ${totalChunks}`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    try {
      await markVersionFailed(LAW_VERSION_TAG);
    } catch {}
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("INGEST_FAILED", err.message || err);
  process.exit(1);
});
