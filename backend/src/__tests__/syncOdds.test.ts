import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderOdds, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncOdds } from "../jobs/syncOdds.js";

const silentLogger = pino({ level: "silent" });

function odds(overrides: Partial<ProviderOdds> = {}): ProviderOdds {
  return {
    bookmaker: "Bet365",
    selections: [
      { market: "1x2", selection: "home", decimalOdds: 1.85 },
      { market: "1x2", selection: "draw", decimalOdds: 3.6 },
      { market: "1x2", selection: "away", decimalOdds: 4.2 }
    ],
    ...overrides
  };
}

class FakeProvider implements FootballDataProvider {
  readonly name = "fake-provider";
  public calls: string[] = [];
  constructor(private readonly oddsByFixture: Record<string, ProviderResponse<ProviderOdds[]>> = {}) {}

  async getOdds(fixture: string): Promise<ProviderResponse<ProviderOdds[]>> {
    this.calls.push(fixture);
    return (
      this.oddsByFixture[fixture] ?? {
        ok: true,
        data: [odds()],
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
  async getFixtureStatistics() {
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

describe("syncOdds", () => {
  it("inserts one snapshot row per selection returned by the provider", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    const result = await syncOdds(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(1);
    expect(result.snapshotsProcessed).toBe(3); // home/draw/away
    expect(result.snapshotsRejected).toBe(0);

    const snapshots = fake.rows("odds_snapshots");
    expect(snapshots).toHaveLength(3);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fixture_id: "fx-1", bookmaker: "Bet365", market: "1x2", selection: "home", decimal_odds: 1.85 })
      ])
    );
  });

  it("calls the provider with the fixture's external id, not its internal UUID", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncOdds(fakeClient(fake), provider, silentLogger);

    expect(provider.calls).toEqual(["12345"]);
  });

  it("treats an empty odds response as not-yet-available, not a failure", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider({
      "12345": { ok: true, data: [], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });

    const result = await syncOdds(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesNotYetAvailable).toBe(1);
    expect(result.fixturesFailed).toBe(0);
    expect(fake.rows("odds_snapshots")).toHaveLength(0);
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("succeeded");
  });

  it("is NOT idempotent by design: running twice appends new snapshots rather than overwriting", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const provider = new FakeProvider();

    await syncOdds(fakeClient(fake), provider, silentLogger);
    await syncOdds(fakeClient(fake), provider, silentLogger);

    // 3 selections x 2 runs — a real price history, not a "current odds" row.
    expect(fake.rows("odds_snapshots")).toHaveLength(6);
  });

  it("records a later price change as an additional snapshot, preserving the earlier one", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);

    const provider1 = new FakeProvider({
      "12345": {
        ok: true,
        data: [odds({ selections: [{ market: "1x2", selection: "home", decimalOdds: 1.85 }] })],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });
    await syncOdds(fakeClient(fake), provider1, silentLogger);

    const provider2 = new FakeProvider({
      "12345": {
        ok: true,
        data: [odds({ selections: [{ market: "1x2", selection: "home", decimalOdds: 1.75 }] })],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });
    await syncOdds(fakeClient(fake), provider2, silentLogger);

    const prices = fake.rows("odds_snapshots").map((r) => r.decimal_odds);
    expect(prices.sort()).toEqual([1.75, 1.85]);
  });

  it("only considers scheduled/live fixtures within the time window", async () => {
    const fake = new FakeSupabase();
    const now = Date.now();
    fake.seed("fixtures", [
      { id: "fx-soon", external_ref: { api_football: "1" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 2 * 3600_000).toISOString() },
      { id: "fx-far", external_ref: { api_football: "2" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 240 * 3600_000).toISOString() },
      { id: "fx-finished", external_ref: { api_football: "3" }, is_synthetic: false, status: "finished", kickoff_utc: new Date(now - 2 * 3600_000).toISOString() }
    ]);
    const provider = new FakeProvider();

    const result = await syncOdds(fakeClient(fake), provider, silentLogger, 24);

    expect(result.fixturesConsidered).toBe(1);
    expect(provider.calls).toEqual(["1"]);
  });

  it("skips a fixture with no external_ref without failing the run", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { external_ref: {} });
    const provider = new FakeProvider();

    const result = await syncOdds(fakeClient(fake), provider, silentLogger);

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

    const result = await syncOdds(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesFailed).toBe(1);
    expect(result.snapshotsProcessed).toBe(3); // fixture 2's default odds succeeded
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("ignores synthetic fixtures — never syncs odds derived from fabricated matches", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { is_synthetic: true });
    const provider = new FakeProvider();

    const result = await syncOdds(fakeClient(fake), provider, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});
