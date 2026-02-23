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

dotenv.config();

const app = express();
fs.mkdirSync("uploads", { recursive: true });
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());

// ===== путь к public =====
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

async function retrieveLegalSources(_sanitizedText) {
  if (!_sanitizedText || !dbPool) return [];

  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: _sanitizedText.slice(0, 8000),
    }),
  });
  if (!embRes.ok) throw new Error(`Embeddings HTTP ${embRes.status}`);

  const embJson = await embRes.json();
  const embedding = embJson?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) return [];

  const vectorLiteral = `[${embedding.join(",")}]`;
  const { rows } = await dbPool.query(
    `
      WITH active_version AS (
        SELECT value AS version_tag
        FROM law_dataset_meta
        WHERE key = 'active_version_tag'
      )
      SELECT lc.law, lc.section, lc.title, lc.text, lc.source,
             1 - (lc.embedding <=> $1::vector) AS score
      FROM law_chunks lc
      WHERE (
        lc.version_tag = (SELECT version_tag FROM active_version)
        OR NOT EXISTS (SELECT 1 FROM active_version)
      )
      ORDER BY lc.embedding <=> $1::vector
      LIMIT $2
    `,
    [vectorLiteral, LEGAL_TOP_K]
  );

  return rows.map((r) => ({
    law: r.law,
    section: r.section,
    title: r.title,
    text: r.text,
    source: r.source,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : r.score,
  }));
}

function computeFinancialRisk(text = "") {
  const euros = [...text.matchAll(/(\d{1,3}(?:[.\s]\d{3})*|\d+)\s*(€|EUR)/gi)]
    .map((m) => Number(String(m[1]).replace(/[.\s]/g, "")))
    .filter((n) => Number.isFinite(n));

  const max = euros.length ? Math.max(...euros) : 0;
  if (max >= 5000) return "high";
  if (max >= 500) return "medium";
  return "low";
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

// ===== чат =====
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
    const legalSources = await retrieveLegalSources(sanitizedText);
    const legalSourcesWithIds = legalSources.map((src, index) => ({
      ...src,
      id: `S${index + 1}`,
    }));
    const normAllowlist = buildNormAllowlist(legalSourcesWithIds);
    const financialRiskServer = computeFinancialRisk(sanitizedText);

    const system = `
Ты — RechtsInfo AI Agent (DE/RU), юридический помощник по Германии.
ВЫВОДИ ТОЛЬКО JSON.

Входные параметры:
- client_status: ${clientStatus}

Главные правила:
1) Ссылки на закон (§, закон: BGB/ZPO/SGB/…): ТОЛЬКО если норма есть в LEGAL_SOURCES. НИКОГДА не выдумывай.
2) Если точной нормы нет в LEGAL_SOURCES — так и скажи: "точную норму нужно уточнить", без догадок.
3) Не проси телефон, не повторяй личные данные.
4) Структура текста внутри analysis:
   - Краткий вывод
   - В чём юридическая проблема
   - Возможные действия (по шагам)
   - Риски и сроки (в т.ч. судебные издержки если уместно)
   - Роль Rechtsschutzversicherung (если уместно, без давления)
   - Уточняющий вопрос
5) Если пользователь просто здоровается или задаёт общий вопрос без документа, не требуй документ и отвечай по существу.

При анализе юридических ситуаций:
- указывай применимые нормы права (например: § 286 BGB, § 355 BGB, § 623 BGB).
- указывай название закона (например: BGB, ZPO, SGB II).
- не выдумывай нормы.
- если точная статья неизвестна, напиши "как правило регулируется нормами ...".
- не придумывай номера параграфов.
- Если не уверен в точной норме, не указывай конкретный параграф.

Если предоставлен текст документа:
- выдели ключевые юридические элементы.
- укажи тип документа.
- укажи сроки (Frist).
- укажи возможные последствия.
- сошлись на применимые нормы права.

Если ситуация связана с судом, сроками или официальными требованиями:
- обязательно упомяни возможные судебные издержки.
- кратко поясни роль Rechtsschutzversicherung (страховки правовой защиты) без навязчивой рекламы.
- если client_status=yes, предложи проверить покрытие полиса.
- если client_status=no, упомяни, что такие ситуации часто требуют правовой защиты.

Не продавать.
Не давить.
Не обещать исход.
Не запрашивать лишние персональные данные.

LEGAL_SOURCES:\n${JSON.stringify(legalSourcesWithIds)}\n\nCRITICAL RULE - LAW CITATIONS (NO HALLUCINATIONS):\nYou may cite legal norms (e.g., § … BGB, Art. … DSGVO, § … SGB) ONLY if the norm string appears in ALLOWED_NORMS below.\n- You MUST copy-paste the norm EXACTLY as written in ALLOWED_NORMS (character-for-character).\n- If a relevant norm is NOT in ALLOWED_NORMS, do NOT cite it. Instead say: "Не могу подтвердить конкретную норму по извлечённым источникам" and ask what document/details to retrieve next.\n- Never invent §, Absatz, Satz, Nummer, Buchstabe, Article, or law code.\n- If you cite a norm, append the source marker in brackets exactly like: [S#] (example: "§ 823 Abs. 1 BGB [S2]").\n- Do not use any [S#] that is not present in the provided LEGAL_SOURCES.\n\nALLOWED_NORMS:\n${normAllowlist.allowedNormsText || "(none)"}\n\nNORM_SOURCES (use these [S#] markers):\n${normAllowlist.normSourcesText || "(none)"}\n`.trim();

    const user = hasDocumentText
      ? `Вопрос пользователя:\n${sanitizedMessage}\n\nТекст документа:\n${sanitizedDocumentText}`
      : `Вопрос пользователя:\n${sanitizedMessage}`;

    const ai = await openaiChatStrictJSON({
      system,
      user,
      schema: RESPONSE_SCHEMA,
      schemaName: "rechtsinfo_response",
    });

    const citationSanitization = sanitizeAnswerCitations(ai.analysis, normAllowlist.allowedNorms);
    ai.analysis = citationSanitization.sanitizedText;
    if (citationSanitization.removedNorms.length || citationSanitization.replacedNorms.length) {
      console.log("CITATION_GUARD", {
        requestId,
        timestamp: new Date().toISOString(),
        removedNorms: citationSanitization.removedNorms,
        replacedNorms: citationSanitization.replacedNorms,
      });
    }
    ai.financialRisk = financialRiskServer;

    if (ai.riskLevel === "high") {
      const sumSystem = `
Ты — помощник менеджера. Выведи ТОЛЬКО JSON.
Запрещено: телефоны, email, адреса, IBAN, номера дел, любые идентификаторы.
`.trim();

      const sumUser = `
Сформируй краткое резюме high-risk кейса.
Текст клиента (уже очищенный):
${sanitizedText}

Ответ агента:
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
  console.log(`🔥 Сервер работает на порту ${PORT}`);
});
