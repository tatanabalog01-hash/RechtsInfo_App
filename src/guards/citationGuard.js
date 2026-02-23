// src/guards/citationGuard.js  (ESM)

const NORM_REGEX =
  /(?:§\s*\d+[a-zA-Z]*|Art\.\s*\d+[a-zA-Z]*)\s*(?:(?:Abs\.|Absatz)\s*\d+[a-zA-Z]*\s*)?(?:(?:Satz)\s*\d+\s*)?(?:(?:Nr\.|Nummer)\s*\d+\s*)?(?:(?:lit\.?)\s*[a-z]\s*)?(?:(?:Buchst\.|Buchstabe)\s*[a-z]\s*)?(?:[A-Za-zÄÖÜäöü]{2,}(?:\s*(?:[IVX]{1,4}|[0-9]{1,3}))?)?\b/g;

function normalizeNorm(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/§\s*/g, "§ ")
    .replace(/Art\.\s*/g, "Art. ")
    .replace(/Abs\.\s*/g, "Abs. ")
    .replace(/Nr\.\s*/g, "Nr. ")
    .replace(/Satz\s*/g, "Satz ")
    .replace(/lit\.\s*/g, "lit. ")
    .replace(/Buchst\.\s*/g, "Buchst. ")
    .trim();
}

function extractNorms(text) {
  if (!text) return [];
  const matches = text.match(NORM_REGEX) || [];
  const out = new Set();
  for (const m of matches) out.add(normalizeNorm(m));
  return [...out];
}

/**
 * Build allowlist from retrieved sources.
 * sources format expected:
 * [
 *   { id: "S1", title: "...", text: "...", ... }
 * ]
 */
export function buildNormAllowlist(sources, { maxNorms = 80 } = {}) {
  const allowed = new Set();
  const normToSourceIds = new Map();

  for (const src of sources || []) {
    const srcId = src?.id || src?.source_id || src?.sourceId;
    const text = [
      src?.section && src?.law ? `${src.section} ${src.law}` : "",
      src?.section || "",
      src?.title || "",
      src?.text || src?.content || "",
      src?.law || "",
    ]
      .filter(Boolean)
      .join("\n");
    const lawCode =
      src?.law_code ||
      src?.meta?.law_code ||
      src?.meta?.lawCode ||
      src?.meta?.law_short ||
      src?.meta?.short ||
      null;
    const norms = extractNorms(text);

    for (const norm of norms) {
      allowed.add(norm);
      if (!normToSourceIds.has(norm)) normToSourceIds.set(norm, new Set());
      if (srcId) normToSourceIds.get(norm).add(srcId);
    }
  }

  // cap to avoid prompt bloat (keep deterministic order)
  const allowedArr = [...allowed].sort((a, b) => a.localeCompare(b, "de"));
  const capped = allowedArr.slice(0, maxNorms);

  const cappedSet = new Set(capped);
  const cappedMap = new Map();
  for (const norm of capped) {
    cappedMap.set(norm, [...(normToSourceIds.get(norm) || [])].sort());
  }

  return {
    allowedNorms: cappedSet,
    normToSourceIds: cappedMap,
    allowedNormsText: capped.join("\n"),
    normSourcesText: capped
      .map((n) => `${n} -> ${(cappedMap.get(n) || []).join(", ")}`)
      .join("\n"),
  };
}

/**
 * If model outputs a shorter/looser norm like "§ 823 BGB" while allowlist has
 * "§ 823 Abs. 1 BGB", we DO NOT accept the loose norm.
 * We either:
 *  - replace with a canonical allowed norm that starts with same "§ 823" and same law code, OR
 *  - mark as unverified.
 */
function resolveToAllowedNorm(norm, allowedNorms) {
  const n = normalizeNorm(norm);

  if (allowedNorms.has(n)) return { ok: true, norm: n };

  // Try to upgrade loose norm -> canonical norm from allowlist
  // Heuristic: same leading token (§ number / Art. number) + same trailing law code (last token)
  const parts = n.split(" ");
  const head = parts[0] + (parts[1] ? ` ${parts[1]}` : ""); // e.g. "§ 823" or "Art. 6"
  const tail = parts[parts.length - 1]; // e.g. "BGB", "DSGVO"

  const candidates = [...allowedNorms].filter((a) => {
    const ap = a.split(" ");
    const ahead = ap[0] + (ap[1] ? ` ${ap[1]}` : "");
    const atail = ap[ap.length - 1];
    return ahead === head && atail === tail;
  });

  if (candidates.length === 0) return { ok: false, norm: n };

  // Choose the shortest canonical candidate (less over-specific)
  candidates.sort((a, b) => a.length - b.length);
  return { ok: true, norm: candidates[0], replacedFrom: n };
}

/**
 * Sanitizes answer text: removes or rewrites any legal norm not present in allowlist.
 * Returns sanitizedText and list of removed/replaced norms for logging.
 */
export function sanitizeAnswerCitations(answerText, allowedNorms) {
  const text = String(answerText || "");
  const found = text.match(NORM_REGEX) || [];
  if (found.length === 0) return { sanitizedText: text, removedNorms: [], replacedNorms: [] };

  let sanitized = text;
  const removed = new Set();
  const replaced = [];

  for (const raw of found) {
    const res = resolveToAllowedNorm(raw, allowedNorms);

    if (!res.ok) {
      removed.add(normalizeNorm(raw));
      // Replace the raw mention with a neutral phrase (so смысл не ломается)
      // Делай замену точечно (first occurrence), чтобы не снести всё подряд.
      sanitized = sanitized.replace(raw, "соответствующая норма (не подтверждена источниками)");
    } else if (res.replacedFrom) {
      replaced.push({ from: res.replacedFrom, to: res.norm });
      sanitized = sanitized.replace(raw, res.norm);
    }
  }

  return {
    sanitizedText: sanitized,
    removedNorms: [...removed],
    replacedNorms: replaced,
  };
}
