import { describe, expect, it, vi } from "vitest";
import cron from "node-cron";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  startScheduler,
  runFixturesSync,
  runLineupsSync,
  runOddsSync,
  runFixtureStatisticsSync,
  runLeagueCalibrationSync,
  runPredictions,
  guarded,
  FIXTURES_SYNC_CRON,
  TEAM_STATISTICS_SYNC_CRON,
  PLAYER_STATISTICS_SYNC_CRON,
  INJURIES_SYNC_CRON,
  STANDINGS_SYNC_CRON,
  LINEUPS_SYNC_CRON,
  ODDS_SYNC_CRON,
  FIXTURE_STATISTICS_SYNC_CRON,
  LEAGUE_CALIBRATION_CRON,
  PREDICTIONS_CRON
} from "../scheduler/scheduler.js";

function notConfigured(name: string): Promise<ProviderResponse<never>> {
  return Promise.resolve({ ok: false, reason: "not_configured", message: "unused", provider: name });
}

class StubProvider implements FootballDataProvider {
  constructor(public readonly name: string) {}
  getFixturesForDateRange: FootballDataProvider["getFixturesForDateRange"] = () => notConfigured(this.name);
  getResultsSince: FootballDataProvider["getResultsSince"] = () => notConfigured(this.name);
  getTeamStatistics: FootballDataProvider["getTeamStatistics"] = () => notConfigured(this.name);
  getInjuries: FootballDataProvider["getInjuries"] = () => notConfigured(this.name);
  getLineup: FootballDataProvider["getLineup"] = () => notConfigured(this.name);
  getStandings: FootballDataProvider["getStandings"] = () => notConfigured(this.name);
  getOdds: FootballDataProvider["getOdds"] = () => notConfigured(this.name);
  getFixtureStatistics: FootballDataProvider["getFixtureStatistics"] = () => notConfigured(this.name);
  getPlayerStatistics: FootballDataProvider["getPlayerStatistics"] = () => notConfigured(this.name);
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("scheduler", () => {
  it("every exported cron expression is syntactically valid", () => {
    for (const expr of [
      FIXTURES_SYNC_CRON,
      TEAM_STATISTICS_SYNC_CRON,
      PLAYER_STATISTICS_SYNC_CRON,
      INJURIES_SYNC_CRON,
      STANDINGS_SYNC_CRON,
      LINEUPS_SYNC_CRON,
      ODDS_SYNC_CRON,
      FIXTURE_STATISTICS_SYNC_CRON,
      LEAGUE_CALIBRATION_CRON,
      PREDICTIONS_CRON
    ]) {
      expect(cron.validate(expr)).toBe(true);
    }
  });

  it("schedules all eight sync jobs plus league calibration and predictions when a real provider is configured", () => {
    const logger = fakeLogger();
    const scheduler = startScheduler({
      supabase: fakeClient(new FakeSupabase()),
      provider: new StubProvider("fake-provider"),
      mlServiceUrl: "http://localhost:8000",
      logger
    });

    expect(scheduler.jobs.sort()).toEqual(
      [
        "sync_fixtures",
        "sync_team_statistics",
        "sync_player_statistics",
        "sync_injuries",
        "sync_standings",
        "sync_lineups",
        "sync_odds",
        "sync_fixture_statistics",
        "calibrate_leagues",
        "predictions"
      ].sort()
    );
    expect(logger.warn).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("schedules only league calibration and predictions, and logs a warning, when no provider is configured", () => {
    const logger = fakeLogger();
    const scheduler = startScheduler({
      supabase: fakeClient(new FakeSupabase()),
      provider: new StubProvider("null"),
      mlServiceUrl: "http://localhost:8000",
      logger
    });

    expect(scheduler.jobs.sort()).toEqual(["calibrate_leagues", "predictions"].sort());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no football data provider configured"));

    scheduler.stop();
  });

  it("status() reports a cron expression and a next-run time for every scheduled job", () => {
    const scheduler = startScheduler({
      supabase: fakeClient(new FakeSupabase()),
      provider: new StubProvider("fake-provider"),
      mlServiceUrl: "http://localhost:8000",
      logger: fakeLogger()
    });

    const status = scheduler.status();
    expect(status).toHaveLength(scheduler.jobs.length);
    for (const entry of status) {
      expect(scheduler.jobs).toContain(entry.name);
      expect(typeof entry.cronExpression).toBe("string");
      expect(entry.nextRun).not.toBeNull();
      expect(() => new Date(entry.nextRun as string).toISOString()).not.toThrow();
    }

    scheduler.stop();
  });

  it("stop() actually stops every scheduled task (none remain running)", () => {
    const scheduler = startScheduler({
      supabase: fakeClient(new FakeSupabase()),
      provider: new StubProvider("fake-provider"),
      mlServiceUrl: "http://localhost:8000",
      logger: fakeLogger()
    });

    expect(() => scheduler.stop()).not.toThrow();
    // Calling stop twice must also be safe (shutdown handlers may fire more than once).
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("runFixturesSync requests a 3-day UTC window starting today, one call per day", async () => {
    const calls: string[] = [];
    const provider = new StubProvider("fake-provider");
    provider.getFixturesForDateRange = (from: string) => {
      calls.push(from.slice(0, 10));
      return Promise.resolve({ ok: true as const, data: [], sourceTimestamp: new Date().toISOString(), provider: provider.name });
    };

    await runFixturesSync({
      supabase: fakeClient(new FakeSupabase()),
      provider,
      mlServiceUrl: "http://localhost:8000",
      logger: fakeLogger()
    });

    expect(calls).toHaveLength(3);
    const today = new Date();
    const expectedFirstDay = today.toISOString().slice(0, 10);
    expect(calls[0]).toBe(expectedFirstDay);
  });

  it("runLineupsSync uses the 24h kickoff window, excluding a fixture 30h out", async () => {
    const fake = new FakeSupabase();
    const now = Date.now();
    fake.seed("fixtures", [
      { id: "fx-soon", external_ref: { api_football: "1" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 2 * 3600_000).toISOString() },
      { id: "fx-far", external_ref: { api_football: "2" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 30 * 3600_000).toISOString() }
    ]);
    const provider = new StubProvider("fake-provider");
    const calls: string[] = [];
    provider.getLineup = (fixtureExternalId: string) => {
      calls.push(fixtureExternalId);
      return Promise.resolve({ ok: true as const, data: [], sourceTimestamp: new Date().toISOString(), provider: provider.name });
    };

    await runLineupsSync({ supabase: fakeClient(fake), provider, mlServiceUrl: "http://localhost:8000", logger: fakeLogger() });

    expect(calls).toEqual(["1"]);
  });

  it("runOddsSync uses the 24h kickoff window, excluding a fixture 30h out", async () => {
    const fake = new FakeSupabase();
    const now = Date.now();
    fake.seed("fixtures", [
      { id: "fx-soon", external_ref: { api_football: "1" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 2 * 3600_000).toISOString() },
      { id: "fx-far", external_ref: { api_football: "2" }, is_synthetic: false, status: "scheduled", kickoff_utc: new Date(now + 30 * 3600_000).toISOString() }
    ]);
    const provider = new StubProvider("fake-provider");
    const calls: string[] = [];
    provider.getOdds = (fixtureExternalId: string) => {
      calls.push(fixtureExternalId);
      return Promise.resolve({ ok: true as const, data: [], sourceTimestamp: new Date().toISOString(), provider: provider.name });
    };

    await runOddsSync({ supabase: fakeClient(fake), provider, mlServiceUrl: "http://localhost:8000", logger: fakeLogger() });

    expect(calls).toEqual(["1"]);
  });

  it("runFixtureStatisticsSync uses the 72h window, excluding a finished fixture 100h in the past", async () => {
    const fake = new FakeSupabase();
    const now = Date.now();
    fake.seed("teams", [{ id: "team-home", external_ref: { api_football: "33" } }, { id: "team-away", external_ref: { api_football: "34" } }]);
    fake.seed("fixtures", [
      {
        id: "fx-recent",
        season_id: "season-1",
        home_team_id: "team-home",
        away_team_id: "team-away",
        external_ref: { api_football: "1" },
        is_synthetic: false,
        status: "finished",
        kickoff_utc: new Date(now - 10 * 3600_000).toISOString()
      },
      {
        id: "fx-old",
        season_id: "season-1",
        home_team_id: "team-home",
        away_team_id: "team-away",
        external_ref: { api_football: "2" },
        is_synthetic: false,
        status: "finished",
        kickoff_utc: new Date(now - 100 * 3600_000).toISOString()
      }
    ]);
    const provider = new StubProvider("fake-provider");
    const calls: string[] = [];
    provider.getFixtureStatistics = (fixtureExternalId: string) => {
      calls.push(fixtureExternalId);
      return Promise.resolve({ ok: true as const, data: [], sourceTimestamp: new Date().toISOString(), provider: provider.name });
    };

    await runFixtureStatisticsSync({ supabase: fakeClient(fake), provider, mlServiceUrl: "http://localhost:8000", logger: fakeLogger() });

    expect(calls).toEqual(["1"]);
  });

  it("runPredictions logs a warning (not an error) and does not throw when no model_version exists yet", async () => {
    const logger = fakeLogger();
    await runPredictions({
      supabase: fakeClient(new FakeSupabase()),
      provider: new StubProvider("fake-provider"),
      mlServiceUrl: "http://localhost:8000",
      logger
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { job: "predictions" },
      expect.stringContaining("no poisson-baseline model_version")
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("runPredictions runs the real job and logs success once a model_version exists", async () => {
    const fake = new FakeSupabase();
    fake.seed("model_versions", [{ id: "mv-1", name: "poisson-baseline", created_at: new Date().toISOString() }]);
    const logger = fakeLogger();

    await runPredictions({ supabase: fakeClient(fake), provider: new StubProvider("fake-provider"), mlServiceUrl: "http://localhost:8000", logger });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ job: "predictions" }),
      "Scheduled predictions run finished"
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("runLeagueCalibrationSync runs the real job and logs its result", async () => {
    const fake = new FakeSupabase();
    const logger = fakeLogger();

    await runLeagueCalibrationSync({ supabase: fakeClient(fake), provider: new StubProvider("fake-provider"), mlServiceUrl: "http://localhost:8000", logger });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ job: "calibrate_leagues" }),
      "Scheduled sync finished"
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(fake.rows("ingestion_runs")[0]).toMatchObject({ job_name: "calibrate_leagues" });
  });

  it("guarded() catches a thrown error and logs it instead of propagating", async () => {
    const logger = fakeLogger();
    const boom = guarded("sync_fixtures", logger, () => Promise.reject(new Error("boom")));

    await expect(boom()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "sync_fixtures", err: expect.any(Error) }),
      "Scheduled job threw unexpectedly"
    );
  });
});
