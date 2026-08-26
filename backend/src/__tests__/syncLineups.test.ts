import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderLineup, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncLineups } from "../jobs/syncLineups.js";

const silentLogger = pino({ level: "silent" });

function lineup(overrides: Partial<ProviderLineup> = {}): ProviderLineup {
  return {
    teamExternalId: "33",
    teamName: "Sample United",
    formation: "4-3-3",
    startingPlayers: [{ externalId: "1", name: "Keeper One" }],
    substitutePlayers: [{ externalId: "12", name: "Sub One" }],
    ...overrides
  };
}

class FakeProvider implements FootballDataProvider {
  readonly name = "fake-provider";
  public calls: string[] = [];
  constructor(private readonly lineupsByFixture: Record<string, ProviderResponse<ProviderLineup[]>> = {}) {}

  async getLineup(fixture: string): Promise<ProviderResponse<ProviderLineup[]>> {
    this.calls.push(fixture);
    return (
      this.lineupsByFixture[fixture] ?? {
        ok: true,
        // Distinct player ids per team (real clubs never share a player) so
        // tests asserting "N distinct players" aren't accidentally passing
        // or failing for the wrong reason.
        data: [
          lineup({
            teamExternalId: "33",
            startingPlayers: [{ externalId: "3301", name: "Keeper of 33" }],
            substitutePlayers: [{ externalId: "3312", name: "Sub of 33" }]
          }),
          lineup({
            teamExternalId: "34",
            teamName: "Sample City",
            startingPlayers: [{ externalId: "3401", name: "Keeper of 34" }],
            substitutePlayers: [{ externalId: "3412", name: "Sub of 34" }]
          })
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
  async getStandings() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedFixture(fake: FakeSupabase, overrides: Record<string, unknown> = {}) {
  fake.seed("fixtures", [
    {
      id: "fx-1",
      external_ref: { api_football: "12345" },
      is_synthetic: false,
      status: "scheduled",
      kickoff_utc: new Date().toISOString(),
      ...overrides
    }
  ]);
}

describe("syncLineups", () => {
  it("upserts a lineup row per team returned by the provider", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.lineupsProcessed).toBe(2);
    expect(result.lineupsRejected).toBe(0);

    const lineups = fake.rows("lineups");
    expect(lineups).toHaveLength(2);
    expect(lineups[0]).toMatchObject({
      fixture_id: "fx-1",
      confirmation_status: "confirmed",
      formation: "4-3-3",
      starting_players: expect.arrayContaining([expect.any(String)])
    });

    const players = fake.rows("players");
    expect(players).toHaveLength(4); // 2 teams x (1 starter + 1 sub)
  });

  it("calls the provider with the fixture's external id, not its internal UUID", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toEqual(["12345"]);
  });

  it("treats an empty lineups response as not-yet-available, not a failure", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider({
      "12345": { ok: true, data: [], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesNotYetAvailable).toBe(1);
    expect(result.fixturesFailed).toBe(0);
    expect(fake.rows("lineups")).toHaveLength(0);
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("succeeded");
  });

  it("is idempotent: running twice updates the same rows instead of duplicating them", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncLineups(fakeClient(fake), provider, silentLogger);
    await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(fake.rows("lineups")).toHaveLength(2);
    expect(fake.rows("players")).toHaveLength(4);
  });

  it("only considers fixtures within the kickoff-time window", async () => {
    const fake = new FakeSupabase();
    const now = Date.now();
    fake.seed("fixtures", [
      {
        id: "fx-soon",
        external_ref: { api_football: "1" },
        is_synthetic: false,
        status: "scheduled",
        kickoff_utc: new Date(now + 2 * 60 * 60 * 1000).toISOString() // 2h from now
      },
      {
        id: "fx-far",
        external_ref: { api_football: "2" },
        is_synthetic: false,
        status: "scheduled",
        kickoff_utc: new Date(now + 240 * 60 * 60 * 1000).toISOString() // 10 days from now
      }
    ]);
    const provider = new FakeProvider();

    const result = await syncLineups(fakeClient(fake), provider, silentLogger, 24);

    expect(result.fixturesConsidered).toBe(1);
    expect(provider.calls).toEqual(["1"]);
  });

  it("excludes postponed/cancelled/abandoned fixtures even within the window", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { status: "postponed" });
    const provider = new FakeProvider();

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips a fixture with no external_ref without failing the run", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { external_ref: {} });
    const provider = new FakeProvider();

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.fixturesSkipped).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("isolates a per-fixture provider failure and still finishes the run as partial", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      { id: "fx-1", external_ref: { api_football: "1" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date().toISOString() },
      { id: "fx-2", external_ref: { api_football: "2" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date().toISOString() }
    ]);
    const provider = new FakeProvider({
      "1": { ok: false, reason: "upstream_error", message: "boom", provider: "fake-provider" }
    });

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesFailed).toBe(1);
    expect(result.lineupsProcessed).toBe(2); // fixture 2's default two-team lineup succeeded
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("ignores synthetic fixtures — never syncs lineups derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { is_synthetic: true });
    const provider = new FakeProvider();

    const result = await syncLineups(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
