import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listFixtures } from "../services/fixturesService.js";
import { FakeSupabase } from "./testSupabaseFake.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

const VALID_TEAM_ID = "123e4567-e89b-12d3-a456-426614174000";

function seedFixture(fake: FakeSupabase, overrides: Record<string, unknown> = {}) {
  fake.seed("fixtures", [
    {
      id: "fx-1",
      competition_id: "comp-1",
      home_team_id: VALID_TEAM_ID,
      away_team_id: "other-team",
      kickoff_utc: "2026-08-27T15:00:00Z",
      status: "scheduled",
      home_score: null,
      away_score: null,
      source: "api-football",
      source_timestamp: "2026-08-27T00:00:00Z",
      is_synthetic: false,
      ...overrides
    }
  ]);
}

describe("listFixtures", () => {
  it("excludes synthetic rows by default", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { is_synthetic: true });

    const result = await listFixtures(fakeClient(fake), {});

    expect(result).toHaveLength(0);
  });

  it("filters by a valid teamId, matching either home or away side", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);

    const result = await listFixtures(fakeClient(fake), { teamId: VALID_TEAM_ID });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("fx-1");
  });

  it("rejects a teamId that isn't a UUID, rather than building an unsafe filter string from it", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);

    // A value containing PostgREST filter syntax — exactly what the
    // defensive check exists to keep out of the .or() string it would
    // otherwise be interpolated into unvalidated.
    await expect(listFixtures(fakeClient(fake), { teamId: "x,id.neq.impossible" })).rejects.toThrow(/Invalid teamId/);
  });

  it("returns no match for a well-formed but non-existent teamId, rather than throwing", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);

    const result = await listFixtures(fakeClient(fake), { teamId: "00000000-0000-0000-0000-000000000000" });

    expect(result).toHaveLength(0);
  });

  it("enriches each fixture with its home/away team's real name", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    fake.seed("teams", [
      { id: VALID_TEAM_ID, name: "Synthetic United" },
      { id: "other-team", name: "Synthetic City" }
    ]);

    const result = await listFixtures(fakeClient(fake), {});

    expect(result[0]?.homeTeamName).toBe("Synthetic United");
    expect(result[0]?.awayTeamName).toBe("Synthetic City");
  });

  it("falls back to null (never a fabricated name) when a team row doesn't exist", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    // No teams table rows seeded at all.

    const result = await listFixtures(fakeClient(fake), {});

    expect(result[0]?.homeTeamName).toBeNull();
    expect(result[0]?.awayTeamName).toBeNull();
  });
});
