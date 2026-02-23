import { buildNormAllowlist, sanitizeAnswerCitations } from "../src/guards/citationGuard.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const sources = [
  {
    id: "S1",
    title: "BGB example",
    text: "Schadensersatz nach § 823 Abs. 1 BGB kann einschlaegig sein.",
  },
  {
    id: "S2",
    title: "DSGVO example",
    text: "Rechtsgrundlage ist Art. 6 Abs. 1 DSGVO.",
  },
];

const allowlist = buildNormAllowlist(sources, { maxNorms: 80 });

runCase("allowlist extracts norms", () => {
  assert(allowlist.allowedNorms.has("§ 823 Abs. 1 BGB"), "Missing § 823 Abs. 1 BGB");
  assert(allowlist.allowedNorms.has("Art. 6 Abs. 1 DSGVO"), "Missing Art. 6 Abs. 1 DSGVO");
});

runCase("extracts mixed-case law code like BUrlG", () => {
  const bUrlG = buildNormAllowlist([
    { id: "S1", text: "Bei Beendigung besteht Anspruch nach § 7 Abs. 4 BUrlG." },
  ]);
  assert(bUrlG.allowedNorms.has("§ 7 Abs. 4 BUrlG"), "Missing § 7 Abs. 4 BUrlG");
});

runCase("keeps allowed norm untouched", () => {
  const input = "Применима § 823 Abs. 1 BGB.";
  const out = sanitizeAnswerCitations(input, allowlist.allowedNorms);
  assert(out.sanitizedText.includes("§ 823 Abs. 1 BGB"), "Allowed norm was changed");
  assert(out.removedNorms.length === 0, "Unexpected removed norms");
});

runCase("replaces unverified invented norm", () => {
  const input = "Также применим § 999 BGB.";
  const out = sanitizeAnswerCitations(input, allowlist.allowedNorms);
  assert(
    out.sanitizedText.includes("соответствующая норма"),
    "Invented norm was not replaced"
  );
  assert(out.removedNorms.includes("§ 999 BGB"), "Removed norm was not logged");
});

runCase("canonicalizes loose norm to allowlist norm", () => {
  const input = "Возможна ссылка на § 823 BGB.";
  const out = sanitizeAnswerCitations(input, allowlist.allowedNorms);
  assert(out.sanitizedText.includes("§ 823 Abs. 1 BGB"), "Loose norm was not canonicalized");
  assert(out.replacedNorms.some((r) => r.from === "§ 823 BGB" && r.to === "§ 823 Abs. 1 BGB"), "Replacement log missing");
});

if (!process.exitCode) {
  console.log("All citation guard tests passed.");
}
