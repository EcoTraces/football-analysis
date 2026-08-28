import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiFootballProvider } from "../providers/ApiFootballProvider.js";
import { NullProvider } from "../providers/NullProvider.js";
import { checkFreshness, colorFor, apiFootballHealthStatus, schedulerHealthStatus, FRESHNESS_CHECKS } from "../routes/health.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import type { Scheduler } from "../scheduler/scheduler.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("colorFor", () => {
  it("maps LIVE/RECENT/STALE/UNAVAILABLE onto GREEN/YELLOW/RED/GRAY", () => {
    expect(colorFor("LIVE")).toBe("GREEN");
    expect(colorFor("RECENT")).toBe("YELLOW");
    expect(colorFor("STALE")).toBe("RED");
    expect(colorFor("UNAVAILABLE")).toBe("GRAY");
  });
});

describe("checkFreshness", () => {
  const fixturesCheck = FRESHNESS_CHECKS.find((c) => c.domain === "fixtures")!;

  it("reports UNAVAILABLE/GRAY when the table has no non-synthetic rows", async () => {
    const fake = new FakeSupabase();
    const result = await checkFreshness(fakeClient(fake), fixturesCheck);

    expect(result).toEqual({ domain: "fixtures", lastUpdated: null, status: "UNAVAILABLE", color: "GRAY" });
  });

  it("picks the most recent non-synthetic row's timestamp", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      { id: "fx-old", is_synthetic: false, source_timestamp: new Date(Date.now() - 10 * 3600_000).toISOString() },
      { id: "fx-new", is_synthetic: false, source_timestamp: new Date().toISOString() },
      { id: "fx-synthetic", is_synthetic: true, source_timestamp: new Date().toISOString() }
    ]);

    const result = await checkFreshness(fakeClient(fake), fixturesCheck);

    expect(result.status).toBe("LIVE");
    expect(result.color).toBe("GREEN");
  });

  it("classifies an old timestamp as STALE/RED", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [{ id: "fx-1", is_synthetic: false, source_timestamp: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }]);

    const result = await checkFreshness(fakeClient(fake), fixturesCheck);

    expect(result.status).toBe("STALE");
    expect(result.color).toBe("RED");
  });

  it("predictions check ignores is_synthetic (predictions have no such column)", async () => {
    const predictionsCheck = FRESHNESS_CHECKS.find((c) => c.domain === "predictions")!;
    expect(predictionsCheck.filterSynthetic).toBe(false);

    const fake = new FakeSupabase();
    fake.seed("predictions", [{ id: "p-1", generated_at: new Date().toISOString() }]);

    const result = await checkFreshness(fakeClient(fake), predictionsCheck);
    expect(result.status).toBe("LIVE");
  });

  it("fixtureStatistics check reads the fixture_statistics table, filtered by is_synthetic", async () => {
    const fixtureStatisticsCheck = FRESHNESS_CHECKS.find((c) => c.domain === "fixtureStatistics")!;
    expect(fixtureStatisticsCheck.table).toBe("fixture_statistics");
    expect(fixtureStatisticsCheck.filterSynthetic).toBe(true);

    const fake = new FakeSupabase();
    fake.seed("fixture_statistics", [{ id: "fs-1", is_synthetic: false, source_timestamp: new Date().toISOString() }]);

    const result = await checkFreshness(fakeClient(fake), fixtureStatisticsCheck);
    expect(result.status).toBe("LIVE");
  });

  it("playerStatistics check reads the player_statistics table, filtered by is_synthetic", async () => {
    const playerStatisticsCheck = FRESHNESS_CHECKS.find((c) => c.domain === "playerStatistics")!;
    expect(playerStatisticsCheck.table).toBe("player_statistics");
    expect(playerStatisticsCheck.filterSynthetic).toBe(true);

    const fake = new FakeSupabase();
    fake.seed("player_statistics", [{ id: "ps-1", is_synthetic: false, source_timestamp: new Date().toISOString() }]);

    const result = await checkFreshness(fakeClient(fake), playerStatisticsCheck);
    expect(result.status).toBe("LIVE");
  });
});

describe("apiFootballHealthStatus", () => {
  it("reports NOT_CONFIGURED for the NullProvider", () => {
    const status = apiFootballHealthStatus(new NullProvider());
    expect(status.status).toBe("NOT_CONFIGURED");
    expect(status.lastRequest).toBeNull();
    expect(status.rateLimit).toBeNull();
  });

  it("reports UNKNOWN for a configured provider that has never made a request", () => {
    const provider = new ApiFootballProvider("test-key");
    const status = apiFootballHealthStatus(provider);
    expect(status.status).toBe("UNKNOWN");
  });

  it("reports CONNECTED after a successful request, ERROR after a failed one", async () => {
    const okFetch = () => Promise.resolve(new Response(JSON.stringify({ response: [] }), { status: 200 }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", okFetch as unknown as typeof fetch);
    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");
    expect(apiFootballHealthStatus(provider).status).toBe("CONNECTED");

    const failFetch = () => Promise.resolve(new Response("{}", { status: 401 }));
    const failingProvider = new ApiFootballProvider("bad-key", "https://example.test", failFetch as unknown as typeof fetch);
    await failingProvider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");
    expect(apiFootballHealthStatus(failingProvider).status).toBe("ERROR");
  });
});

describe("schedulerHealthStatus", () => {
  it("reports DISABLED with no jobs when the scheduler is null", () => {
    expect(schedulerHealthStatus(null)).toEqual({
      status: "DISABLED",
      message: "SCHEDULER_ENABLED=false — jobs run only via POST /api/admin/*.",
      jobs: []
    });
  });

  it("reports RUNNING with the scheduler's job statuses when active", () => {
    const fakeScheduler: Scheduler = {
      jobs: ["predictions"],
      status: () => [{ name: "predictions", cronExpression: "15 3 * * *", nextRun: "2026-08-27T03:15:00.000Z" }],
      stop: () => {}
    };

    const result = schedulerHealthStatus(fakeScheduler);
    expect(result.status).toBe("RUNNING");
    expect(result.jobs).toHaveLength(1);
  });
});
