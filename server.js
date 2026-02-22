import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import pdf from "pdf-parse";
import multer from "multer";
import Tesseract from "tesseract.js";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());

// ===== путь к public =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ===== OpenAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== чат =====
app.post("/chat", upload.single("file"), async (req, res) => {
  try {
    let extractedText = "";
    if (req.file) {
      if (req.file.mimetype === "application/pdf") {
        const dataBuffer = fs.readFileSync(req.file.path);
        const pdfData = await pdf(dataBuffer);
        extractedText = pdfData.text;
      }

      if (req.file.mimetype.startsWith("image/")) {
        const result = await Tesseract.recognize(req.file.path, "deu");
        extractedText = result.data.text;
      }
    }

    const clientStatus = req.body.client_status || "unknown";
    const system = `
Ты юридический AI-агент для Германии (RechtsInfo).

Твоя задача:
1. Проанализировать ситуацию.
2. Определить:
   - юридическую категорию
   - уровень процессуального риска
   - уровень финансового риска (low | medium | high)
3. Дать структурированный ответ:
   1. Краткий вывод
   2. В чём проблема
   3. Возможные действия (1–3 шага)
   4. Риски и сроки
   5. Один уточняющий вопрос

Финансовый риск:
- low — минимальные или маловероятные расходы
- medium — возможны расходы или штрафы
- high — вероятны судебные издержки, адвокатские расходы или серьёзные финансовые последствия

Если финансовый риск medium или high:
- уместно кратко и нейтрально упомянуть возможные судебные издержки.
- при необходимости аккуратно упомянуть роль правовой защиты (Rechtsschutzversicherung), без навязчивой рекламы.

Если client_status = yes:
- можешь предложить проверить покрытие полиса.

Если client_status = no:
- упоминай правовую защиту только если это действительно влияет на решение пользователя.

Если ситуация связана с судом, сроками или официальными требованиями:
- обязательно упомяни возможные судебные издержки.
- кратко поясни роль Rechtsschutzversicherung (страховки правовой защиты) без навязчивой рекламы.
- если client_status=yes, предложи проверить покрытие полиса.
- если client_status=no, упомяни, что такие ситуации часто требуют правовой защиты.

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

Не продавать.
Не давить.
Не обещать исход.
Не запрашивать лишние персональные данные.

Ответ должен быть в формате JSON:

{
  "analysis": "...",
  "riskLevel": "low | medium | high",
  "financialRisk": "low | medium | high"
}

Контекст пользователя:
client_status = ${clientStatus}
`;
    const bodyExtractedText = req.body.extractedText || "";
    extractedText = extractedText || bodyExtractedText;

    const messages = [
      { role: "system", content: system },
      {
        role: "user",
        content: `
Вопрос пользователя:
${req.body.message}

Текст документа:
${extractedText}
`
      }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2
    });

    const raw = response?.choices?.[0]?.message?.content ?? "";

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {
        analysis: raw,
        riskLevel: "medium"
      };
    }

    res.json(parsed);

  } catch (error) {
    console.error("OpenAI error:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  } finally {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Сервер работает на порту ${PORT}`);
});
