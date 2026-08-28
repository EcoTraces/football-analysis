import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderResponse, ProviderStanding } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncStandings } from "../jobs/syncStandings.js";

const silentLogger = pino({ level: "silent" });

function standing(overrides: Partial<ProviderStanding> = {}): ProviderStanding {
  return {
    teamExternalId: "33",
    teamName: "Sample United",
    position: 1,
    played: 20,
    wins: 14,
    draws: 3,
    losses: 3,
    goalsFor: 40,
    goalsAgainst: 20,
    points: 45,
    form: "WWDLW",
    ...overrides
  };
}

class FakeProvider implements FootballDataProvider {
  readonly name = "fake-provider";
  public calls: Array<[string, string]> = [];
  constructor(private readonly standingsByCompetition: Record<string, ProviderResponse<ProviderStanding[]>> = {}) {}

  async getStandings(competition: string, season: string): Promise<ProviderResponse<ProviderStanding[]>> {
    this.calls.push([competition, season]);
    return (
      this.standingsByCompetition[competition] ?? {
        ok: true,
        data: [
          standing({ teamExternalId: "33", teamName: "Sample United", position: 1 }),
          standing({ teamExternalId: "34", teamName: "Sample City", position: 2, points: 40 })
        ],
        sourceTimestamp: new Date().toISOString(),
        provider: this.name
      }
    );
  }

  async getFixturesForDateRange() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getResultsSince() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getTeamStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getInjuries() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getLineup() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getOdds() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getFixtureStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedFixtureGraph(fake: FakeSupabase) {
  fake.seed("competitions", [{ id: "comp-1", external_ref: { api_football: "39" } }]);
  fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
}

describe("syncStandings", () => {
  it("upserts a standings row per team returned by the provider", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(1);
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsRejected).toBe(0);

    const rows = fake.rows("standings");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.position === 1)).toMatchObject({ points: 45, wins: 14, form: "WWDLW", season_id: "season-1" });

    const teams = fake.rows("teams");
    expect(teams.map((t) => t.external_ref)).toEqual(
      expect.arrayContaining([{ api_football: "33" }, { api_football: "34" }])
    );
  });

  it("calls the provider with competition/season external ids, not internal UUIDs", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toEqual([["39", "2026"]]);
  });

  it("deduplicates multiple fixtures in the same competition/season into one provider call", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-2", home_team_id: "team-third", away_team_id: "team-fourth", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("is idempotent: running twice updates the same rows instead of duplicating them", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncStandings(fakeClient(fake), provider, silentLogger);
    await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("standings")).toHaveLength(2);
    expect(fake.rows("teams")).toHaveLength(2);
  });

  it("reflects a position/points change on a later sync rather than leaving the old table stuck", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);

    const provider1 = new FakeProvider({
      "39": { ok: true, data: [standing({ position: 1, points: 45 })], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });
    await syncStandings(fakeClient(fake), provider1, silentLogger);

    const provider2 = new FakeProvider({
      "39": { ok: true, data: [standing({ position: 2, points: 48 })], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });
    await syncStandings(fakeClient(fake), provider2, silentLogger);

    const rows = fake.rows("standings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position: 2, points: 48 });
  });

  it("skips a competition/season pair with no external_ref without failing the run", async () => {
    const fake = new FakeSupabase();
    fake.seed("competitions", [{ id: "comp-1", external_ref: {} }]); // never synced from a real provider
    fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(1);
    expect(result.combinationsSkipped).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("isolates a per-combination provider failure and still finishes the run as partial", async () => {
    const fake = new FakeSupabase();
    fake.seed("competitions", [
      { id: "comp-1", external_ref: { api_football: "39" } },
      { id: "comp-2", external_ref: { api_football: "140" } }
    ]);
    fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-2", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-2", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider({
      "39": { ok: false, reason: "upstream_error", message: "boom", provider: "fake-provider" }
    });

    const result = await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsFailed).toBe(1);
    expect(result.rowsProcessed).toBe(2); // comp-2's default two-team table succeeded
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("ignores synthetic fixtures — never syncs standings derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: true }
    ]);
    const provider = new FakeProvider();

    const result = await syncStandings(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
