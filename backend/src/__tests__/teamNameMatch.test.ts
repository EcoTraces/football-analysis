import { describe, expect, it } from "vitest";
import { candidatesMatching, findFixtureMatch, normalizeTeamName, teamNamesMatch } from "../lib/teamNameMatch.js";

describe("normalizeTeamName", () => {
  it("lowercases and strips whitespace", () => {
    expect(normalizeTeamName("Manchester United")).toBe("manchester united");
  });

  it("strips a common club-suffix word", () => {
    expect(normalizeTeamName("Arsenal FC")).toBe("arsenal");
    expect(normalizeTeamName("Sporting CF")).toBe("sporting");
  });

  it("strips diacritics", () => {
    expect(normalizeTeamName("1. FC Köln")).toBe("1 koln");
    expect(normalizeTeamName("Atlético Madrid")).toBe("atletico madrid");
  });

  it("does not strip a meaningful word that happens to resemble a suffix pattern", () => {
    // "United" and "City" are real distinguishing parts of a club's name —
    // must never be treated as a stripped generic suffix.
    expect(normalizeTeamName("Manchester United FC")).toBe("manchester united");
    expect(normalizeTeamName("Manchester City")).toBe("manchester city");
  });

  it("collapses punctuation and repeated whitespace", () => {
    expect(normalizeTeamName("Paris  Saint-Germain")).toBe("paris saint germain");
  });
});

describe("findFixtureMatch", () => {
  const kickoff = "2026-09-10T18:00:00.000Z";

  it("matches when team names (after normalization) and kickoff time both agree", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal FC", awayTeamName: "Chelsea FC", kickoffUtc: kickoff };
    const candidates = [{ externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff }];

    expect(findFixtureMatch(target, candidates)?.externalId).toBe("af-1");
  });

  it("matches within the kickoff tolerance, not just an exact timestamp", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:00:00.000Z" };
    const candidates = [{ externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:10:00.000Z" }]; // 10 minutes later

    expect(findFixtureMatch(target, candidates, 15)?.externalId).toBe("af-1");
  });

  it("returns null when the kickoff time is outside tolerance, even with identical team names", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:00:00.000Z" };
    const candidates = [{ externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T19:00:00.000Z" }]; // 60 minutes later

    expect(findFixtureMatch(target, candidates, 15)).toBeNull();
  });

  it("returns null when no candidate's team names match", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff };
    const candidates = [{ externalId: "af-1", homeTeamName: "Liverpool", awayTeamName: "Everton", kickoffUtc: kickoff }];

    expect(findFixtureMatch(target, candidates)).toBeNull();
  });

  it("returns null (never a best guess) when more than one candidate qualifies", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff };
    const candidates = [
      { externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff },
      { externalId: "af-2", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff }
    ];

    expect(findFixtureMatch(target, candidates)).toBeNull();
  });

  it("never matches on home/away team names swapped", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: kickoff };
    const candidates = [{ externalId: "af-1", homeTeamName: "Chelsea", awayTeamName: "Arsenal", kickoffUtc: kickoff }];

    expect(findFixtureMatch(target, candidates)).toBeNull();
  });
});

describe("candidatesMatching / teamNamesMatch", () => {
  it("candidatesMatching returns every qualifying candidate, not just one", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:00:00.000Z" };
    const candidates = [
      { externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:00:00.000Z" },
      { externalId: "af-2", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:05:00.000Z" }
    ];

    expect(candidatesMatching(target, candidates).map((c) => c.externalId)).toEqual(["af-1", "af-2"]);
  });

  it("teamNamesMatch is true even when kickoff time disagrees (used to distinguish ambiguous from no-signal)", () => {
    const target = { externalId: "x", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-10T18:00:00.000Z" };
    const candidates = [{ externalId: "af-1", homeTeamName: "Arsenal", awayTeamName: "Chelsea", kickoffUtc: "2026-09-11T18:00:00.000Z" }];

    expect(teamNamesMatch(target, candidates)).toBe(true);
    expect(findFixtureMatch(target, candidates)).toBeNull();
  });
});
