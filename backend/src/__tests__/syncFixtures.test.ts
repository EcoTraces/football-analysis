import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderFixture, ProviderInjury, ProviderLineup, ProviderOdds, ProviderResponse, ProviderStanding, ProviderTeamStatistics } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";

const silentLogger = pino({ level: "silent" });

function makeFixture(overrides: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    externalId: "1001",
    competitionExternalId: "39",
    competitionName: "Premier League",
    countryName: "England",
    seasonExternalId: "2026",
    seasonLabel: "2026/2027",
    homeTeamExternalId: "33",
    homeTeamName: "Sample United",
    awayTeamExternalId: "34",
    awayTeamName: "Sample City",
    venueName: "Sample Park",
    round: "Regular Season - 1",
    kickoffUtc: "2026-08-27T15:00:00.000Z",
    status: "scheduled",
    homeScore: null,
    awayScore: null,
    ...overrides
  };
}

class FakeProvider implements FootballDataProvider {
  readonly name = "fake-provider";
  constructor(private readonly fixturesByDay: Record<string, ProviderResponse<ProviderFixture[]>>) {}

  async getFixturesForDateRange(fromIso: string, _toIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    const day = fromIso.slice(0, 10);
    return this.fixturesByDay[day] ?? { ok: true, data: [], sourceTimestamp: new Date().toISOString(), provider: this.name };
  }
  async getResultsSince(sinceIso: string) {
    return this.getFixturesForDateRange(sinceIso, sinceIso);
  }
  async getTeamStatistics(): Promise<ProviderResponse<ProviderTeamStatistics>> {
    return { ok: false, reason: "not_configured", message: "unused in this test", provider: this.name };
  }
  async getInjuries(): Promise<ProviderResponse<ProviderInjury[]>> {
    return { ok: false, reason: "not_configured", message: "unused in this test", provider: this.name };
  }
  async getLineup(): Promise<ProviderResponse<ProviderLineup[]>> {
    return { ok: false, reason: "not_configured", message: "unused in this test", provider: this.name };
  }
  async getStandings(): Promise<ProviderResponse<ProviderStanding[]>> {
    return { ok: false, reason: "not_configured", message: "unused in this test", provider: this.name };
  }
  async getOdds(): Promise<ProviderResponse<ProviderOdds[]>> {
    return { ok: false, reason: "not_configured", message: "unused in this test", provider: this.name };
  }
  async getFixtureStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused in this test", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("syncFixturesForDateRange", () => {
  it("upserts fixtures and creates the reference data they depend on", async () => {
    const fake = new FakeSupabase();
    const provider = new FakeProvider({
      "2026-08-27": {
        ok: true,
        data: [makeFixture()],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });

    const result = await syncFixturesForDateRange(
      fakeClient(fake),
      provider,
      "2026-08-27T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
      silentLogger
    );

    expect(result.fixturesProcessed).toBe(1);
    expect(result.fixturesRejected).toBe(0);
    expect(fake.rows("fixtures")).toHaveLength(1);
    expect(fake.rows("teams")).toHaveLength(2);
    expect(fake.rows("competitions")).toHaveLength(1);
    expect(fake.rows("countries")).toHaveLength(1);

    const ingestionRun = fake.rows("ingestion_runs")[0];
    expect(ingestionRun?.status).toBe("succeeded");
  });

  it("is idempotent: running twice over the same fixture updates, not duplicates", async () => {
    const fake = new FakeSupabase();
    const fixture = makeFixture();
    const provider = new FakeProvider({
      "2026-08-27": { ok: true, data: [fixture], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });

    await syncFixturesForDateRange(fakeClient(fake), provider, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z", silentLogger);
    await syncFixturesForDateRange(fakeClient(fake), provider, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z", silentLogger);

    expect(fake.rows("fixtures")).toHaveLength(1);
    expect(fake.rows("teams")).toHaveLength(2);
  });

  it("updates the score/status of an existing fixture on a later sync (e.g. after full time)", async () => {
    const fake = new FakeSupabase();
    const scheduled = makeFixture({ status: "scheduled", homeScore: null, awayScore: null });
    const finished = makeFixture({ status: "finished", homeScore: 2, awayScore: 1 });

    const provider1 = new FakeProvider({
      "2026-08-27": { ok: true, data: [scheduled], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });
    await syncFixturesForDateRange(fakeClient(fake), provider1, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z", silentLogger);

    const provider2 = new FakeProvider({
      "2026-08-27": { ok: true, data: [finished], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });
    await syncFixturesForDateRange(fakeClient(fake), provider2, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z", silentLogger);

    expect(fake.rows("fixtures")).toHaveLength(1);
    expect(fake.rows("fixtures")[0]?.status).toBe("finished");
    expect(fake.rows("fixtures")[0]?.home_score).toBe(2);
  });

  it("keeps going after a failed day and records the failure in the ingestion run", async () => {
    const fake = new FakeSupabase();
    const provider = new FakeProvider({
      "2026-08-27": { ok: false, reason: "upstream_error", message: "boom", provider: "fake-provider" },
      "2026-08-28": {
        ok: true,
        data: [makeFixture({ externalId: "1002", kickoffUtc: "2026-08-28T15:00:00.000Z" })],
        sourceTimestamp: new Date().toISOString(),
        provider: "fake-provider"
      }
    });

    const result = await syncFixturesForDateRange(
      fakeClient(fake),
      provider,
      "2026-08-27T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
      silentLogger
    );

    expect(result.daysAttempted).toBe(2);
    expect(result.daysFailed).toBe(1);
    expect(result.fixturesProcessed).toBe(1);
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("isolates a per-fixture failure without losing other fixtures in the same batch", async () => {
    const fake = new FakeSupabase();
    // Two fixtures in different competitions, so each triggers its own
    // competitions insert — failing just the second one's insert simulates
    // a real per-item DB error partway through a batch.
    const first = makeFixture({ externalId: "1001", competitionExternalId: "39", competitionName: "Premier League" });
    const second = makeFixture({ externalId: "1002", competitionExternalId: "140", competitionName: "La Liga" });
    const provider = new FakeProvider({
      "2026-08-27": { ok: true, data: [first, second], sourceTimestamp: new Date().toISOString(), provider: "fake-provider" }
    });

    fake.failNextInsert("competitions", 1);

    const result = await syncFixturesForDateRange(
      fakeClient(fake),
      provider,
      "2026-08-27T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
      silentLogger
    );

    // The first fixture succeeds; the second's competition insert fails,
    // but that failure doesn't abort the run or lose the first fixture.
    expect(result.fixturesProcessed).toBe(1);
    expect(result.fixturesRejected).toBe(1);
    expect(fake.rows("fixtures")).toHaveLength(1);
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
  });
});
