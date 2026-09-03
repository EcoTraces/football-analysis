import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { DEFAULT_RATING, K_FACTOR, applyMatchResult, computeCurrentEloRatings, expectedScore, getTeamElo } from "../jobs/computeEloRatings.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function finishedFixture(
  id: string,
  kickoffUtc: string,
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number
) {
  return {
    id,
    kickoff_utc: kickoffUtc,
    status: "finished",
    is_synthetic: false,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    home_score: homeScore,
    away_score: awayScore
  };
}

describe("expectedScore", () => {
  it("returns exactly 0.5 for equal ratings", () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 9);
  });

  it("favours the higher-rated side", () => {
    expect(expectedScore(1700, 1500)).toBeGreaterThan(0.5);
    expect(expectedScore(1500, 1700)).toBeLessThan(0.5);
  });
});

describe("applyMatchResult", () => {
  it("moves the winner up and the loser down by the same magnitude when ratings started equal", () => {
    const result = applyMatchResult({ rating: 1500, matchesPlayed: 0 }, { rating: 1500, matchesPlayed: 0 }, 2, 0);
    expect(result.home.rating).toBeCloseTo(1500 + K_FACTOR * 0.5, 9);
    expect(result.away.rating).toBeCloseTo(1500 - K_FACTOR * 0.5, 9);
    expect(result.home.matchesPlayed).toBe(1);
    expect(result.away.matchesPlayed).toBe(1);
  });

  it("leaves equal ratings unchanged after a draw between them", () => {
    const result = applyMatchResult({ rating: 1500, matchesPlayed: 3 }, { rating: 1500, matchesPlayed: 5 }, 1, 1);
    expect(result.home.rating).toBeCloseTo(1500, 9);
    expect(result.away.rating).toBeCloseTo(1500, 9);
  });

  it("moves an underdog's win by more than a favourite's expected win", () => {
    const underdogWin = applyMatchResult({ rating: 1400, matchesPlayed: 0 }, { rating: 1600, matchesPlayed: 0 }, 1, 0);
    const favouriteWin = applyMatchResult({ rating: 1600, matchesPlayed: 0 }, { rating: 1400, matchesPlayed: 0 }, 1, 0);
    const underdogGain = underdogWin.home.rating - 1400;
    const favouriteGain = favouriteWin.home.rating - 1600;
    expect(underdogGain).toBeGreaterThan(favouriteGain);
  });
});

describe("computeCurrentEloRatings", () => {
  it("replays fixtures in chronological (kickoff_utc) order, not insertion/array order", async () => {
    const fake = new FakeSupabase();
    // Same two teams play twice with symmetric, opposite-direction 3-0
    // results. Seeded in REVERSE chronological order deliberately — if the
    // job used array order instead of kickoff_utc, the final ratings would
    // land on the opposite side of 1500 from what's asserted below.
    fake.seed("fixtures", [
      finishedFixture("fx-2", "2027-01-02T00:00:00.000Z", "team-b", "team-a", 3, 0), // B beats A, second match
      finishedFixture("fx-1", "2027-01-01T00:00:00.000Z", "team-a", "team-b", 3, 0) // A beats B, first match
    ]);

    await computeCurrentEloRatings(fakeClient(fake), silentLogger);

    const ratings = fake.rows("team_elo_ratings");
    const byTeam = new Map(ratings.map((r) => [r.team_id as string, r]));

    // Correct chronological replay: A wins first (small gain), then loses
    // as the new favourite (bigger loss) -> A ends up just BELOW 1500, B
    // just ABOVE. Reversed replay would put A above and B below.
    expect((byTeam.get("team-a")!.rating as number)).toBeLessThan(1500);
    expect((byTeam.get("team-b")!.rating as number)).toBeGreaterThan(1500);
    expect(byTeam.get("team-a")!.matches_played).toBe(2);
    expect(byTeam.get("team-b")!.matches_played).toBe(2);
  });

  it("excludes synthetic and unfinished fixtures from the replay", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      finishedFixture("fx-1", "2027-01-01T00:00:00.000Z", "team-a", "team-b", 2, 0),
      { ...finishedFixture("fx-synth", "2027-01-02T00:00:00.000Z", "team-a", "team-c", 10, 0), is_synthetic: true },
      { ...finishedFixture("fx-scheduled", "2027-01-03T00:00:00.000Z", "team-a", "team-d", 5, 0), status: "scheduled" }
    ]);

    await computeCurrentEloRatings(fakeClient(fake), silentLogger);

    const ratings = fake.rows("team_elo_ratings");
    const teamIds = new Set(ratings.map((r) => r.team_id));
    expect(teamIds).toEqual(new Set(["team-a", "team-b"]));
  });

  it("writes a succeeded ingestion_runs row", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [finishedFixture("fx-1", "2027-01-01T00:00:00.000Z", "team-a", "team-b", 1, 0)]);

    const result = await computeCurrentEloRatings(fakeClient(fake), silentLogger);

    const runs = fake.rows("ingestion_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job_name: "compute_elo_ratings", status: "succeeded" });
    expect(result.teamsRated).toBe(2);
    expect(result.matchesReplayed).toBe(1);
  });

  it("re-running updates existing ratings in place rather than duplicating rows", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [finishedFixture("fx-1", "2027-01-01T00:00:00.000Z", "team-a", "team-b", 1, 0)]);
    await computeCurrentEloRatings(fakeClient(fake), silentLogger);

    fake.seed("fixtures", [
      finishedFixture("fx-1", "2027-01-01T00:00:00.000Z", "team-a", "team-b", 1, 0),
      finishedFixture("fx-2", "2027-01-02T00:00:00.000Z", "team-a", "team-b", 0, 1)
    ]);
    await computeCurrentEloRatings(fakeClient(fake), silentLogger);

    const ratings = fake.rows("team_elo_ratings");
    expect(ratings).toHaveLength(2); // one row per team, updated not duplicated
    const teamA = ratings.find((r) => r.team_id === "team-a")!;
    expect(teamA.matches_played).toBe(2);
  });
});

describe("getTeamElo", () => {
  it("returns the default rating with computed: false when no row exists", async () => {
    const fake = new FakeSupabase();
    const result = await getTeamElo(fakeClient(fake), "team-unrated");
    expect(result).toEqual({ rating: DEFAULT_RATING, matchesPlayed: 0, computed: false });
  });

  it("returns the real rating with computed: true when a row exists", async () => {
    const fake = new FakeSupabase();
    fake.seed("team_elo_ratings", [{ id: "er-1", team_id: "team-a", rating: 1587.3, matches_played: 12 }]);
    const result = await getTeamElo(fakeClient(fake), "team-a");
    expect(result).toEqual({ rating: 1587.3, matchesPlayed: 12, computed: true });
  });
});
