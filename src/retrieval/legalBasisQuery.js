// src/retrieval/legalBasisQuery.js (ESM)

// Unicode-escape Russian keywords to avoid source encoding issues on deploy/edit hosts.
const RU_LAWS_RE = /\u043a\u0430\u043a\u0438\u043c\u0438\s+\u0437\u0430\u043a\u043e\u043d\u0430\u043c\u0438|\u043a\u0430\u043a\u043e\u0439\s+\u0437\u0430\u043a\u043e\u043d|\u0437\u0430\u043a\u043e\u043d\u0430\u043c\u0438|\u0437\u0430\u043a\u043e\u043d|\u0441\u0442\u0430\u0442\u044c(\u044f|\u0438)|\u043f\u0430\u0440\u0430\u0433\u0440\u0430\u0444/iu;
const LATIN_LAWS_RE = /\b(§|art\.?|article|norm|gesetz|paragraph|law|laws)\b/i;

const RU_VACATION_RE = /\u043e\u0442\u043f\u0443\u0441\u043a/iu;
const RU_DISMISSAL_RE = /\u0443\u0432\u043e\u043b\u044c\u043d/iu;
const RU_NOT_PAID_RE = /\u043d\u0435\s*\u0432\u044b\u043f\u043b\u0430\u0442/iu;
const RU_COMPENSATION_RE = /\u043a\u043e\u043c\u043f\u0435\u043d\u0441\u0430\u0446/iu;
const RU_CALC_RE = /\u0440\u0430\u0441\u0447\u0435\u0442/iu;

/**
 * True, if user explicitly asks for legal basis / laws / articles / paragraphs.
 */
export function isLegalBasisRequest(text = "") {
  const t = String(text || "");
  return RU_LAWS_RE.test(t) || LATIN_LAWS_RE.test(t);
}

/**
 * Builds a DE-enriched retrieval query for labor-law legal-basis requests.
 * We intentionally bias retrieval toward BUrlG / vacation payout on termination.
 */
export function buildLegalBasisQuery(userText = "") {
  const raw = String(userText || "").trim();
  let q = raw;

  // RU -> DE hints to improve embeddings recall for labor/vacation payout.
  if (RU_VACATION_RE.test(raw)) q += " | Urlaub | Urlaubsentgelt | Urlaubsabgeltung";
  if (RU_DISMISSAL_RE.test(raw)) q += " | Kündigung | Beendigung des Arbeitsverhältnisses";
  if (RU_NOT_PAID_RE.test(raw)) q += " | nicht gezahlt | offene Zahlung Arbeitgeber";
  if (RU_COMPENSATION_RE.test(raw)) q += " | Abgeltung";
  if (RU_CALC_RE.test(raw)) q += " | Berechnung";

  // Retrieval-only hints (not shown to user). Including likely BUrlG sections improves recall.
  return [
    "Arbeitsrecht",
    "Bundesurlaubsgesetz BUrlG",
    "Urlaub",
    "Urlaubsentgelt",
    "Urlaubsabgeltung",
    "§ 7 Abs. 4 BUrlG",
    "§ 11 BUrlG",
    q,
  ].join(" | ");
}
