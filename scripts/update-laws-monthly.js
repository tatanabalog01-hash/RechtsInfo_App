import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { spawn } from "child_process";
import { Pool } from "pg";
import tar from "tar";
import unzipper from "unzipper";

const HARVEST_URL = process.env.LAW_HARVEST_URL || "https://harvest.deutsche-bundesgesetze.de/";
const TMP_DIR = process.env.LAW_TMP_DIR || path.join(process.cwd(), "kb", "_monthly_tmp");
const ARCHIVE_DIR = process.env.LAW_ARCHIVE_DIR || path.join(TMP_DIR, "archives");
const LAW_STAGING_ROOT = process.env.LAW_STAGING_ROOT || path.join(process.cwd(), "kb", "laws_xml", "downloads");
const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

function run(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false, env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function uniq(arr) {
  return [...new Set(arr)];
}

async function getEmbedding(input) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: String(input || "").slice(0, 8000),
    }),
  });
  if (!res.ok) throw new Error(`Embeddings HTTP ${res.status}`);
  const json = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("Embedding missing");
  return embedding;
}

async function detectLawChunkVectorDim(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(
      (regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\\((\\d+)\\)'))[1],
      '1536'
    ) AS dim
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'law_chunks'
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
    LIMIT 1
  `);
  return Number(rows[0]?.dim || 1536);
}

async function ensureLawCatalogTable(client) {
  const vectorDim = await detectLawChunkVectorDim(client);
  await client.query(`
    CREATE TABLE IF NOT EXISTS law_catalog (
      law_code TEXT PRIMARY KEY,
      title_de TEXT,
      title_ru TEXT,
      keywords TEXT,
      embedding VECTOR(${vectorDim}),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS law_catalog_embedding_idx
      ON law_catalog USING ivfflat (embedding vector_cosine_ops)
  `);
  return vectorDim;
}

async function rebuildLawCatalog({ client, activeVersionTag }) {
  const vectorDim = await ensureLawCatalogTable(client);
  const laws = await client.query(
    `
      SELECT
        law AS law_code,
        MAX(COALESCE(title, '')) AS title_de,
        ''::text AS title_ru
      FROM law_chunks
      WHERE version_tag = $1
        AND law IS NOT NULL
        AND btrim(law) <> ''
      GROUP BY law
      ORDER BY law
    `,
    [activeVersionTag]
  );

  console.log(`Rebuilding law_catalog for version ${activeVersionTag}: ${laws.rows.length} laws, VECTOR(${vectorDim})`);

  for (const row of laws.rows) {
    const lawCode = String(row.law_code || "").trim();
    if (!lawCode) continue;

    const textForEmbed = [lawCode, row.title_de || "", row.title_ru || ""].join(" | ");
    const embedding = await getEmbedding(textForEmbed);
    const vector = `[${embedding.join(",")}]`;

    await client.query(
      `
        INSERT INTO law_catalog (law_code, title_de, title_ru, keywords, embedding, updated_at)
        VALUES ($1, $2, $3, $4, $5::vector, now())
        ON CONFLICT (law_code)
        DO UPDATE SET
          title_de = EXCLUDED.title_de,
          title_ru = EXCLUDED.title_ru,
          keywords = EXCLUDED.keywords,
          embedding = EXCLUDED.embedding,
          updated_at = now()
      `,
      [lawCode, row.title_de || "", row.title_ru || "", null, vector]
    );
  }
}

const MONTHS = {
  // ru
  "января": "01", "февраля": "02", "марта": "03", "апреля": "04", "мая": "05", "июня": "06",
  "июля": "07", "августа": "08", "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
  // de
  "januar": "01", "februar": "02", "märz": "03", "maerz": "03", "april": "04", "mai": "05", "juni": "06",
  "juli": "07", "august": "08", "september": "09", "oktober": "10", "november": "11", "dezember": "12",
};

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseDateFromText(text = "") {
  const clean = stripHtml(text).toLowerCase();
  const m = clean.match(/\b(\d{1,2})\s+([a-zа-яёä]+)\s+(20\d{2})\b/i);
  if (!m) return null;
  const day = String(Number(m[1])).padStart(2, "0");
  const month = MONTHS[m[2]];
  const year = m[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

function parseLinksFromHtml(html, baseUrl) {
  const anchors = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: stripHtml(m[2]) }))
    .filter((a) => /\.tgz(\?.*)?$/i.test(a.href))
    .map((a) => ({
      url: a.href.startsWith("http") ? a.href : new URL(a.href, baseUrl).toString(),
      linkText: a.text,
      dateFromText: parseDateFromText(a.text),
    }));

  // fallback if page markup is weird and anchor parsing missed links
  if (!anchors.length) {
    const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    return uniq(
      hrefs
        .filter((h) => /\.tgz(\?.*)?$/i.test(h))
        .map((h) => ({
          url: h.startsWith("http") ? h : new URL(h, baseUrl).toString(),
          linkText: "",
          dateFromText: null,
        }))
    );
  }

  const byUrl = new Map();
  for (const a of anchors) {
    if (!byUrl.has(a.url)) byUrl.set(a.url, a);
  }
  return [...byUrl.values()];
}

function deriveVersionTag(url) {
  const file = path.basename(new URL(url).pathname);
  const m = file.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ym = file.match(/(20\d{2})[-_]?(\d{2})/);
  if (ym) return `${ym[1]}-${ym[2]}-01`;
  return new Date().toISOString().slice(0, 10);
}

async function findLatestArchive() {
  const res = await fetch(HARVEST_URL);
  if (!res.ok) throw new Error(`Harvest HTTP ${res.status}`);
  const html = await res.text();
  const links = parseLinksFromHtml(html, HARVEST_URL);
  if (!links.length) throw new Error("No .tgz links found");

  const withVersion = links.map((item) => ({
    url: item.url,
    versionTag: item.dateFromText || deriveVersionTag(item.url),
    linkText: item.linkText || "",
  }));
  withVersion.sort((a, b) => a.versionTag.localeCompare(b.versionTag));
  return withVersion[withVersion.length - 1];
}

async function cleanDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function walkFiles(dir, ext) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p, ext)));
    else if (e.isFile() && p.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

async function getCurrentActiveVersion(client) {
  const { rows } = await client.query(
    "SELECT value FROM law_dataset_meta WHERE key = 'active_version_tag' LIMIT 1"
  );
  return rows[0]?.value || null;
}

async function pruneOldVersions(client, keepVersionTag) {
  const { rows } = await client.query(
    "SELECT version_tag FROM law_dataset_versions WHERE version_tag <> $1",
    [keepVersionTag]
  );
  for (const r of rows) {
    await client.query("DELETE FROM law_chunks WHERE version_tag = $1", [r.version_tag]);
    await client.query(
      "UPDATE law_dataset_versions SET status = 'archived' WHERE version_tag = $1",
      [r.version_tag]
    );
  }
}

async function extractZipArchive(zipPath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  try {
    await fsSync
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
    return;
  } catch {}
  try {
    // Linux/Render
    await run("unzip", ["-o", zipPath, "-d", destDir]);
    return;
  } catch {}
  // Fallback (works on many Windows setups with bsdtar)
  await run("tar", ["-xf", zipPath, "-C", destDir]);
}

async function extractTgzArchive(tgzPath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  try {
    await tar.x({
      file: tgzPath,
      cwd: destDir,
      gzip: true,
    });
    return;
  } catch {}
  await run("tar", ["-xzf", tgzPath, "-C", destDir]);
}

async function expandInnerZips(versionRoot) {
  const unzippedRoot = path.join(versionRoot, "unzipped");
  await cleanDir(unzippedRoot);

  const zipFiles = await walkFiles(versionRoot, ".zip");
  for (const zipFile of zipFiles) {
    if (zipFile.includes(`${path.sep}unzipped${path.sep}`)) continue;
    const rel = path.relative(versionRoot, zipFile);
    const relDir = path.dirname(rel);
    const zipBase = path.basename(zipFile, ".zip");
    const targetDir = path.join(unzippedRoot, relDir, zipBase);
    await extractZipArchive(zipFile, targetDir);
  }
  return unzippedRoot;
}

async function main() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  await fs.mkdir(LAW_STAGING_ROOT, { recursive: true });

  const latest = await findLatestArchive();
  console.log(`Latest archive: ${latest.url}`);
  console.log(`Version tag: ${latest.versionTag}`);

  const client = await pool.connect();
  try {
    const currentVersion = await getCurrentActiveVersion(client);
    if (currentVersion === latest.versionTag) {
      console.log(`Already up to date (${currentVersion})`);
      return;
    }
  } finally {
    client.release();
  }

  const archivePath = path.join(ARCHIVE_DIR, path.basename(new URL(latest.url).pathname));
  await downloadFile(latest.url, archivePath);
  console.log(`Downloaded: ${archivePath}`);

  // TGZ contains nested structure like downloads/YYYY-MM-DD/*.zip
  const lawsRoot = path.join(process.cwd(), "kb", "laws_xml");
  await fs.mkdir(lawsRoot, { recursive: true });
  await extractTgzArchive(archivePath, lawsRoot);

  const versionRoot = path.join(LAW_STAGING_ROOT, latest.versionTag);
  const unzippedDir = await expandInnerZips(versionRoot);
  console.log(`Inner ZIPs extracted to: ${unzippedDir}`);

  const ingestEnv = {
    ...process.env,
    LAW_XML_DIR: unzippedDir,
    LAW_VERSION_TAG: latest.versionTag,
    LAW_SOURCE_URL: latest.url,
    LAW_INGEST_MODE: "replace",
  };
  await run(process.execPath, [path.join(process.cwd(), "scripts", "ingest-laws.js")], ingestEnv);

  const c2 = await pool.connect();
  try {
    await rebuildLawCatalog({ client: c2, activeVersionTag: latest.versionTag });
    console.log("law_catalog rebuilt");
    await pruneOldVersions(c2, latest.versionTag);
    console.log("Old versions pruned");
  } finally {
    c2.release();
  }

  console.log("Monthly law update completed");
}

main()
  .catch((err) => {
    console.error("LAWS_UPDATE_FAILED", err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
