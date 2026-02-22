import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
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
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Ты юридический информационный ассистент по Германии.
Отвечай просто и понятно.
Если не уверен — скажи, что нужно уточнить.
`
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.2
    });

    let reply = response?.choices?.[0]?.message?.content ?? "";

// Жёстко вырезаем дисклеймер, если он вдруг появится
reply = reply.replace(/[-–—]?\s*Это информационный ответ,\s*не юридическая консультация\.?\s*/gi, "").trim();

res.json({ reply });

  } catch (error) {
    console.error("OpenAI error:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Сервер работает на порту ${PORT}`);
});