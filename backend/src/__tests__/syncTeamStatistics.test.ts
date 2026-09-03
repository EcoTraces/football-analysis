import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderResponse, ProviderTeamStatistics } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";

const silentLogger = pino({ level: "silent" });

const SAMPLE_STATS: ProviderTeamStatistics = {
  matchesPlayed: 20,
  matchesPlayedHome: 10,
  matchesPlayedAway: 10,
  goalsFor: 35,
  goalsForHome: 20,
  goalsForAway: 15,
  goalsAgainst: 18,
  goalsAgainstHome: 8,
  goalsAgainstAway: 10,
  cleanSheets: 7,
  failedToScore: 3,
  yellowCards: 45,
  redCards: 2
};

class FakeProvider implements FootballDataProvider {
  readonly name = "api-football"; // normalizes to providerRefKey("api-football") === "api_football", matching this file's seeded external_ref: { api_football: ... } fixtures
  public calls: Array<[string, string, string]> = [];
  constructor(
    private readonly statsByTeam: Record<string, ProviderResponse<ProviderTeamStatistics>> = {}
  ) {}

  async getTeamStatistics(team: string, competition: string, season: string): Promise<ProviderResponse<ProviderTeamStatistics>> {
    this.calls.push([team, competition, season]);
    return (
      this.statsByTeam[team] ?? {
        ok: true,
        data: SAMPLE_STATS,
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
  async getInjuries() {
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
  fake.seed("competitions", [{ id: "comp-1", external_ref: { api_football: "39" } }]);
  fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
}

describe("syncTeamStatistics", () => {
  it("writes overall/home/away rows for each team in a fixture", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(2); // home team + away team
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const stats = fake.rows("team_statistics");
    expect(stats).toHaveLength(6); // 2 teams x 3 scopes

    const homeOverall = stats.find((r) => r.team_id === "team-home" && r.scope === "overall");
    expect(homeOverall).toMatchObject({ matches_played: 20, goals_scored: 35, goals_conceded: 18 });

    const homeHomeScope = stats.find((r) => r.team_id === "team-home" && r.scope === "home");
    expect(homeHomeScope).toMatchObject({ matches_played: 10, goals_scored: 20, goals_conceded: 8 });
  });

  it("writes yellow/red cards on the overall-scope row only, since the vendor doesn't split cards by home/away", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    const stats = fake.rows("team_statistics");
    const homeOverall = stats.find((r) => r.team_id === "team-home" && r.scope === "overall");
    expect(homeOverall).toMatchObject({ yellow_cards: 45, red_cards: 2 });

    const homeHomeScope = stats.find((r) => r.team_id === "team-home" && r.scope === "home");
    expect(homeHomeScope?.yellow_cards).toBeNull();
  });

  it("calls the provider with the correct external ids, not internal UUIDs", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toContainEqual(["33", "39", "2026"]);
    expect(provider.calls).toContainEqual(["34", "39", "2026"]);
  });

  it("deduplicates a team appearing in many fixtures in the same competition/season into one provider call", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-2", home_team_id: "team-away", away_team_id: "team-home", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-3", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("is idempotent: running twice updates the same rows instead of duplicating them", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncTeamStatistics(fakeClient(fake), provider, silentLogger);
    await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("team_statistics")).toHaveLength(6);
  });

  it("skips a combination whose team/competition/season has no external_ref, without failing the run", async () => {
    const fake = new FakeSupabase();
    fake.seed("teams", [
      { id: "team-home", external_ref: { api_football: "33" } },
      { id: "team-away", external_ref: {} } // never synced from a real provider
    ]);
    fake.seed("competitions", [{ id: "comp-1", external_ref: { api_football: "39" } }]);
    fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.processed).toBe(1); // team-home
    expect(result.skipped).toBe(1); // team-away, no external ref
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

    const result = await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.processed).toBe(1); // team-away succeeded
    expect(result.failed).toBe(1); // team-home failed
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("ignores synthetic fixtures — never syncs stats derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: true }
    ]);
    const provider = new FakeProvider();

    const result = await syncTeamStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
