import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderPlayerStatistics, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncPlayerStatistics } from "../jobs/syncPlayerStatistics.js";

const silentLogger = pino({ level: "silent" });

class FakeProvider implements FootballDataProvider {
  readonly name = "api-football"; // normalizes to providerRefKey("api-football") === "api_football", matching this file's seeded external_ref: { api_football: ... } fixtures
  public calls: Array<[string, string, string]> = [];
  constructor(
    private readonly playersByTeam: Record<string, ProviderResponse<ProviderPlayerStatistics[]>> = {}
  ) {}

  async getPlayerStatistics(team: string, competition: string, season: string): Promise<ProviderResponse<ProviderPlayerStatistics[]>> {
    this.calls.push([team, competition, season]);
    return (
      this.playersByTeam[team] ?? {
        ok: true,
        // Distinct player ids per team (a real squad never shares a player
        // with another club) so tests asserting "N distinct players" aren't
        // accidentally passing/failing for the wrong reason — same pattern
        // as syncLineups.test.ts's FakeProvider.
        data: [
          { playerExternalId: `${team}01`, playerName: `Striker of ${team}`, matchesPlayed: 18, goalsScored: 12, minutesPlayed: 1500 },
          { playerExternalId: `${team}02`, playerName: `Bench Player of ${team}`, matchesPlayed: 2, goalsScored: 0, minutesPlayed: 45 }
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
  async getStandings() {
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
  fake.seed("teams", [
    { id: "team-home", external_ref: { api_football: "33" } },
    { id: "team-away", external_ref: { api_football: "34" } }
  ]);
  fake.seed("competitions", [{ id: "comp-1", external_ref: { api_football: "39" } }]);
  fake.seed("seasons", [{ id: "season-1", external_ref: { api_football: "2026" } }]);
}

describe("syncPlayerStatistics", () => {
  it("upserts a player_statistics row per player, creating the player if new", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(2); // home team + away team
    expect(result.processed).toBe(2);
    expect(result.playersProcessed).toBe(4); // 2 players x 2 teams

    const players = fake.rows("players");
    expect(players).toHaveLength(4); // 2 distinct players per team x 2 teams

    const stats = fake.rows("player_statistics");
    expect(stats).toHaveLength(4);
    const striker = stats.find((r) => r.team_id === "team-home" && r.player_name === "Striker of 33");
    expect(striker).toMatchObject({ matches_played: 18, goals_scored: 12, minutes_played: 1500, season_id: "season-1" });
  });

  it("calls the provider with the correct external ids, not internal UUIDs", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toContainEqual(["33", "39", "2026"]);
    expect(provider.calls).toContainEqual(["34", "39", "2026"]);
  });

  it("deduplicates a team appearing in many fixtures in the same competition/season into one provider call", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: false },
      { id: "fx-2", home_team_id: "team-away", away_team_id: "team-home", competition_id: "comp-1", season_id: "season-1", is_synthetic: false }
    ]);
    const provider = new FakeProvider();

    const result = await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

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

    await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);
    await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("player_statistics")).toHaveLength(4);
    expect(fake.rows("players")).toHaveLength(4); // upsertPlayer also idempotent
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

    const result = await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

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

    const result = await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.processed).toBe(1); // team-away succeeded
    expect(result.failed).toBe(1); // team-home failed
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("ignores synthetic fixtures — never syncs player stats derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixtureGraph(fake);
    fake.seed("fixtures", [
      { id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", competition_id: "comp-1", season_id: "season-1", is_synthetic: true }
    ]);
    const provider = new FakeProvider();

    const result = await syncPlayerStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.combinationsConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
