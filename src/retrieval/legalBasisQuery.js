// src/retrieval/legalBasisQuery.js (ESM)

/**
 * True, если пользователь явно просит "законы/статьи/§/правовая база".
 */
export function isLegalBasisRequest(text = "") {
  const t = String(text).toLowerCase();
  return /(какими\s+законами|какой\s+закон|стать(я|и)|параграф|§|art\.|norm|gesetz|paragraph)/i.test(t);
}

/**
 * Делает DE-обогащённый запрос под трудовые темы.
 * Минимально и предсказуемо: без "умных" вариантов.
 */
export function buildLegalBasisQuery(userText = "") {
  let q = String(userText);

  // простая RU→DE подстановка, чтобы embeddings попадали в нужные куски
  q = q.replace(/отпускн/gi, "Urlaubsentgelt Urlaub");
  q = q.replace(/увольнен/gi, "Beendigung des Arbeitsverhältnisses Kündigung");
  q = q.replace(/не\s*выплат/gi, "nicht gezahlt ausstehende Zahlung");
  q = q.replace(/компенсац/gi, "Abgeltung");
  q = q.replace(/расчет/gi, "Berechnung");

  // фиксированный “каркас” под Arbeitsrecht/Urlaub
  // (не вставляем конкретные §, чтобы не выглядело как навязывание — retrieval сам найдёт)
  return [
    "Arbeitsrecht",
    "Urlaub",
    "Urlaubsabgeltung",
    "Urlaubsentgelt",
    "Beendigung des Arbeitsverhältnisses",
    "Bundesurlaubsgesetz BUrlG",
    q,
  ].join(" | ");
}
