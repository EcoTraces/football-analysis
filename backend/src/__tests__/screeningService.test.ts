import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { getMatchesToAvoid, getTop20 } from "../services/screeningService.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedFixtureContext(fake: FakeSupabase) {
  fake.seed("fixtures", [
    { id: "fx-1", competition_id: "comp-1", home_team_id: "team-a", away_team_id: "team-b", kickoff_utc: "2027-01-01T15:00:00.000Z" },
    { id: "fx-2", competition_id: "comp-1", home_team_id: "team-c", away_team_id: "team-d", kickoff_utc: "2027-01-02T15:00:00.000Z" }
  ]);
  fake.seed("competitions", [{ id: "comp-1", name: "Premier League" }]);
  fake.seed("teams", [
    { id: "team-a", name: "Team A" },
    { id: "team-b", name: "Team B" },
    { id: "team-c", name: "Team C" },
    { id: "team-d", name: "Team D" }
  ]);
}

function ensembleRow(overrides: Record<string, unknown>) {
  return {
    id: `ep-${Math.random()}`,
    fixture_id: "fx-1",
    market: "1x2",
    selection: "home",
    combined_probability: 0.5,
    consensus_level: "high",
    selection_score: 70,
    risk_tier: "strong",
    ev: 0.05,
    edge_pct: 3,
    best_odds: 2.0,
    best_bookmaker: "book-a",
    data_quality: "strong",
    missing_components: [],
    factors: [],
    generated_at: "2027-01-01T00:00:00.000Z",
    superseded_at: null,
    ...overrides
  };
}

describe("getTop20", () => {
  it("returns one entry per fixture: only its single highest-scoring selection", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [
      ensembleRow({ id: "ep-1", fixture_id: "fx-1", selection: "home", selection_score: 70, risk_tier: "strong" }),
      ensembleRow({ id: "ep-2", fixture_id: "fx-1", selection: "draw", selection_score: 40, risk_tier: "medium" }),
      ensembleRow({ id: "ep-3", fixture_id: "fx-1", selection: "away", selection_score: 20, risk_tier: "high_risk" })
    ]);

    const result = await getTop20(fakeClient(fake));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fixtureId: "fx-1", selection: "home", selectionScore: 70 });
  });

  it("ranks fixtures by their best selection's score, enriched with names", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [
      ensembleRow({ id: "ep-1", fixture_id: "fx-1", selection: "home", selection_score: 55, risk_tier: "strong" }),
      ensembleRow({ id: "ep-2", fixture_id: "fx-2", selection: "away", selection_score: 88, risk_tier: "elite" })
    ]);

    const result = await getTop20(fakeClient(fake));

    expect(result.map((r) => r.fixtureId)).toEqual(["fx-2", "fx-1"]); // higher score first
    expect(result[0]).toMatchObject({
      competitionName: "Premier League",
      homeTeamName: "Team C",
      awayTeamName: "Team D",
      kickoffUtc: "2027-01-02T15:00:00.000Z"
    });
  });

  it("excludes avoid-tier selections entirely", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [ensembleRow({ id: "ep-1", fixture_id: "fx-1", risk_tier: "avoid", selection_score: 10 })]);

    const result = await getTop20(fakeClient(fake));
    expect(result).toHaveLength(0);
  });

  it("excludes superseded rows", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [ensembleRow({ id: "ep-old", fixture_id: "fx-1", superseded_at: "2027-01-01T00:00:00.000Z" })]);

    const result = await getTop20(fakeClient(fake));
    expect(result).toHaveLength(0);
  });

  it("caps results at the given limit", async () => {
    const fake = new FakeSupabase();
    fake.seed(
      "fixtures",
      Array.from({ length: 3 }, (_, i) => ({
        id: `fx-${i}`,
        competition_id: "comp-1",
        home_team_id: "team-a",
        away_team_id: "team-b",
        kickoff_utc: "2027-01-01T00:00:00.000Z"
      }))
    );
    fake.seed("competitions", [{ id: "comp-1", name: "Premier League" }]);
    fake.seed("teams", [{ id: "team-a", name: "Team A" }, { id: "team-b", name: "Team B" }]);
    fake.seed(
      "ensemble_predictions",
      Array.from({ length: 3 }, (_, i) => ensembleRow({ id: `ep-${i}`, fixture_id: `fx-${i}`, selection_score: 50 + i }))
    );

    const result = await getTop20(fakeClient(fake), 2);
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when nothing has been generated yet", async () => {
    const result = await getTop20(fakeClient(new FakeSupabase()));
    expect(result).toEqual([]);
  });
});

describe("getMatchesToAvoid", () => {
  it("flags avoid and high_risk tiers, conflicting consensus, and insufficient data", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [
      ensembleRow({ id: "ep-avoid", fixture_id: "fx-1", risk_tier: "avoid" }),
      ensembleRow({ id: "ep-highrisk", fixture_id: "fx-1", risk_tier: "high_risk" }),
      ensembleRow({ id: "ep-conflicting", fixture_id: "fx-2", risk_tier: "medium", consensus_level: "conflicting" }),
      ensembleRow({ id: "ep-insufficient", fixture_id: "fx-2", risk_tier: "medium", consensus_level: "high", data_quality: "insufficient" }),
      ensembleRow({ id: "ep-fine", fixture_id: "fx-1", risk_tier: "elite", consensus_level: "high", data_quality: "strong" })
    ]);

    const result = await getMatchesToAvoid(fakeClient(fake));

    expect(result.map((r) => r.id).sort()).toEqual(["ep-avoid", "ep-conflicting", "ep-highrisk", "ep-insufficient"].sort());
    expect(result.some((r) => r.id === "ep-fine")).toBe(false);
  });

  it("returns an empty array when nothing is flagged", async () => {
    const fake = new FakeSupabase();
    seedFixtureContext(fake);
    fake.seed("ensemble_predictions", [ensembleRow({ id: "ep-fine", risk_tier: "elite", consensus_level: "high", data_quality: "strong" })]);

    const result = await getMatchesToAvoid(fakeClient(fake));
    expect(result).toEqual([]);
  });
});
