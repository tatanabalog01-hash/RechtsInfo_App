import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const ROOT = process.cwd();
const VERSION_TAG = process.env.LAW_VERSION_TAG || "2026-02-23";
const UNZIPPED_DIR =
  process.env.LAW_XML_DIR ||
  path.join(ROOT, "kb", "laws_xml", "downloads", "2026-02-01", "unzipped");
const STATE_FILE =
  process.env.LAW_BATCH_STATE_FILE ||
  path.join(ROOT, "kb", "_monthly_tmp", `ingest-progress-${VERSION_TAG}.json`);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { versionTag: VERSION_TAG, done: [], startedAt: new Date().toISOString() };
  }
}

async function writeState(state) {
  await ensureDir(path.dirname(STATE_FILE));
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function runNodeScript(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
    });
  });
}

async function getLawDirs() {
  const entries = await fs.readdir(UNZIPPED_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(UNZIPPED_DIR, e.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function main() {
  const lawDirs = await getLawDirs();
  if (!lawDirs.length) {
    throw new Error(`No law directories found in ${UNZIPPED_DIR}`);
  }

  const state = await readState();
  const done = new Set(state.done || []);

  console.log(`Batched ingest start. Version=${VERSION_TAG}`);
  console.log(`Law dirs total: ${lawDirs.length}`);
  console.log(`Already done: ${done.size}`);
  console.log(`State file: ${STATE_FILE}`);

  let processedThisRun = 0;

  for (const dir of lawDirs) {
    const lawKey = path.basename(dir);
    if (done.has(lawKey)) continue;

    const mode = done.size === 0 ? "replace" : "append";
    console.log(`\n=== [${done.size + 1}/${lawDirs.length}] ${lawKey} (${mode}) ===`);

    const env = {
      ...process.env,
      LAW_XML_DIR: dir,
      LAW_VERSION_TAG: VERSION_TAG,
      LAW_INGEST_MODE: mode,
      // Keep source URL if caller provided one, otherwise leave empty.
      LAW_SOURCE_URL: process.env.LAW_SOURCE_URL || "",
    };

    await runNodeScript(path.join(ROOT, "scripts", "ingest-laws.js"), env);

    done.add(lawKey);
    state.done = [...done];
    state.lastCompleted = lawKey;
    state.lastUpdatedAt = new Date().toISOString();
    await writeState(state);
    processedThisRun += 1;
  }

  console.log(`\nBatched ingest completed. Processed this run: ${processedThisRun}`);
  console.log(`Total completed: ${done.size}/${lawDirs.length}`);
}

main().catch((err) => {
  console.error("BATCH_INGEST_FAILED", err?.message || err);
  process.exit(1);
});
