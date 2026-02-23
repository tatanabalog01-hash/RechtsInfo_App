// ai/utils/citationsGuard.js
// Гарантирует: если мы не дали модели источники, она НЕ должна писать "§" как будто уверенно.

function hasLawContext(contextLawsText) {
  return typeof contextLawsText === "string" && contextLawsText.trim().length > 40;
}

function stripFakeCitations(answer) {
  // Если модель всё равно написала § без контекста — "обезвреживаем" ссылки.
  const cleaned = String(answer || "").replace(/§\s*\d+[a-zA-Z]*/g, (m) => `(${m} — не подтверждено источниками)`);
  const warning =
    "\n\nВнимание: ссылки на параграфы помечены как непроверенные, потому что база норм не была предоставлена агенту.";
  return cleaned + warning;
}

function guardAnswer(answer, contextLawsText) {
  if (hasLawContext(contextLawsText)) return answer;

  // если нет контекста законов — запрещаем "уверенные §"
  if (/§\s*\d+/.test(String(answer || ""))) {
    return stripFakeCitations(answer);
  }
  return answer;
}

export { guardAnswer, hasLawContext };
