import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import type { FakeRow } from "./testSupabaseFake.js";
import { computePointInTimeStrength, runBacktest, runLatestBacktestJob } from "../jobs/runBacktest.js";
import type { PoissonPredictionResponse, PredictionClient } from "../services/predictionClient.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function finishedFixture(overrides: Record<string, unknown> & { id: string }): FakeRow {
  return {
    season_id: "season-1",
    competition_id: "comp-1",
    status: "finished",
    is_synthetic: false,
    ...overrides
  };
}

describe("computePointInTimeStrength", () => {
  it("excludes a fixture at or after the target kickoff — a simultaneous result is not prior data either", async () => {
    const fake = new FakeSupabase();
    const target = "2024-03-10T15:00:00.000Z";
    fake.seed("fixtures", [
      // Strictly before target — included.
      finishedFixture({ id: "fx-1", home_team_id: "team-x", away_team_id: "opp", kickoff_utc: "2024-03-01T15:00:00.000Z", home_score: 2, away_score: 0 }),
      finishedFixture({ id: "fx-2", home_team_id: "opp", away_team_id: "team-x", kickoff_utc: "2024-03-05T15:00:00.000Z", home_score: 1, away_score: 1 }),
      // Exactly at the target kickoff — must be excluded (strict less-than).
      finishedFixture({ id: "fx-3", home_team_id: "team-x", away_team_id: "opp", kickoff_utc: target, home_score: 3, away_score: 3 }),
      // After the target — must be excluded.
      finishedFixture({ id: "fx-4", home_team_id: "team-x", away_team_id: "opp", kickoff_utc: "2024-03-15T15:00:00.000Z", home_score: 5, away_score: 0 })
    ]);

    const strength = await computePointInTimeStrength(fakeClient(fake), "team-x", target);

    expect(strength).not.toBeNull();
    // Only fx-1 (scored 2, conceded 0) and fx-2 (away leg: scored 1, conceded 1) count.
    expect(strength!.matchesPlayed).toBe(2);
    expect(strength!.goalsScoredAvg).toBeCloseTo(1.5); // (2 + 1) / 2
    expect(strength!.goalsConcededAvg).toBeCloseTo(0.5); // (0 + 1) / 2
  });

  it("returns null when the team has no prior finished, non-synthetic fixture", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      // Synthetic dev-seed data must never count toward a real backtest.
      finishedFixture({ id: "fx-1", home_team_id: "team-x", away_team_id: "opp", kickoff_utc: "2024-01-01T00:00:00.000Z", home_score: 1, away_score: 0, is_synthetic: true })
    ]);

    const strength = await computePointInTimeStrength(fakeClient(fake), "team-x", "2024-03-10T15:00:00.000Z");
    expect(strength).toBeNull();
  });
});

function priorHistoryFixtures(teamId: string, opponentId: string, count: number, beforeIso: string) {
  const base = new Date(beforeIso).getTime();
  // Offset well outside the test's backtest [from, to] window (which starts
  // at the 1st of the target's month) so these history fixtures are only
  // ever picked up by computePointInTimeStrength, never re-scored as their
  // own backtest targets.
  const daysOutsideWindow = 40;
  return Array.from({ length: count }, (_, i) => {
    const kickoff = new Date(base - (daysOutsideWindow + count - i) * 24 * 60 * 60 * 1000).toISOString();
    return finishedFixture({
      id: `hist-${teamId}-${i}`,
      home_team_id: teamId,
      away_team_id: opponentId,
      kickoff_utc: kickoff,
      home_score: 1,
      away_score: 1
    });
  });
}

describe("runBacktest", () => {
  it("scores the 1x2 market with correct accuracy/log-loss/Brier-score on known synthetic predictions and writes one model_evaluations row", async () => {
    const fake = new FakeSupabase();
    const kickoffA = "2024-03-10T15:00:00.000Z";
    const kickoffB = "2024-03-11T15:00:00.000Z";

    fake.seed("fixtures", [
      ...priorHistoryFixtures("team-a-home", "hist-opp", 3, kickoffA),
      ...priorHistoryFixtures("team-a-away", "hist-opp", 3, kickoffA),
      ...priorHistoryFixtures("team-b-home", "hist-opp", 3, kickoffB),
      ...priorHistoryFixtures("team-b-away", "hist-opp", 3, kickoffB),
      // Fixture A: home wins 2-0. Predicted probs (mocked below): home 0.6, draw 0.25, away 0.15 — argmax matches actual.
      finishedFixture({ id: "fx-a", home_team_id: "team-a-home", away_team_id: "team-a-away", kickoff_utc: kickoffA, home_score: 2, away_score: 0 }),
      // Fixture B: draw 1-1. Predicted probs: home 0.3, draw 0.3, away 0.4 — argmax (away) does NOT match actual (draw).
      finishedFixture({ id: "fx-b", home_team_id: "team-b-home", away_team_id: "team-b-away", kickoff_utc: kickoffB, home_score: 1, away_score: 1 })
    ]);

    const responseA: PoissonPredictionResponse = {
      modelName: "poisson-baseline",
      modelVersion: "0.1.0",
      dataQuality: "strong",
      predictions: [
        { market: "1x2", selection: "home", probability: 0.6, factors: [] },
        { market: "1x2", selection: "draw", probability: 0.25, factors: [] },
        { market: "1x2", selection: "away", probability: 0.15, factors: [] }
      ]
    };
    const responseB: PoissonPredictionResponse = {
      modelName: "poisson-baseline",
      modelVersion: "0.1.0",
      dataQuality: "strong",
      predictions: [
        { market: "1x2", selection: "home", probability: 0.3, factors: [] },
        { market: "1x2", selection: "draw", probability: 0.3, factors: [] },
        { market: "1x2", selection: "away", probability: 0.4, factors: [] }
      ]
    };
    const predictPoisson = vi.fn().mockResolvedValueOnce(responseA).mockResolvedValueOnce(responseB);
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    const result = await runBacktest(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(predictPoisson).toHaveBeenCalledTimes(2);
    expect(result.sampleSize).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.accuracy).toBeCloseTo(0.5); // 1 hit out of 2
    expect(result.logLoss).toBeCloseTo((-Math.log(0.6) - Math.log(0.3)) / 2);
    expect(result.brierScore).toBeCloseTo((0.245 + 0.74) / 2);
    expect(result.evaluationId).not.toBeNull();

    const evalRows = fake.rows("model_evaluations");
    expect(evalRows).toHaveLength(1);
    expect(evalRows[0]).toMatchObject({
      model_version_id: "mv-1",
      market: "1x2",
      evaluation_window: "2024-03-01T00:00:00.000Z..2024-03-31T23:59:59.000Z",
      sample_size: 2
    });
  });

  it("skips a fixture when either team has fewer than 3 point-in-time prior matches, and writes no row when nothing qualifies", async () => {
    const fake = new FakeSupabase();
    const kickoff = "2024-03-10T15:00:00.000Z";
    fake.seed("fixtures", [
      ...priorHistoryFixtures("team-home", "hist-opp", 2, kickoff), // below MIN_MATCHES_FOR_PREDICTION
      ...priorHistoryFixtures("team-away", "hist-opp", 3, kickoff),
      finishedFixture({ id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", kickoff_utc: kickoff, home_score: 1, away_score: 0 })
    ]);

    const predictPoisson = vi.fn();
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    const result = await runBacktest(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(predictPoisson).not.toHaveBeenCalled();
    expect(result).toEqual({ evaluationId: null, sampleSize: 0, skipped: 1, accuracy: null, logLoss: null, brierScore: null });
    expect(fake.rows("model_evaluations")).toHaveLength(0);
  });
});

describe("runLatestBacktestJob", () => {
  it("returns nulls without creating an ingestion_runs row when no poisson-baseline model_version exists yet", async () => {
    const fake = new FakeSupabase();
    const result = await runLatestBacktestJob(fakeClient(fake), "http://ml-service.invalid", silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(result.modelVersionId).toBeNull();
    expect(result.runId).toBeNull();
    expect(fake.rows("ingestion_runs")).toHaveLength(0);
  });
});
