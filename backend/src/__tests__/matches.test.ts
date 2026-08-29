import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMatchDetail } from "../routes/matches.js";
import { FakeSupabase } from "./testSupabaseFake.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

const FIXTURE_ID = "11111111-1111-1111-1111-111111111111";
const HOME_TEAM_ID = "22222222-2222-2222-2222-222222222222";
const AWAY_TEAM_ID = "33333333-3333-3333-3333-333333333333";

function seedFixture(fake: FakeSupabase, overrides: Record<string, unknown> = {}) {
  fake.seed("fixtures", [
    {
      id: FIXTURE_ID,
      competition_id: "comp-1",
      season_id: "season-1",
      home_team_id: HOME_TEAM_ID,
      away_team_id: AWAY_TEAM_ID,
      venue_id: null,
      referee_id: null,
      round: "1",
      kickoff_utc: "2026-08-29T15:00:00Z",
      status: "scheduled",
      home_score: null,
      away_score: null,
      importance_tags: [],
      source: "api-football",
      source_timestamp: "2026-08-29T00:00:00Z",
      is_synthetic: false,
      ...overrides
    }
  ]);
}

describe("getMatchDetail", () => {
  it("returns null (never throws) when the fixture doesn't exist, so the route can 404 cleanly", async () => {
    const fake = new FakeSupabase();

    const result = await getMatchDetail(fakeClient(fake), FIXTURE_ID);

    expect(result).toBeNull();
  });

  it("enriches the fixture with real team names, freshness, and its current predictions", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    fake.seed("teams", [
      { id: HOME_TEAM_ID, name: "Synthetic United" },
      { id: AWAY_TEAM_ID, name: "Synthetic City" }
    ]);
    fake.seed("predictions", [
      {
        id: "pred-1",
        fixture_id: FIXTURE_ID,
        market: "1x2",
        selection: "home",
        probability: 0.55,
        confidence: "medium",
        data_quality: "limited",
        risk_classification: "moderate",
        factors: [],
        model_version_id: "mv-1",
        generated_at: "2026-08-29T00:00:00Z",
        superseded_at: null
      }
    ]);

    const result = await getMatchDetail(fakeClient(fake), FIXTURE_ID);

    expect(result?.id).toBe(FIXTURE_ID);
    expect(result?.homeTeamName).toBe("Synthetic United");
    expect(result?.awayTeamName).toBe("Synthetic City");
    expect(result?.predictionsAvailable).toBe(true);
    expect(result?.predictions).toHaveLength(1);
    expect(result?.predictions[0]).toMatchObject({ market: "1x2", selection: "home", probability: 0.55 });
  });

  it("falls back to null team names (never a fabricated one) when the teams table has no matching rows", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    // No teams seeded at all.

    const result = await getMatchDetail(fakeClient(fake), FIXTURE_ID);

    expect(result?.homeTeamName).toBeNull();
    expect(result?.awayTeamName).toBeNull();
  });

  it("reports predictionsAvailable: false and an empty list when no current prediction exists yet", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    // No predictions seeded — a fixture that hasn't been predicted on yet.

    const result = await getMatchDetail(fakeClient(fake), FIXTURE_ID);

    expect(result?.predictionsAvailable).toBe(false);
    expect(result?.predictions).toEqual([]);
  });

  it("excludes a superseded prediction, returning only the current one for the same market", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    fake.seed("predictions", [
      {
        id: "pred-old",
        fixture_id: FIXTURE_ID,
        market: "1x2",
        selection: "away",
        probability: 0.3,
        confidence: "low",
        data_quality: "insufficient",
        risk_classification: null,
        factors: [],
        model_version_id: "mv-1",
        generated_at: "2026-08-28T00:00:00Z",
        superseded_at: "2026-08-29T00:00:00Z"
      },
      {
        id: "pred-current",
        fixture_id: FIXTURE_ID,
        market: "1x2",
        selection: "home",
        probability: 0.6,
        confidence: "high",
        data_quality: "strong",
        risk_classification: "low",
        factors: [],
        model_version_id: "mv-2",
        generated_at: "2026-08-29T00:00:00Z",
        superseded_at: null
      }
    ]);

    const result = await getMatchDetail(fakeClient(fake), FIXTURE_ID);

    expect(result?.predictions).toHaveLength(1);
    expect(result?.predictions[0]).toMatchObject({ selection: "home", probability: 0.6 });
  });
});
