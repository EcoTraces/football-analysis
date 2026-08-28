import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderFixtureStatistics, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { refreshTeamCornersAverage, syncFixtureStatistics } from "../jobs/syncFixtureStatistics.js";

const silentLogger = pino({ level: "silent" });

class FakeProvider implements FootballDataProvider {
  readonly name = "fake-provider";
  public calls: string[] = [];
  constructor(
    private readonly statsByFixture: Record<string, ProviderResponse<ProviderFixtureStatistics[]>> = {}
  ) {}

  async getFixtureStatistics(fixture: string): Promise<ProviderResponse<ProviderFixtureStatistics[]>> {
    this.calls.push(fixture);
    return (
      this.statsByFixture[fixture] ?? {
        ok: true,
        data: [
          { teamExternalId: "33", corners: 6 },
          { teamExternalId: "34", corners: 4 }
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
  async getPlayerStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedTeams(fake: FakeSupabase) {
  fake.seed("teams", [
    { id: "team-home", external_ref: { api_football: "33" } },
    { id: "team-away", external_ref: { api_football: "34" } }
  ]);
}

function seedFixture(fake: FakeSupabase, overrides: Record<string, unknown> = {}) {
  fake.seed("fixtures", [
    {
      id: "fx-1",
      season_id: "season-1",
      home_team_id: "team-home",
      away_team_id: "team-away",
      external_ref: { api_football: "12345" },
      is_synthetic: false,
      status: "finished",
      kickoff_utc: new Date().toISOString(),
      ...overrides
    }
  ]);
}

describe("syncFixtureStatistics", () => {
  it("upserts a fixture_statistics row per team and aggregates them into team_statistics.corners", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake);
    const provider = new FakeProvider();

    const result = await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.statisticsProcessed).toBe(2);
    expect(result.statisticsRejected).toBe(0);
    expect(result.teamsAggregated).toBe(2);

    const rows = fake.rows("fixture_statistics");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fixture_id: "fx-1", team_id: "team-home", season_id: "season-1", corners: 6 }),
        expect.objectContaining({ fixture_id: "fx-1", team_id: "team-away", season_id: "season-1", corners: 4 })
      ])
    );

    const teamStats = fake.rows("team_statistics");
    const homeOverall = teamStats.find((r) => r.team_id === "team-home" && r.scope === "overall");
    expect(homeOverall?.corners).toBe(6);
  });

  it("calls the provider with the fixture's external id, not its internal UUID", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toEqual(["12345"]);
  });

  it("only considers finished, non-synthetic fixtures within the window", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake, { status: "scheduled" });
    const provider = new FakeProvider();

    const result = await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("ignores synthetic fixtures — never syncs statistics derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake, { is_synthetic: true });
    const provider = new FakeProvider();

    const result = await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a statistics entry for a team that isn't a participant in the fixture", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake);
    const provider = new FakeProvider({
      "12345": {
        ok: true,
        data: [{ teamExternalId: "99999", corners: 6 }],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });

    const result = await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.statisticsRejected).toBe(1);
    expect(fake.rows("fixture_statistics")).toHaveLength(0);
  });

  it("isolates a per-fixture provider failure and still finishes the run as partial", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    fake.seed("fixtures", [
      { id: "fx-1", season_id: "season-1", home_team_id: "team-home", away_team_id: "team-away", external_ref: { api_football: "1" }, is_synthetic: false, status: "finished", kickoff_utc: new Date().toISOString() },
      { id: "fx-2", season_id: "season-1", home_team_id: "team-home", away_team_id: "team-away", external_ref: { api_football: "2" }, is_synthetic: false, status: "finished", kickoff_utc: new Date().toISOString() }
    ]);
    const provider = new FakeProvider({
      "1": { ok: false, reason: "upstream_error", message: "boom", provider: "fake-provider" }
    });

    const result = await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesFailed).toBe(1);
    expect(result.statisticsProcessed).toBe(2); // fixture 2's default two-team stats succeeded
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("is idempotent: running twice updates the same fixture_statistics rows instead of duplicating them", async () => {
    const fake = new FakeSupabase();
    seedTeams(fake);
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);
    await syncFixtureStatistics(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("fixture_statistics")).toHaveLength(2);
  });

  it("refreshTeamCornersAverage averages only non-null corners values, and doesn't touch other team_statistics columns", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixture_statistics", [
      { id: "s1", fixture_id: "fx-1", team_id: "team-home", season_id: "season-1", corners: 6 },
      { id: "s2", fixture_id: "fx-2", team_id: "team-home", season_id: "season-1", corners: 4 },
      { id: "s3", fixture_id: "fx-3", team_id: "team-home", season_id: "season-1", corners: null }
    ]);
    fake.seed("team_statistics", [
      { id: "ts-1", team_id: "team-home", season_id: "season-1", scope: "overall", goals_scored: 35, corners: null }
    ]);

    const average = await refreshTeamCornersAverage(fakeClient(fake), "team-home", "season-1", "fake-provider");

    expect(average).toBe(5); // (6 + 4) / 2, the null entry excluded
    const row = fake.rows("team_statistics").find((r) => r.id === "ts-1");
    expect(row).toMatchObject({ corners: 5, goals_scored: 35 }); // goals_scored untouched
  });

  it("refreshTeamCornersAverage returns null and writes nothing when every value is null", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixture_statistics", [{ id: "s1", fixture_id: "fx-1", team_id: "team-home", season_id: "season-1", corners: null }]);

    const average = await refreshTeamCornersAverage(fakeClient(fake), "team-home", "season-1", "fake-provider");

    expect(average).toBeNull();
    expect(fake.rows("team_statistics")).toHaveLength(0);
  });
});
