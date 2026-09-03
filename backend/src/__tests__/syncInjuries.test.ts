import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderInjury, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncInjuries } from "../jobs/syncInjuries.js";

const silentLogger = pino({ level: "silent" });

function injury(overrides: Partial<ProviderInjury> = {}): ProviderInjury {
  return {
    playerExternalId: "501",
    playerName: "Sample Striker",
    status: "injured",
    description: "Knee Injury",
    reportedForFixtureUtc: "2026-08-20T15:00:00.000Z",
    ...overrides
  };
}

class FakeProvider implements FootballDataProvider {
  readonly name = "api-football"; // normalizes to providerRefKey("api-football") === "api_football", matching this file's seeded external_ref: { api_football: ... } fixtures
  public calls: Array<[string, string]> = [];
  constructor(private readonly injuriesByTeam: Record<string, ProviderResponse<ProviderInjury[]>> = {}) {}

  async getInjuries(team: string, season: string): Promise<ProviderResponse<ProviderInjury[]>> {
    this.calls.push([team, season]);
    return (
      this.injuriesByTeam[team] ?? {
        // Distinct default player per team (real teams never share a player)
        // so tests asserting "one player per team" aren't accidentally
        // passing/failing for the wrong reason.
        ok: true,
        data: [injury({ playerExternalId: `${team}01`, playerName: `Player of team ${team}` })],
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
  async getLineup() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getStandings() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getOdds() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getFixtureStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getPlayerStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedFixtureGraph(fake: FakeSupabase) {
  fake.seed("teams", [
    { id: "team-home", external_ref: { api_football: "33" } },
    { id: "team-away", external_ref: { api_football: "34" } }
  ]);
  fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
}

describe("syncInjuries", () => {
  it("upserts a player and an injury row from a well-formed response", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(2); // team-home + team-away, both vs season-1
    expect(result.playersProcessed).toBe(2); // one injury each, per FakeProvider's default
    expect(result.playersRejected).toBe(0);

    const players = fake.rows("players");
    expect(players).toHaveLength(2);
    expect(players.map((p) => p.external_ref)).toEqual(
      expect.arrayContaining([{ api_football: "3301" }, { api_football: "3401" }])
    );

    const injuries = fake.rows("injuries");
    expect(injuries).toHaveLength(2);
    expect(injuries[0]).toMatchObject({ status: "injured", description: "Knee Injury" });
  });

  it("calls the provider with team/season external ids, not internal UUIDs", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toContainEqual(["33", "2026"]);
    expect(provider.calls).toContainEqual(["34", "2026"]);
  });

  it("keeps only the most recent report per player when the provider returns several", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider({
      "33": {
        ok: true,
        data: [
          injury({ reportedForFixtureUtc: "2026-07-01T00:00:00.000Z", status: "doubtful", description: "Early report" }),
          injury({ reportedForFixtureUtc: "2026-08-15T00:00:00.000Z", status: "injured", description: "Later report" })
        ],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });

    await syncInjuries(fakeClient(fake), provider, silentLogger);

    const injuries = fake.rows("injuries").filter((r) => r.team_id === "team-home");
    expect(injuries).toHaveLength(1);
    expect(injuries[0]).toMatchObject({ description: "Later report", status: "injured" });
  });

  it("deduplicates the same team+season pair across multiple fixtures into one provider call", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-2", home_team_id: "team-away", away_team_id: "team-home", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("is idempotent: running twice updates the same player/injury rows instead of duplicating them", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncInjuries(fakeClient(fake), provider, silentLogger);
    await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("players")).toHaveLength(2);
    expect(fake.rows("injuries")).toHaveLength(2);
  });

  it("skips a team/season pair with no external_ref without failing the run", async () => {
    const fake = new FakeSupabase();
    fake.seed("teams", [
      { id: "team-home", external_ref: { api_football: "33" } },
      { id: "team-away", external_ref: {} } // never synced from a real provider
    ]);
    fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(1); // team-home only
    expect(result.combinationsSkipped).toBe(1); // team-away
    expect(provider.calls).toHaveLength(1);
  });

  it("isolates a per-combination provider failure and still finishes the run as partial", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider({
      "33": { ok: false, reason: "upstream_error", message: "boom", provider: "fake-provider" }
    });

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.playersProcessed).toBe(1); // team-away succeeded
    expect(result.combinationsFailed).toBe(1); // team-home failed
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("treats a team with no reported injuries as a normal empty result, not a failure", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider({
      "33": { ok: true, data: [], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsFailed).toBe(0);
    expect(fake.rows("injuries").filter((r) => r.team_id === "team-home")).toHaveLength(0);
  });

  it("ignores synthetic fixtures — never syncs injuries derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: true }
    ]);
    const provider = new FakeProvider();

    const result = await syncInjuries(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
