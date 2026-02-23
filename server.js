import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import fsPromises from "fs/promises";
import { PDFParse } from "pdf-parse";
import multer from "multer";
import Tesseract from "tesseract.js";
import { Pool } from "pg";
import path from "path";
import { fileURLToPath } from "url";
import { buildNormAllowlist, sanitizeAnswerCitations } from "./src/guards/citationGuard.js";
import { buildLegalBasisQuery, isLegalBasisRequest } from "./src/retrieval/legalBasisQuery.js";

dotenv.config();

const app = express();
fs.mkdirSync("uploads", { recursive: true });
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());

// ===== РїСѓС‚СЊ Рє public =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ===== OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const LEGAL_TOP_K = Number(process.env.LEGAL_TOP_K || 5);
const MANAGER_WEBHOOK_URL = process.env.MANAGER_WEBHOOK_URL || "";

const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;

function redactPII(text = "") {
  return text
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[REDACTED_PHONE]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[REDACTED_IBAN]")
    .replace(/\b(AZ|Aktenzeichen|Vorgang|Policen?-?Nr\.?)\s*[:#]?\s*\S+\b/gi, "[REDACTED_REF]");
}

async function extractTextFromUpload(file) {
  if (!file) return "";

  if (file.mimetype === "application/pdf") {
    const dataBuffer = fs.readFileSync(file.path);
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (file.mimetype?.startsWith("image/")) {
    const result = await Tesseract.recognize(file.path, "deu");
    return result?.data?.text || "";
  }

  return "";
}

async function getTextEmbedding(inputText) {
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: String(inputText || "").slice(0, 8000),
    }),
  });
  if (!embRes.ok) throw new Error(`Embeddings HTTP ${embRes.status}`);

  const embJson = await embRes.json();
  return embJson?.data?.[0]?.embedding;
}

async function retrieveLegalSources(_queryText, { topK, lawCodes } = {}) {
  if (!_queryText || !dbPool) return [];
  const limit = Number.isFinite(topK) && topK > 0 ? topK : LEGAL_TOP_K;
  const embedding = await getTextEmbedding(_queryText);
  if (!Array.isArray(embedding)) return [];

  const vectorLiteral = `[${embedding.join(",")}]`;
  const lawCodeFilter = Array.isArray(lawCodes) ? [...new Set(lawCodes.filter(Boolean))] : [];
  const { rows } = await dbPool.query(
    `
      WITH active_version AS (
        SELECT value AS version_tag
        FROM law_dataset_meta
        WHERE key = 'active_version_tag'
      ),
      effective_version AS (
        SELECT CASE
          WHEN EXISTS (
            SELECT 1
            FROM law_chunks
            WHERE version_tag = (SELECT version_tag FROM active_version)
          ) THEN (SELECT version_tag FROM active_version)
          ELSE (
            SELECT MAX(version_tag)
            FROM law_chunks
          )
        END AS version_tag
      )
      SELECT lc.law, lc.section, lc.title, lc.text, lc.source,
             1 - (lc.embedding <=> $1::vector) AS score
      FROM law_chunks lc
      WHERE (
        (SELECT version_tag FROM effective_version) IS NULL
        OR lc.version_tag = (SELECT version_tag FROM effective_version)
      )
      AND (
        COALESCE(array_length($3::text[], 1), 0) = 0
        OR lc.law = ANY($3::text[])
      )
      ORDER BY lc.embedding <=> $1::vector
      LIMIT $2
    `,
    [vectorLiteral, limit, lawCodeFilter]
  );

  if (!rows.length) {
    console.warn("LAW_RETRIEVAL_EMPTY", {
      querySample: String(_queryText).slice(0, 200),
      topK: limit,
      lawCodes: lawCodeFilter,
    });
  }

  return rows.map((r) => ({
    law: r.law,
    section: r.section,
    title: r.title,
    text: r.text,
    source: r.source,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : r.score,
  }));
}

async function selectTopLawCodes(queryText, { topN = 3 } = {}) {
  if (!dbPool) return [];
  const embedding = await getTextEmbedding(queryText);
  if (!Array.isArray(embedding)) return [];
  const vectorLiteral = `[${embedding.join(",")}]`;
  try {
    const { rows } = await dbPool.query(
      `
        SELECT law_code
        FROM law_catalog
        ORDER BY embedding <-> $1::vector
        LIMIT $2
      `,
      [vectorLiteral, topN]
    );
    return rows.map((r) => r.law_code).filter(Boolean);
  } catch (error) {
    console.warn("LAW_CATALOG_LOOKUP_FAILED", error?.message || error);
    return [];
  }
}

function computeFinancialRisk(text = "") {
  const euros = [...text.matchAll(/(\d{1,3}(?:[.\s]\d{3})*|\d+)\s*(в‚¬|EUR)/gi)]
    .map((m) => Number(String(m[1]).replace(/[.\s]/g, "")))
    .filter((n) => Number.isFinite(n));

  const max = euros.length ? Math.max(...euros) : 0;
  if (max >= 5000) return "high";
  if (max >= 500) return "medium";
  return "low";
}

function mergeLegalSourcesUnique(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  for (const src of [...primary, ...secondary]) {
    const key = [
      src?.law || "",
      src?.section || "",
      src?.title || "",
      String(src?.text || "").slice(0, 300),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(src);
  }
  return merged;
}

async function openaiChatStrictJSON({ system, user, schema, schemaName }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      store: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema,
        },
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI empty content");

  return JSON.parse(content);
}

async function sendHighRiskToManager(summaryObj, meta = {}) {
  if (!MANAGER_WEBHOOK_URL) return false;

  const payload = {
    timestamp: new Date().toISOString(),
    client_status: meta.clientStatus || "unknown",
    riskLevel: meta.riskLevel || "high",
    financialRisk: meta.financialRisk || "unknown",
    manager_summary: summaryObj, // no PII by contract
  };

  const r = await fetch(MANAGER_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Manager webhook HTTP ${r.status}`);
  return true;
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    analysis: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    financialRisk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["analysis", "riskLevel", "financialRisk"],
};

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    whyHighRisk: { type: "string" },
    nextActionForManager: { type: "string" },
  },
  required: ["summary", "whyHighRisk", "nextActionForManager"],
};

// ===== С‡Р°С‚ =====
app.post("/chat", upload.single("file"), async (req, res) => {
  const file = req.file;
  const requestId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const message = String(req.body?.message || "");
    const clientStatus = req.body?.client_status === "yes" ? "yes" : "no";
    const bodyExtractedText = String(req.body?.extractedText || "");
    const fileExtractedText = await extractTextFromUpload(file);
    const extractedText = fileExtractedText || bodyExtractedText;

    const hasDocumentText = Boolean(extractedText && extractedText.trim());
    const sanitizedMessage = redactPII(message);
    const sanitizedDocumentText = hasDocumentText ? redactPII(extractedText) : "";
    const sanitizedText = hasDocumentText
      ? `${sanitizedMessage}\n\n[DOCUMENT_TEXT]\n${sanitizedDocumentText}`
      : sanitizedMessage;
    const userText = req.body?.message || "";
    const legalBasisMode = isLegalBasisRequest(userText);
    const retrievalQuery = legalBasisMode
      ? buildLegalBasisQuery(userText)
      : userText;
    const topK = legalBasisMode ? 10 : 6;
    const lawCatalogTopLawCodes = legalBasisMode
      ? await selectTopLawCodes(retrievalQuery, { topN: 3 })
      : [];
    let legalSources = await retrieveLegalSources(retrievalQuery, {
      topK,
      lawCodes: lawCatalogTopLawCodes,
    });
    let legalSourcesWithIds = legalSources.map((src, index) => ({
      ...src,
      id: `S${index + 1}`,
    }));
    let normAllowlist = buildNormAllowlist(legalSourcesWithIds);

    let fallbackRetrievalUsed = false;
    if (legalBasisMode && normAllowlist.allowedNorms.size === 0) {
      const fallbackQuery = [
        "Arbeitsrecht",
        "Urlaub",
        "Urlaubsabgeltung",
        "Urlaubsentgelt",
        "Kündigung",
        "Beendigung des Arbeitsverhältnisses",
        "Bundesurlaubsgesetz BUrlG",
        "offene Zahlung Arbeitgeber",
      ].join(" | ");
      const fallbackSources = await retrieveLegalSources(fallbackQuery, { topK: 14 });
      legalSources = mergeLegalSourcesUnique(legalSources, fallbackSources);
      legalSourcesWithIds = legalSources.map((src, index) => ({
        ...src,
        id: `S${index + 1}`,
      }));
      normAllowlist = buildNormAllowlist(legalSourcesWithIds);
      fallbackRetrievalUsed = true;
    }

    console.log("ALLOWED_NORMS size:", normAllowlist.allowedNorms.size);
    console.log("ALLOWED_NORMS sample:", [...normAllowlist.allowedNorms].slice(0, 10));
    console.log("CITATION_GUARD_ALLOWLIST", {
      requestId,
      timestamp: new Date().toISOString(),
      legalSourcesCount: legalSourcesWithIds.length,
      allowedNormsCount: normAllowlist.allowedNorms.size,
      allowedNormsPreview: [...normAllowlist.allowedNorms].slice(0, 10),
      retrievalMode: legalBasisMode ? "legal_basis_enriched" : "default",
      retrievalTopK: topK,
      lawCatalogTopLawCodes,
      fallbackRetrievalUsed,
      sourcesPreview: legalSourcesWithIds.slice(0, 5).map((s) => ({
        id: s.id,
        law: s.law,
        section: s.section,
        title: s.title,
      })),
      sourceIds: legalSourcesWithIds.map((s) => s.id),
    });
    const financialRiskServer = computeFinancialRisk(sanitizedText);

    const system = `
РўС‹ вЂ” RechtsInfo AI Agent (DE/RU), СЋСЂРёРґРёС‡РµСЃРєРёР№ РїРѕРјРѕС‰РЅРёРє РїРѕ Р“РµСЂРјР°РЅРёРё.
Р’Р«Р’РћР”Р РўРћР›Р¬РљРћ JSON.

Р’С…РѕРґРЅС‹Рµ РїР°СЂР°РјРµС‚СЂС‹:
- client_status: ${clientStatus}

Р“Р»Р°РІРЅС‹Рµ РїСЂР°РІРёР»Р°:
1) РЎСЃС‹Р»РєРё РЅР° Р·Р°РєРѕРЅ (В§, Р·Р°РєРѕРЅ: BGB/ZPO/SGB/вЂ¦): РўРћР›Р¬РљРћ РµСЃР»Рё РЅРѕСЂРјР° РµСЃС‚СЊ РІ LEGAL_SOURCES. РќРРљРћР“Р”Рђ РЅРµ РІС‹РґСѓРјС‹РІР°Р№.
2) Р•СЃР»Рё С‚РѕС‡РЅРѕР№ РЅРѕСЂРјС‹ РЅРµС‚ РІ LEGAL_SOURCES вЂ” С‚Р°Рє Рё СЃРєР°Р¶Рё: "С‚РѕС‡РЅСѓСЋ РЅРѕСЂРјСѓ РЅСѓР¶РЅРѕ СѓС‚РѕС‡РЅРёС‚СЊ", Р±РµР· РґРѕРіР°РґРѕРє.
3) РќРµ РїСЂРѕСЃРё С‚РµР»РµС„РѕРЅ, РЅРµ РїРѕРІС‚РѕСЂСЏР№ Р»РёС‡РЅС‹Рµ РґР°РЅРЅС‹Рµ.
4) РЎС‚СЂСѓРєС‚СѓСЂР° С‚РµРєСЃС‚Р° РІРЅСѓС‚СЂРё analysis:
   - РљСЂР°С‚РєРёР№ РІС‹РІРѕРґ
   - Р’ С‡С‘Рј СЋСЂРёРґРёС‡РµСЃРєР°СЏ РїСЂРѕР±Р»РµРјР°
   - Р’РѕР·РјРѕР¶РЅС‹Рµ РґРµР№СЃС‚РІРёСЏ (РїРѕ С€Р°РіР°Рј)
   - Р РёСЃРєРё Рё СЃСЂРѕРєРё (РІ С‚.С‡. СЃСѓРґРµР±РЅС‹Рµ РёР·РґРµСЂР¶РєРё РµСЃР»Рё СѓРјРµСЃС‚РЅРѕ)
   - Р РѕР»СЊ Rechtsschutzversicherung (РµСЃР»Рё СѓРјРµСЃС‚РЅРѕ, Р±РµР· РґР°РІР»РµРЅРёСЏ)
   - РЈС‚РѕС‡РЅСЏСЋС‰РёР№ РІРѕРїСЂРѕСЃ
5) Р•СЃР»Рё РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РїСЂРѕСЃС‚Рѕ Р·РґРѕСЂРѕРІР°РµС‚СЃСЏ РёР»Рё Р·Р°РґР°С‘С‚ РѕР±С‰РёР№ РІРѕРїСЂРѕСЃ Р±РµР· РґРѕРєСѓРјРµРЅС‚Р°, РЅРµ С‚СЂРµР±СѓР№ РґРѕРєСѓРјРµРЅС‚ Рё РѕС‚РІРµС‡Р°Р№ РїРѕ СЃСѓС‰РµСЃС‚РІСѓ.

РџСЂРё Р°РЅР°Р»РёР·Рµ СЋСЂРёРґРёС‡РµСЃРєРёС… СЃРёС‚СѓР°С†РёР№:
- СѓРєР°Р·С‹РІР°Р№ РїСЂРёРјРµРЅРёРјС‹Рµ РЅРѕСЂРјС‹ РїСЂР°РІР° (РЅР°РїСЂРёРјРµСЂ: В§ 286 BGB, В§ 355 BGB, В§ 623 BGB).
- СѓРєР°Р·С‹РІР°Р№ РЅР°Р·РІР°РЅРёРµ Р·Р°РєРѕРЅР° (РЅР°РїСЂРёРјРµСЂ: BGB, ZPO, SGB II).
- РЅРµ РІС‹РґСѓРјС‹РІР°Р№ РЅРѕСЂРјС‹.
- РµСЃР»Рё С‚РѕС‡РЅР°СЏ СЃС‚Р°С‚СЊСЏ РЅРµРёР·РІРµСЃС‚РЅР°, РЅР°РїРёС€Рё "РєР°Рє РїСЂР°РІРёР»Рѕ СЂРµРіСѓР»РёСЂСѓРµС‚СЃСЏ РЅРѕСЂРјР°РјРё ...".
- РЅРµ РїСЂРёРґСѓРјС‹РІР°Р№ РЅРѕРјРµСЂР° РїР°СЂР°РіСЂР°С„РѕРІ.
- Р•СЃР»Рё РЅРµ СѓРІРµСЂРµРЅ РІ С‚РѕС‡РЅРѕР№ РЅРѕСЂРјРµ, РЅРµ СѓРєР°Р·С‹РІР°Р№ РєРѕРЅРєСЂРµС‚РЅС‹Р№ РїР°СЂР°РіСЂР°С„.

Р•СЃР»Рё РїСЂРµРґРѕСЃС‚Р°РІР»РµРЅ С‚РµРєСЃС‚ РґРѕРєСѓРјРµРЅС‚Р°:
- РІС‹РґРµР»Рё РєР»СЋС‡РµРІС‹Рµ СЋСЂРёРґРёС‡РµСЃРєРёРµ СЌР»РµРјРµРЅС‚С‹.
- СѓРєР°Р¶Рё С‚РёРї РґРѕРєСѓРјРµРЅС‚Р°.
- СѓРєР°Р¶Рё СЃСЂРѕРєРё (Frist).
- СѓРєР°Р¶Рё РІРѕР·РјРѕР¶РЅС‹Рµ РїРѕСЃР»РµРґСЃС‚РІРёСЏ.
- СЃРѕС€Р»РёСЃСЊ РЅР° РїСЂРёРјРµРЅРёРјС‹Рµ РЅРѕСЂРјС‹ РїСЂР°РІР°.

Р•СЃР»Рё СЃРёС‚СѓР°С†РёСЏ СЃРІСЏР·Р°РЅР° СЃ СЃСѓРґРѕРј, СЃСЂРѕРєР°РјРё РёР»Рё РѕС„РёС†РёР°Р»СЊРЅС‹РјРё С‚СЂРµР±РѕРІР°РЅРёСЏРјРё:
- РѕР±СЏР·Р°С‚РµР»СЊРЅРѕ СѓРїРѕРјСЏРЅРё РІРѕР·РјРѕР¶РЅС‹Рµ СЃСѓРґРµР±РЅС‹Рµ РёР·РґРµСЂР¶РєРё.
- РєСЂР°С‚РєРѕ РїРѕСЏСЃРЅРё СЂРѕР»СЊ Rechtsschutzversicherung (СЃС‚СЂР°С…РѕРІРєРё РїСЂР°РІРѕРІРѕР№ Р·Р°С‰РёС‚С‹) Р±РµР· РЅР°РІСЏР·С‡РёРІРѕР№ СЂРµРєР»Р°РјС‹.
- РµСЃР»Рё client_status=yes, РїСЂРµРґР»РѕР¶Рё РїСЂРѕРІРµСЂРёС‚СЊ РїРѕРєСЂС‹С‚РёРµ РїРѕР»РёСЃР°.
- РµСЃР»Рё client_status=no, СѓРїРѕРјСЏРЅРё, С‡С‚Рѕ С‚Р°РєРёРµ СЃРёС‚СѓР°С†РёРё С‡Р°СЃС‚Рѕ С‚СЂРµР±СѓСЋС‚ РїСЂР°РІРѕРІРѕР№ Р·Р°С‰РёС‚С‹.

РќРµ РїСЂРѕРґР°РІР°С‚СЊ.
РќРµ РґР°РІРёС‚СЊ.
РќРµ РѕР±РµС‰Р°С‚СЊ РёСЃС…РѕРґ.
РќРµ Р·Р°РїСЂР°С€РёРІР°С‚СЊ Р»РёС€РЅРёРµ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹Рµ РґР°РЅРЅС‹Рµ.

LEGAL_SOURCES:\n${JSON.stringify(legalSourcesWithIds)}\n\nCRITICAL RULE - LAW CITATIONS (NO HALLUCINATIONS):\nYou may cite legal norms (e.g., В§ вЂ¦ BGB, Art. вЂ¦ DSGVO, В§ вЂ¦ SGB) ONLY if the norm string appears in ALLOWED_NORMS below.\n- You MUST copy-paste the norm EXACTLY as written in ALLOWED_NORMS (character-for-character).
- If the user asks which law/article/paragraph regulates their issue and ALLOWED_NORMS is not empty, you MUST cite the most relevant exact norms from ALLOWED_NORMS (prefer 2-5 norms if available).\n- If a relevant norm is NOT in ALLOWED_NORMS, do NOT cite it. Instead say: "Не могу подтвердить конкретные нормы по извлечённым источникам" and ask what document/details to retrieve next.\n- Never mention "allowed norms", "allowlist", "whitelist" or internal restrictions.\n- Never invent В§, Absatz, Satz, Nummer, Buchstabe, Article, or law code.\n- If you cite a norm, append the source marker in brackets exactly like: [S#] (example: "В§ 823 Abs. 1 BGB [S2]").\n- Do not use any [S#] that is not present in the provided LEGAL_SOURCES.\n\nALLOWED_NORMS:\n${normAllowlist.allowedNormsText || "(none)"}\n\nNORM_SOURCES (use these [S#] markers):\n${normAllowlist.normSourcesText || "(none)"}\n`.trim();

    const user = hasDocumentText
      ? `Р’РѕРїСЂРѕСЃ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ:\n${sanitizedMessage}\n\nРўРµРєСЃС‚ РґРѕРєСѓРјРµРЅС‚Р°:\n${sanitizedDocumentText}`
      : `Р’РѕРїСЂРѕСЃ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ:\n${sanitizedMessage}`;

    const ai = await openaiChatStrictJSON({
      system,
      user,
      schema: RESPONSE_SCHEMA,
      schemaName: "rechtsinfo_response",
    });

    const citationSanitization = sanitizeAnswerCitations(ai.analysis, normAllowlist.allowedNorms);
    ai.analysis = citationSanitization.sanitizedText;
    const hasAllowedNormInAnswer = [...normAllowlist.allowedNorms].some((norm) => ai.analysis.includes(norm));
    if (legalBasisMode && !hasAllowedNormInAnswer) {
      ai.analysis =
        "Не могу подтвердить конкретные нормы по извлечённым источникам. " +
        "Пришлите текст расчёта при увольнении, приказ/соглашение об увольнении или документ работодателя, чтобы я подтянул точные нормы и статьи.";
    }
    if (citationSanitization.removedNorms.length || citationSanitization.replacedNorms.length) {
      console.log("CITATION_GUARD", {
        requestId,
        timestamp: new Date().toISOString(),
        removedNorms: citationSanitization.removedNorms,
        replacedNorms: citationSanitization.replacedNorms,
        legalBasisMode,
        hasAllowedNormInAnswer,
      });
    }
    ai.financialRisk = financialRiskServer;

    if (ai.riskLevel === "high") {
      const sumSystem = `
РўС‹ вЂ” РїРѕРјРѕС‰РЅРёРє РјРµРЅРµРґР¶РµСЂР°. Р’С‹РІРµРґРё РўРћР›Р¬РљРћ JSON.
Р—Р°РїСЂРµС‰РµРЅРѕ: С‚РµР»РµС„РѕРЅС‹, email, Р°РґСЂРµСЃР°, IBAN, РЅРѕРјРµСЂР° РґРµР», Р»СЋР±С‹Рµ РёРґРµРЅС‚РёС„РёРєР°С‚РѕСЂС‹.
`.trim();

      const sumUser = `
РЎС„РѕСЂРјРёСЂСѓР№ РєСЂР°С‚РєРѕРµ СЂРµР·СЋРјРµ high-risk РєРµР№СЃР°.
РўРµРєСЃС‚ РєР»РёРµРЅС‚Р° (СѓР¶Рµ РѕС‡РёС‰РµРЅРЅС‹Р№):
${sanitizedText}

РћС‚РІРµС‚ Р°РіРµРЅС‚Р°:
${ai.analysis}
`.trim();

      const summaryObj = await openaiChatStrictJSON({
        system: sumSystem,
        user: sumUser,
        schema: SUMMARY_SCHEMA,
        schemaName: "rechtsinfo_manager_summary",
      });

      await sendHighRiskToManager(summaryObj, {
        clientStatus,
        riskLevel: ai.riskLevel,
        financialRisk: ai.financialRisk,
      });
      ai.managerSummary = summaryObj;
      ai.managerEscalated = true;
    }

    return res.json(ai);

  } catch (error) {
    console.error("CHAT_FAILED", error?.message || error);
    return res.status(500).json({ error: "CHAT_FAILED" });
  } finally {
    if (file?.path) {
      try {
        await fsPromises.unlink(file.path);
      } catch {
        // ignore cleanup errors
      }
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`рџ”Ґ РЎРµСЂРІРµСЂ СЂР°Р±РѕС‚Р°РµС‚ РЅР° РїРѕСЂС‚Сѓ ${PORT}`);
});



