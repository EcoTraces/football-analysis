import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";
import { syncInjuries } from "../jobs/syncInjuries.js";
import { syncStandings } from "../jobs/syncStandings.js";
import { syncLineups } from "../jobs/syncLineups.js";
import { syncOdds } from "../jobs/syncOdds.js";
import { runLatestPoissonPredictionsJob } from "../jobs/generatePredictions.js";

export interface SchedulerDeps {
  supabase: SupabaseClient;
  provider: FootballDataProvider;
  mlServiceUrl: string;
  logger: Logger;
}

// All expressions are evaluated in UTC (startScheduler passes
// { timezone: "UTC" }), matching this app's UTC-everywhere convention
// (kickoff_utc, ingestion_runs timestamps). Fixtures run first each day
// since team-statistics/injuries/standings/predictions all read from
// fixtures; lineups and odds run every 15 minutes since they only become
// meaningful/accurate close to kickoff (spec section 6: "refresh closer to
// kickoff"), offset from each other so they don't both fire on the same
// tick. These are fixed constants, not env-configurable — Task.md/
// Road_map.md only ever asked for "a scheduler" replacing manual calls, not
// per-job cron tuning; add that later if a real operational need shows up.
export const FIXTURES_SYNC_CRON = "0 2 * * *";
export const TEAM_STATISTICS_SYNC_CRON = "30 2 * * *";
export const INJURIES_SYNC_CRON = "45 2 * * *";
export const STANDINGS_SYNC_CRON = "0 3 * * *";
export const PREDICTIONS_CRON = "15 3 * * *";
export const LINEUPS_SYNC_CRON = "0,15,30,45 * * * *";
export const ODDS_SYNC_CRON = "5,20,35,50 * * * *";

const FIXTURES_SYNC_DAYS = 3; // Today + 2 days ahead — enough runway between daily runs without an expensive wide sync.
const KICKOFF_WINDOW_HOURS = 24; // Same default as the admin endpoints; frequency (every 15m), not window width, is what "closer to kickoff" buys here.
const PREDICTIONS_WINDOW_HOURS = 72; // Matches generatePredictions.ts's own default.

function isProviderConfigured(provider: FootballDataProvider): boolean {
  return provider.name !== "null";
}

// The run* functions and guarded() below are exported for direct unit
// testing (scheduler.test.ts) — real cron timing isn't something a fast
// unit test should depend on, but "does the scheduler call the right job
// with the right default parameters, and handle its failure/skip states
// correctly" is exactly the wiring this file exists to get right.
export async function runFixturesSync(deps: SchedulerDeps): Promise<void> {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + (FIXTURES_SYNC_DAYS - 1));

  const result = await syncFixturesForDateRange(deps.supabase, deps.provider, from.toISOString(), to.toISOString(), deps.logger);
  deps.logger.info({ job: "sync_fixtures", result }, "Scheduled sync finished");
}

export async function runTeamStatisticsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncTeamStatistics(deps.supabase, deps.provider, deps.logger);
  deps.logger.info({ job: "sync_team_statistics", result }, "Scheduled sync finished");
}

export async function runInjuriesSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncInjuries(deps.supabase, deps.provider, deps.logger);
  deps.logger.info({ job: "sync_injuries", result }, "Scheduled sync finished");
}

export async function runStandingsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncStandings(deps.supabase, deps.provider, deps.logger);
  deps.logger.info({ job: "sync_standings", result }, "Scheduled sync finished");
}

export async function runLineupsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncLineups(deps.supabase, deps.provider, deps.logger, KICKOFF_WINDOW_HOURS);
  deps.logger.info({ job: "sync_lineups", result }, "Scheduled sync finished");
}

export async function runOddsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncOdds(deps.supabase, deps.provider, deps.logger, KICKOFF_WINDOW_HOURS);
  deps.logger.info({ job: "sync_odds", result }, "Scheduled sync finished");
}

export async function runPredictions(deps: SchedulerDeps): Promise<void> {
  const result = await runLatestPoissonPredictionsJob(deps.supabase, deps.mlServiceUrl, deps.logger, PREDICTIONS_WINDOW_HOURS);
  if (!result.modelVersionId) {
    deps.logger.warn({ job: "predictions" }, "Scheduled predictions run skipped: no poisson-baseline model_version row exists yet");
    return;
  }
  deps.logger.info({ job: "predictions", result }, "Scheduled predictions run finished");
}

// Wraps a scheduled job so a thrown/rejected error is logged, not left to
// surface as an unhandled rejection inside node-cron's own timer callback —
// one job failing must never stop the process or block later scheduled
// ticks of this or any other job.
export function guarded(name: string, logger: Logger, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, "Scheduled job threw unexpectedly");
    }
  };
}

export interface Scheduler {
  /** Names of the jobs actually scheduled, for logging/introspection and tests. */
  jobs: string[];
  stop(): void;
}

// Starts all recurring sync/prediction jobs in-process. Assumes a single
// backend instance — node-cron has no cross-process coordination, so
// running this in more than one replica would sync everything N times over
// with no lock between them (see Deployment.md's "Known gaps").
export function startScheduler(deps: SchedulerDeps): Scheduler {
  const tasks: ScheduledTask[] = [];
  const jobs: string[] = [];
  const options = { timezone: "UTC", noOverlap: true };

  function add(name: string, expression: string, fn: () => Promise<void>): void {
    tasks.push(cron.schedule(expression, guarded(name, deps.logger, fn), options));
    jobs.push(name);
  }

  if (isProviderConfigured(deps.provider)) {
    add("sync_fixtures", FIXTURES_SYNC_CRON, () => runFixturesSync(deps));
    add("sync_team_statistics", TEAM_STATISTICS_SYNC_CRON, () => runTeamStatisticsSync(deps));
    add("sync_injuries", INJURIES_SYNC_CRON, () => runInjuriesSync(deps));
    add("sync_standings", STANDINGS_SYNC_CRON, () => runStandingsSync(deps));
    add("sync_lineups", LINEUPS_SYNC_CRON, () => runLineupsSync(deps));
    add("sync_odds", ODDS_SYNC_CRON, () => runOddsSync(deps));
  } else {
    // No fabricated syncing against an unconfigured provider — skip
    // scheduling these entirely (rather than scheduling them to silently
    // no-op every tick) and say why, once, at startup.
    deps.logger.warn(
      "Scheduler starting with no football data provider configured (FOOTBALL_DATA_PROVIDER=null) — " +
        "fixture/team-statistics/injuries/standings/lineups/odds sync jobs will NOT be scheduled. " +
        "The predictions job still runs; it reads from the database, not the provider."
    );
  }

  // Always scheduled: reads team_statistics already in the database rather
  // than calling the provider, so it isn't gated on one being configured
  // (matches /admin/predictions/run, which has never required a provider).
  add("predictions", PREDICTIONS_CRON, () => runPredictions(deps));

  deps.logger.info({ jobs }, "Scheduler started");

  return {
    jobs,
    stop() {
      for (const task of tasks) task.stop();
    }
  };
}
