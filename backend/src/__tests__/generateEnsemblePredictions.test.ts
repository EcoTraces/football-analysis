import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  computeRecentForm,
  countKeyAbsences,
  generateEnsemblePredictionsForUpcomingFixtures,
  getInjuriesSyncFreshness,
  getLatestOddsTriple
} from "../jobs/generateEnsemblePredictions.js";
import type { EnsemblePredictResponse, PoissonPredictionResponse, PredictionClient } from "../services/predictionClient.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function poissonResponse(dataQuality: "insufficient" | "limited" | "strong" = "strong"): PoissonPredictionResponse {
  return {
    modelName: "poisson-baseline",
    modelVersion: "0.1.0",
    dataQuality,
    predictions: [
      { market: "1x2", selection: "home", probability: 0.5, factors: [] },
      { market: "1x2", selection: "draw", probability: 0.25, factors: [] },
      { market: "1x2", selection: "away", probability: 0.25, factors: [] }
    ]
  };
}

function ensembleResponse(overrides: Partial<EnsemblePredictResponse> = {}): EnsemblePredictResponse {
  return {
    modelName: "ensemble",
    modelVersion: "0.1.0",
    market: "1x2",
    dataQuality: "strong",
    consensusLevel: "high",
    componentWeightsUsed: { poisson: 1 },
    missingComponents: [],
    selections: [
      { selection: "home", probability: 0.5, ev: null, edgePct: null, selectionScore: 60, riskTier: "strong", factors: [] },
      { selection: "draw", probability: 0.25, ev: null, edgePct: null, selectionScore: 40, riskTier: "medium", factors: [] },
      { selection: "away", probability: 0.25, ev: null, edgePct: null, selectionScore: 30, riskTier: "high_risk", factors: [] }
    ],
    ...overrides
  };
}

function upcomingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "fx-1",
    season_id: "season-1",
    competition_id: "comp-1",
    home_team_id: "team-home",
    away_team_id: "team-away",
    status: "scheduled",
    is_synthetic: false,
    kickoff_utc: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides
  };
}

function currentPoissonPredictionRows() {
  return [
    { id: "p-home", fixture_id: "fx-1", model_version_id: "mv-poisson", market: "1x2", selection: "home", probability: 0.5, data_quality: "strong", superseded_at: null },
    { id: "p-draw", fixture_id: "fx-1", model_version_id: "mv-poisson", market: "1x2", selection: "draw", probability: 0.25, data_quality: "strong", superseded_at: null },
    { id: "p-away", fixture_id: "fx-1", model_version_id: "mv-poisson", market: "1x2", selection: "away", probability: 0.25, data_quality: "strong", superseded_at: null }
  ];
}

describe("generateEnsemblePredictionsForUpcomingFixtures", () => {
  it("skips everything and warns when no competitions are allowlisted", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [upcomingFixture()]);
    const predictEnsemble = vi.fn();
    const client = { predictEnsemble } as unknown as PredictionClient;

    const result = await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(predictEnsemble).not.toHaveBeenCalled();
  });

  it("combines whichever components are available (poisson + elo here), reports the rest missing, and writes ensemble_predictions", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    fake.seed("predictions", currentPoissonPredictionRows());
    fake.seed("team_elo_ratings", [
      { id: "er-home", team_id: "team-home", rating: 1600, matches_played: 20 },
      { id: "er-away", team_id: "team-away", rating: 1450, matches_played: 18 }
    ]);
    // No team_statistics (home/away scope), no fixture history (form), no
    // injuries sync run, no odds — those four components stay absent.

    const predictElo = vi.fn().mockResolvedValue(poissonResponse("strong"));
    const predictEnsemble = vi.fn().mockResolvedValue(
      ensembleResponse({ missingComponents: ["form", "home_away", "injuries", "market"] })
    );
    const client = { predictElo, predictPoisson: vi.fn(), predictEnsemble } as unknown as PredictionClient;

    const result = await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    expect(result).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(predictElo).toHaveBeenCalledWith({
      homeTeam: { rating: 1600, matchesPlayed: 20 },
      awayTeam: { rating: 1450, matchesPlayed: 18 }
    });

    const ensembleCall = predictEnsemble.mock.calls[0]?.[0];
    expect(Object.keys(ensembleCall.components).sort()).toEqual(["elo", "poisson"]);
    expect(ensembleCall.decimalOdds).toBeUndefined();
    expect(ensembleCall.homeKeyAbsences).toBeUndefined();

    const rows = fake.rows("ensemble_predictions");
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.selection === "home")).toMatchObject({
      fixture_id: "fx-1",
      ensemble_version_id: "mv-ensemble",
      market: "1x2",
      combined_probability: 0.5,
      selection_score: 60,
      risk_tier: "strong",
      missing_components: ["form", "home_away", "injuries", "market"]
    });
  });

  it("skips a fixture entirely (never calling predictEnsemble) when zero components are available", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    // No current poisson prediction, no Elo ratings, no stats, no history, no odds.

    const predictElo = vi.fn().mockResolvedValue(null);
    const predictEnsemble = vi.fn();
    const client = { predictElo, predictPoisson: vi.fn(), predictEnsemble } as unknown as PredictionClient;

    const result = await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    expect(result).toEqual({ processed: 0, skipped: 1, failed: 0 });
    expect(predictEnsemble).not.toHaveBeenCalled();
  });

  it("supersedes the previous current ensemble_predictions rows for a fixture rather than duplicating them", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    fake.seed("predictions", currentPoissonPredictionRows());
    fake.seed("ensemble_predictions", [
      { id: "old-home", fixture_id: "fx-1", ensemble_version_id: "mv-old", market: "1x2", selection: "home", combined_probability: 0.4, superseded_at: null }
    ]);

    const client = { predictElo: vi.fn().mockResolvedValue(null), predictPoisson: vi.fn(), predictEnsemble: vi.fn().mockResolvedValue(ensembleResponse()) } as unknown as PredictionClient;

    await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    const rows = fake.rows("ensemble_predictions");
    // New rows omit superseded_at entirely (same as predictions/insert in
    // generatePredictions.ts), relying on the real DB's column default —
    // the in-memory fake doesn't apply that default, so "current" here
    // means falsy (undefined or null), not strictly `=== null`.
    const current = rows.filter((r) => !r.superseded_at);
    expect(current).toHaveLength(3); // the three new rows
    expect(rows.find((r) => r.id === "old-home")!.superseded_at).toBeTruthy();
  });

  it("includes the market component with real odds when one bookmaker has a complete, fresh 1x2 triple", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    fake.seed("predictions", currentPoissonPredictionRows());
    const now = new Date().toISOString();
    fake.seed("odds_snapshots", [
      { id: "o1", fixture_id: "fx-1", bookmaker: "bookmaker-a", market: "1x2", selection: "home", decimal_odds: 2.1, captured_at: now },
      { id: "o2", fixture_id: "fx-1", bookmaker: "bookmaker-a", market: "1x2", selection: "draw", decimal_odds: 3.4, captured_at: now },
      { id: "o3", fixture_id: "fx-1", bookmaker: "bookmaker-a", market: "1x2", selection: "away", decimal_odds: 3.6, captured_at: now }
    ]);

    const predictEnsemble = vi.fn().mockResolvedValue(ensembleResponse());
    const client = { predictElo: vi.fn().mockResolvedValue(null), predictPoisson: vi.fn(), predictEnsemble } as unknown as PredictionClient;

    await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    const call = predictEnsemble.mock.calls[0]?.[0];
    expect(call.decimalOdds).toEqual({ home: 2.1, draw: 3.4, away: 3.6 });

    const rows = fake.rows("ensemble_predictions");
    expect(rows.find((r) => r.selection === "home")).toMatchObject({ best_odds: 2.1, best_bookmaker: "bookmaker-a" });
  });

  it("includes the injuries component only when sync_injuries has run recently", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    fake.seed("predictions", currentPoissonPredictionRows());
    fake.seed("ingestion_runs", [
      { id: "run-1", job_name: "sync_injuries", status: "succeeded", finished_at: new Date().toISOString() }
    ]);
    fake.seed("injuries", [{ id: "inj-1", player_id: "player-1", team_id: "team-home", status: "injured" }]);
    fake.seed("player_statistics", [
      { id: "ps-1", player_id: "player-1", team_id: "team-home", season_id: "season-1", player_name: "Star Striker", goals_scored: 15, matches_played: 20 },
      { id: "ps-2", player_id: "player-2", team_id: "team-home", season_id: "season-1", player_name: "Midfielder", goals_scored: 3, matches_played: 15 },
      { id: "ps-3", player_id: "player-3", team_id: "team-home", season_id: "season-1", player_name: "Backup", goals_scored: 1, matches_played: 8 }
    ]);

    const predictEnsemble = vi.fn().mockResolvedValue(ensembleResponse());
    const client = { predictElo: vi.fn().mockResolvedValue(null), predictPoisson: vi.fn(), predictEnsemble } as unknown as PredictionClient;

    await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    const call = predictEnsemble.mock.calls[0]?.[0];
    expect(call.homeKeyAbsences).toBe(1); // the injured player scores above the 1-player-team's own median
    expect(call.awayKeyAbsences).toBe(0);
  });

  it("omits the injuries component entirely when sync_injuries has never run", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: true }]);
    fake.seed("fixtures", [upcomingFixture()]);
    fake.seed("predictions", currentPoissonPredictionRows());

    const predictEnsemble = vi.fn().mockResolvedValue(ensembleResponse());
    const client = { predictElo: vi.fn().mockResolvedValue(null), predictPoisson: vi.fn(), predictEnsemble } as unknown as PredictionClient;

    await generateEnsemblePredictionsForUpcomingFixtures(fakeClient(fake), client, "mv-ensemble", silentLogger);

    const call = predictEnsemble.mock.calls[0]?.[0];
    expect(call.homeKeyAbsences).toBeUndefined();
    expect(call.awayKeyAbsences).toBeUndefined();
  });
});

describe("computeRecentForm", () => {
  it("only averages the most recent windowMatches finished fixtures strictly before kickoff", async () => {
    const fake = new FakeSupabase();
    const base = new Date("2027-01-10T00:00:00.000Z").getTime();
    fake.seed("fixtures", [
      { id: "old-1", home_team_id: "team-a", away_team_id: "team-x", home_score: 5, away_score: 0, status: "finished", is_synthetic: false, kickoff_utc: new Date(base - 20 * 86_400_000).toISOString() }, // outside the window
      { id: "r-1", home_team_id: "team-a", away_team_id: "team-x", home_score: 1, away_score: 0, status: "finished", is_synthetic: false, kickoff_utc: new Date(base - 4 * 86_400_000).toISOString() },
      { id: "r-2", home_team_id: "team-x", away_team_id: "team-a", home_score: 0, away_score: 1, status: "finished", is_synthetic: false, kickoff_utc: new Date(base - 3 * 86_400_000).toISOString() },
      { id: "r-3", home_team_id: "team-a", away_team_id: "team-x", home_score: 1, away_score: 0, status: "finished", is_synthetic: false, kickoff_utc: new Date(base - 2 * 86_400_000).toISOString() }
    ]);

    const result = await computeRecentForm(fakeClient(fake), "team-a", new Date(base).toISOString(), 3);

    expect(result).toEqual({ matchesPlayed: 3, goalsScoredAvg: 1, goalsConcededAvg: 0 });
  });

  it("returns null when the team has no finished prior fixtures", async () => {
    const result = await computeRecentForm(fakeClient(new FakeSupabase()), "team-a", new Date().toISOString());
    expect(result).toBeNull();
  });
});

describe("getInjuriesSyncFreshness", () => {
  it("returns UNAVAILABLE when sync_injuries has never run", async () => {
    expect(await getInjuriesSyncFreshness(fakeClient(new FakeSupabase()))).toBe("UNAVAILABLE");
  });

  it("returns LIVE for a very recent successful run", async () => {
    const fake = new FakeSupabase();
    fake.seed("ingestion_runs", [{ id: "r1", job_name: "sync_injuries", status: "succeeded", finished_at: new Date().toISOString() }]);
    expect(await getInjuriesSyncFreshness(fakeClient(fake))).toBe("LIVE");
  });

  it("ignores a failed run and reports UNAVAILABLE", async () => {
    const fake = new FakeSupabase();
    fake.seed("ingestion_runs", [{ id: "r1", job_name: "sync_injuries", status: "failed", finished_at: new Date().toISOString() }]);
    expect(await getInjuriesSyncFreshness(fakeClient(fake))).toBe("UNAVAILABLE");
  });
});

describe("countKeyAbsences", () => {
  it("counts only flagged players scoring above the team's own median", async () => {
    const fake = new FakeSupabase();
    fake.seed("injuries", [
      { id: "i1", player_id: "p-star", team_id: "team-a", status: "injured" },
      { id: "i2", player_id: "p-bench", team_id: "team-a", status: "doubtful" },
      { id: "i3", player_id: "p-other", team_id: "team-a", status: "returned" } // not a key-absence status
    ]);
    fake.seed("player_statistics", [
      { id: "ps1", player_id: "p-star", team_id: "team-a", season_id: "season-1", goals_scored: 18, matches_played: 20 },
      { id: "ps2", player_id: "p-bench", team_id: "team-a", season_id: "season-1", goals_scored: 0, matches_played: 5 },
      { id: "ps3", player_id: "p-mid", team_id: "team-a", season_id: "season-1", goals_scored: 4, matches_played: 20 }
    ]);

    const count = await countKeyAbsences(fakeClient(fake), "team-a", "season-1");
    expect(count).toBe(1); // only p-star (18) is above the median of [0, 4, 18] = 4
  });

  it("returns 0 when no injuries are flagged for the team", async () => {
    expect(await countKeyAbsences(fakeClient(new FakeSupabase()), "team-a", "season-1")).toBe(0);
  });
});

describe("getLatestOddsTriple", () => {
  it("returns null when no single bookmaker has all three selections", async () => {
    const fake = new FakeSupabase();
    fake.seed("odds_snapshots", [
      { id: "o1", fixture_id: "fx-1", bookmaker: "book-a", market: "1x2", selection: "home", decimal_odds: 2.0, captured_at: new Date().toISOString() }
      // book-a is missing draw/away
    ]);
    expect(await getLatestOddsTriple(fakeClient(fake), "fx-1")).toBeNull();
  });

  it("prefers the bookmaker whose complete triple was captured most recently", async () => {
    const fake = new FakeSupabase();
    const older = new Date(Date.now() - 3600_000).toISOString();
    const newer = new Date().toISOString();
    fake.seed("odds_snapshots", [
      { id: "a1", fixture_id: "fx-1", bookmaker: "book-old", market: "1x2", selection: "home", decimal_odds: 1.9, captured_at: older },
      { id: "a2", fixture_id: "fx-1", bookmaker: "book-old", market: "1x2", selection: "draw", decimal_odds: 3.2, captured_at: older },
      { id: "a3", fixture_id: "fx-1", bookmaker: "book-old", market: "1x2", selection: "away", decimal_odds: 4.0, captured_at: older },
      { id: "b1", fixture_id: "fx-1", bookmaker: "book-new", market: "1x2", selection: "home", decimal_odds: 2.1, captured_at: newer },
      { id: "b2", fixture_id: "fx-1", bookmaker: "book-new", market: "1x2", selection: "draw", decimal_odds: 3.4, captured_at: newer },
      { id: "b3", fixture_id: "fx-1", bookmaker: "book-new", market: "1x2", selection: "away", decimal_odds: 3.6, captured_at: newer }
    ]);

    const result = await getLatestOddsTriple(fakeClient(fake), "fx-1");
    expect(result).toMatchObject({ home: 2.1, draw: 3.4, away: 3.6, bookmaker: "book-new" });
  });
});
