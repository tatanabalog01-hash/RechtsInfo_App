// ai/legalAnswer.js (ESM)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { guardAnswer } from "./utils/citationsGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @param {object} deps
 * @param {function} deps.llmCall - async ({system, user, temperature}) => string
 * @param {function} deps.retrieveLaws - async (query) => string  // вернёт текст норм/выдержек
 */
function createLegalAnswerer({ llmCall, retrieveLaws }) {
  const systemPrompt = fs.readFileSync(
    path.join(__dirname, "prompts", "system_legal_ru.txt"),
    "utf8"
  );

  return async function answerLegalQuestion(userQuestion) {
    let contextLawsText = "";
    try {
      contextLawsText = await retrieveLaws(userQuestion);
    } catch {
      contextLawsText = "";
    }

    const userPrompt =
`ВОПРОС ПОЛЬЗОВАТЕЛЯ:
${userQuestion}

CONTEXT_LAWS (выдержки из базы законов, если есть):
${contextLawsText || "—"}

ИНСТРУКЦИЯ:
Ответь по формату. Ссылайся на § ТОЛЬКО если они есть в CONTEXT_LAWS.`;

    const raw = await llmCall({
      system: systemPrompt,
      user: userPrompt,
      temperature: 0.2,
    });

    const safe = guardAnswer(String(raw || ""), contextLawsText);

    return {
      answer: safe,
      used_context: Boolean(contextLawsText && contextLawsText.trim().length),
    };
  };
}

export { createLegalAnswerer };
