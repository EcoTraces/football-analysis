// Enforces Coding_Rules.md / PRD.md's "No Guarantee Policy" (spec section
// 36): this platform is a statistical decision-support tool, never a
// certainty engine, and its own copy must never imply otherwise.
//
// The five phrases below are Coding_Rules.md's own list verbatim, extended
// with a few accumulator-specific hype terms the AI Football Analyst
// feature's copy could plausibly reach for. This is deliberately scoped to
// this feature's own generated/static copy (Top20/Accumulators/
// MatchesToAvoid) — NOT to ResponsibleGamblingFooter.tsx, which legitimately
// quotes several of these phrases in order to explicitly disclaim them
// ("nothing here is a 'sure bet,' 'guaranteed win'...").
export const BANNED_PHRASES = [
  "100% sure",
  "guaranteed win",
  "fixed match",
  "banker",
  "risk-free",
  "lock of the day",
  "can't lose",
  "sure thing"
];

export function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase.toLowerCase()));
}

/** Throws with the offending phrase(s) if `text` contains any banned phrase — for use in tests, not runtime UI code. */
export function assertNoBannedPhrases(text: string): void {
  const found = findBannedPhrases(text);
  if (found.length > 0) {
    throw new Error(`Text contains banned phrase(s): ${found.join(", ")}`);
  }
}
