import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  buildAccumulatorRecommendations,
  loadAccumulatorCandidatePool,
  riskTierForScore,
  selectAccumulatorLegs,
  type AccumulatorCandidate
} from "../jobs/buildAccumulators.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

const RISK_THRESHOLDS = { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 };

function candidate(overrides: Partial<AccumulatorCandidate> & { fixtureId: string }): AccumulatorCandidate {
  return {
    ensemblePredictionId: `ep-${overrides.fixtureId}`,
    homeTeamId: `home-${overrides.fixtureId}`,
    awayTeamId: `away-${overrides.fixtureId}`,
    market: "1x2",
    selection: "home",
    selectionScore: 80,
    probability: 0.6,
    decimalOdds: 1.5,
    ...overrides
  };
}

describe("riskTierForScore", () => {
  it("applies the same 5-tier ladder as ml-service's ensemble.risk_tier", () => {
    expect(riskTierForScore(90, RISK_THRESHOLDS)).toBe("elite");
    expect(riskTierForScore(75, RISK_THRESHOLDS)).toBe("strong");
    expect(riskTierForScore(55, RISK_THRESHOLDS)).toBe("medium");
    expect(riskTierForScore(35, RISK_THRESHOLDS)).toBe("high_risk");
    expect(riskTierForScore(10, RISK_THRESHOLDS)).toBe("avoid");
  });
});

describe("selectAccumulatorLegs", () => {
  it("returns null when there are fewer eligible legs than the target's minimum", () => {
    const candidates = [candidate({ fixtureId: "fx-1" }), candidate({ fixtureId: "fx-2" })];
    // Target 5 needs at least 4 legs.
    expect(selectAccumulatorLegs(candidates, 5, 50)).toBeNull();
  });

  it("excludes candidates below the minimum selection score", () => {
    const candidates = [
      candidate({ fixtureId: "fx-1", selectionScore: 90 }),
      candidate({ fixtureId: "fx-2", selectionScore: 90 }),
      candidate({ fixtureId: "fx-3", selectionScore: 90 }),
      candidate({ fixtureId: "fx-4", selectionScore: 90 }),
      candidate({ fixtureId: "fx-5", selectionScore: 10 }) // below the floor
    ];
    const result = selectAccumulatorLegs(candidates, 5, 50);
    expect(result).not.toBeNull();
    expect(result!.legs.every((l) => l.selectionScore >= 50)).toBe(true);
    expect(result!.legs.find((l) => l.fixtureId === "fx-5")).toBeUndefined();
  });

  it("stops adding legs once the target's odds band is reached, without overshooting into weaker legs", () => {
    // Four legs at 1.6 odds each already multiply to ~6.55 >= target 5 —
    // a fifth (weaker) candidate must not be pulled in just to hit range.max.
    const candidates = [
      candidate({ fixtureId: "fx-1", selectionScore: 90, decimalOdds: 1.6 }),
      candidate({ fixtureId: "fx-2", selectionScore: 89, decimalOdds: 1.6 }),
      candidate({ fixtureId: "fx-3", selectionScore: 88, decimalOdds: 1.6 }),
      candidate({ fixtureId: "fx-4", selectionScore: 87, decimalOdds: 1.6 }),
      candidate({ fixtureId: "fx-5", selectionScore: 50, decimalOdds: 1.2 })
    ];
    const result = selectAccumulatorLegs(candidates, 5, 50);
    expect(result!.legs).toHaveLength(4);
    expect(result!.combinedDecimalOdds).toBeCloseTo(1.6 ** 4, 6);
  });

  it("computes combined probability/odds as the product across legs", () => {
    const candidates = [
      candidate({ fixtureId: "fx-1", probability: 0.5, decimalOdds: 2.0 }),
      candidate({ fixtureId: "fx-2", probability: 0.5, decimalOdds: 2.0 }),
      candidate({ fixtureId: "fx-3", probability: 0.5, decimalOdds: 2.0 }),
      candidate({ fixtureId: "fx-4", probability: 0.5, decimalOdds: 2.0 })
    ];
    const result = selectAccumulatorLegs(candidates, 5, 50);
    expect(result!.combinedProbability).toBeCloseTo(0.0625, 6); // 0.5^4
    expect(result!.combinedDecimalOdds).toBeCloseTo(16, 6); // 2^4
  });

  it("applies a correlation penalty when legs share a team, and none when they don't", () => {
    const sharedTeamCandidates = [
      candidate({ fixtureId: "fx-1", homeTeamId: "team-x", awayTeamId: "team-y" }),
      candidate({ fixtureId: "fx-2", homeTeamId: "team-x", awayTeamId: "team-z" }), // shares team-x
      candidate({ fixtureId: "fx-3" }),
      candidate({ fixtureId: "fx-4" })
    ];
    const diversifiedCandidates = [
      candidate({ fixtureId: "fx-1" }),
      candidate({ fixtureId: "fx-2" }),
      candidate({ fixtureId: "fx-3" }),
      candidate({ fixtureId: "fx-4" })
    ];

    const withOverlap = selectAccumulatorLegs(sharedTeamCandidates, 5, 50)!;
    const withoutOverlap = selectAccumulatorLegs(diversifiedCandidates, 5, 50)!;

    expect(withOverlap.correlationPenalty).toBeGreaterThan(0);
    expect(withoutOverlap.correlationPenalty).toBe(0);
    expect(withOverlap.compositeScore).toBeLessThan(withoutOverlap.compositeScore);
  });

  it("never picks two legs from the same fixture, even if the pool wasn't already deduped", () => {
    // Low odds keep combined odds well under the target-5 odds band even
    // after 4 legs, so the loop must actually walk through (and skip) the
    // fx-1 duplicate instead of stopping before ever reaching it.
    const candidates = [
      candidate({ fixtureId: "fx-1", selectionScore: 95, decimalOdds: 1.05 }),
      candidate({ fixtureId: "fx-1", selectionScore: 94, decimalOdds: 1.05 }), // a second selection for the same fixture
      candidate({ fixtureId: "fx-2", decimalOdds: 1.05 }),
      candidate({ fixtureId: "fx-3", decimalOdds: 1.05 }),
      candidate({ fixtureId: "fx-4", decimalOdds: 1.05 })
    ];
    const result = selectAccumulatorLegs(candidates, 5, 50);
    const fixtureIds = result!.legs.map((l) => l.fixtureId);
    expect(fixtureIds).toHaveLength(4);
    expect(new Set(fixtureIds).size).toBe(4);
  });
});

describe("loadAccumulatorCandidatePool", () => {
  it("only includes rows with real odds, excluding avoid-tier and odds-less rows", async () => {
    const fake = new FakeSupabase();
    fake.seed("ensemble_predictions", [
      { id: "ep-1", fixture_id: "fx-1", market: "1x2", selection: "home", combined_probability: 0.6, selection_score: 80, risk_tier: "strong", best_odds: 1.8, superseded_at: null },
      { id: "ep-2", fixture_id: "fx-2", market: "1x2", selection: "home", combined_probability: 0.5, selection_score: 60, risk_tier: "medium", best_odds: null, superseded_at: null }, // no odds
      { id: "ep-3", fixture_id: "fx-3", market: "1x2", selection: "home", combined_probability: 0.3, selection_score: 20, risk_tier: "avoid", best_odds: 3.0, superseded_at: null } // avoid tier
    ]);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-a", away_team_id: "team-b" },
      { id: "fx-2", home_team_id: "team-c", away_team_id: "team-d" },
      { id: "fx-3", home_team_id: "team-e", away_team_id: "team-f" }
    ]);

    const pool = await loadAccumulatorCandidatePool(fakeClient(fake));
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({ fixtureId: "fx-1", decimalOdds: 1.8 });
  });

  it("keeps only the highest-scoring selection per fixture", async () => {
    const fake = new FakeSupabase();
    fake.seed("ensemble_predictions", [
      { id: "ep-1", fixture_id: "fx-1", market: "1x2", selection: "home", combined_probability: 0.5, selection_score: 60, risk_tier: "medium", best_odds: 2.0, superseded_at: null },
      { id: "ep-2", fixture_id: "fx-1", market: "1x2", selection: "away", combined_probability: 0.3, selection_score: 85, risk_tier: "elite", best_odds: 3.5, superseded_at: null }
    ]);
    fake.seed("fixtures", [{ id: "fx-1", home_team_id: "team-a", away_team_id: "team-b" }]);

    const pool = await loadAccumulatorCandidatePool(fakeClient(fake));
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({ selection: "away", selectionScore: 85 });
  });
});

describe("buildAccumulatorRecommendations", () => {
  it("writes nothing and logs a warning when no target has enough qualifying legs", async () => {
    const fake = new FakeSupabase();
    // No ensemble_predictions at all.
    const result = await buildAccumulatorRecommendations(fakeClient(fake), silentLogger);

    expect(result.targetsBuilt).toBe(0);
    expect(fake.rows("accumulator_recommendations")).toHaveLength(0);
    expect(fake.rows("ingestion_runs")[0]).toMatchObject({ job_name: "build_accumulators" });
  });

  it("builds a recommendation for a target with enough real, priced legs and flags the single best overall", async () => {
    const fake = new FakeSupabase();
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `ep-${i}`,
      fixture_id: `fx-${i}`,
      market: "1x2",
      selection: "home",
      combined_probability: 0.6,
      selection_score: 90 - i,
      risk_tier: "strong",
      best_odds: 1.6,
      superseded_at: null
    }));
    fake.seed("ensemble_predictions", rows);
    fake.seed(
      "fixtures",
      rows.map((r) => ({ id: r.fixture_id, home_team_id: `home-${r.fixture_id}`, away_team_id: `away-${r.fixture_id}` }))
    );
    // Only accumulator_targets(5) is enabled — its default min_selection_score (60) is well below all seeded scores.
    fake.seed("accumulator_targets", [
      { id: "at-5", legs: 5, min_selection_score: 60, enabled: true },
      { id: "at-7", legs: 7, min_selection_score: 60, enabled: false }
    ]);

    const result = await buildAccumulatorRecommendations(fakeClient(fake), silentLogger);

    expect(result.targetsBuilt).toBe(1);
    expect(result.targetsSkipped).toBe(0); // the disabled target-7 isn't counted as "skipped"

    const recRows = fake.rows("accumulator_recommendations").filter((r) => !r.superseded_at);
    expect(recRows).toHaveLength(1);
    expect(recRows[0]).toMatchObject({ target_legs: 5, is_best_overall: true });
    expect((recRows[0]!.leg_selections as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  it("supersedes prior current recommendations rather than duplicating them", async () => {
    const fake = new FakeSupabase();
    fake.seed("accumulator_recommendations", [
      { id: "old-1", target_legs: 5, leg_fixture_ids: [], leg_selections: [], combined_probability: 0.1, composite_score: 50, risk_tier: "medium", is_best_overall: false, superseded_at: null }
    ]);

    await buildAccumulatorRecommendations(fakeClient(fake), silentLogger);

    const rows = fake.rows("accumulator_recommendations");
    expect(rows.find((r) => r.id === "old-1")!.superseded_at).toBeTruthy();
  });
});
