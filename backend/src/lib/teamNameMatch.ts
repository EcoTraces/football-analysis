// Cross-provider fixture matching — used to link a fixture sourced from
// this app's primary FootballDataProvider (whichever is configured) to its
// counterpart in a second, always-on provider used only for odds/injuries/
// lineups (see matchFixturesToSecondaryProvider.ts). There is no shared
// vendor id between two different football-data vendors, so matching has
// to go on team names + kickoff time instead — and it must stay
// conservative: this codebase's own "never fabricate" rule applies here as
// much as anywhere else. A WRONG match would silently attach one real
// match's odds/injuries/lineups to a DIFFERENT real match, which is worse
// than leaving it unmatched. So this deliberately does NOT do fuzzy/
// similarity-score matching — only an exact match (after normalization) on
// both team names, within a kickoff-time tolerance, and only when exactly
// one candidate qualifies. Zero or multiple qualifying candidates both
// resolve to "no match," never a best-guess.

// Whole-word club-suffix tokens stripped before comparing — these vary by
// vendor/language (a club called "X FC" in one feed and just "X" in
// another) without changing which real team it is. Deliberately NOT
// stripping words that could be part of an actual distinguishing name
// (e.g. "United", "City", "Athletic") since removing those could make two
// genuinely different clubs collide.
const CLUB_SUFFIX_WORDS = new Set(["fc", "cf", "afc", "sc", "ac", "ssc", "ss", "us", "cd", "ca", "ud", "cfc", "sad", "club"]);

export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (e.g. "Koln" from "Köln")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .split(/\s+/)
    .filter((word) => word.length > 0 && !CLUB_SUFFIX_WORDS.has(word))
    .join(" ")
    .trim();
}

export interface MatchableFixture {
  externalId: string;
  homeTeamName: string;
  awayTeamName: string;
  kickoffUtc: string;
}

// Returns the unique candidate whose normalized home/away team names both
// match exactly and whose kickoff time is within toleranceMinutes of the
// target's — or null if zero or more than one candidate qualifies.
export function findFixtureMatch<T extends MatchableFixture>(
  target: MatchableFixture,
  candidates: readonly T[],
  toleranceMinutes = 15
): T | null {
  const matches = candidatesMatching(target, candidates, toleranceMinutes);
  return matches.length === 1 ? (matches[0] as T) : null;
}

// Exposed separately (not just via findFixtureMatch's null) so a caller
// can distinguish "no candidate had matching team names at all" from "more
// than one did" for observability — see matchFixturesToSecondaryProvider.ts.
export function candidatesMatching<T extends MatchableFixture>(
  target: MatchableFixture,
  candidates: readonly T[],
  toleranceMinutes = 15
): T[] {
  const targetHome = normalizeTeamName(target.homeTeamName);
  const targetAway = normalizeTeamName(target.awayTeamName);
  const targetKickoff = new Date(target.kickoffUtc).getTime();
  const toleranceMs = toleranceMinutes * 60_000;

  return candidates.filter((c) => {
    if (normalizeTeamName(c.homeTeamName) !== targetHome) return false;
    if (normalizeTeamName(c.awayTeamName) !== targetAway) return false;
    return Math.abs(new Date(c.kickoffUtc).getTime() - targetKickoff) <= toleranceMs;
  });
}

export function teamNamesMatch<T extends MatchableFixture>(target: MatchableFixture, candidates: readonly T[]): boolean {
  const targetHome = normalizeTeamName(target.homeTeamName);
  const targetAway = normalizeTeamName(target.awayTeamName);
  return candidates.some((c) => normalizeTeamName(c.homeTeamName) === targetHome && normalizeTeamName(c.awayTeamName) === targetAway);
}
