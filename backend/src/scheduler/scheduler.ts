import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { acquireJobLock } from "../lib/jobLock.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";
import { syncInjuries } from "../jobs/syncInjuries.js";
import { syncStandings } from "../jobs/syncStandings.js";
import { syncLineups } from "../jobs/syncLineups.js";
import { syncOdds } from "../jobs/syncOdds.js";
import { syncFixtureStatistics } from "../jobs/syncFixtureStatistics.js";
import { syncPlayerStatistics } from "../jobs/syncPlayerStatistics.js";
import { matchFixturesToSecondaryProvider } from "../jobs/matchFixturesToSecondaryProvider.js";
import { runLatestPoissonPredictionsJob } from "../jobs/generatePredictions.js";
import { runLeagueCalibration } from "../jobs/calibrateLeagues.js";
import { computeCurrentEloRatings } from "../jobs/computeEloRatings.js";
import { runLatestEnsemblePredictionsJob } from "../jobs/generateEnsemblePredictions.js";
import { buildAccumulatorRecommendations } from "../jobs/buildAccumulators.js";

export interface SchedulerDeps {
  supabase: SupabaseClient;
  provider: FootballDataProvider;
  // Used only for sync_injuries/sync_lineups/sync_odds and the fixture-
  // matching job ahead of them (see matchFixturesToSecondaryProvider.ts) —
  // everything else still reads from `provider`. Optional and defaulting
  // to `provider` (via oddsProvider() below) so every existing deployment/
  // test that never wires a distinct secondary keeps behaving exactly as
  // it did before this field existed.
  secondaryProvider?: FootballDataProvider;
  mlServiceUrl: string;
  logger: Logger;
}

function oddsProvider(deps: SchedulerDeps): FootballDataProvider {
  return deps.secondaryProvider ?? deps.provider;
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
export const PLAYER_STATISTICS_SYNC_CRON = "35 2 * * *"; // Same team/season-scoped shape as team-statistics — grouped right after it.
// Between team/player-statistics and injuries: needs fixtures already
// synced (02:00) to have something to match, and must finish before
// sync_injuries (02:45) and the every-15-minute sync_lineups/sync_odds
// ticks go looking for a secondary-provider external_ref.
export const MATCH_FIXTURES_SECONDARY_PROVIDER_CRON = "40 2 * * *";
export const INJURIES_SYNC_CRON = "45 2 * * *";
export const STANDINGS_SYNC_CRON = "0 3 * * *";
export const FIXTURE_STATISTICS_SYNC_CRON = "10 3 * * *"; // Before predictions — a finished match's corners don't change once posted, so once a day is enough (unlike lineups/odds, nothing about it needs to be "closer to kickoff").
export const LEAGUE_CALIBRATION_CRON = "12 3 * * *"; // Between fixture-statistics and predictions — predictions should read the freshest per-competition calibration, not yesterday's.
export const PREDICTIONS_CRON = "15 3 * * *";
export const ELO_RATINGS_CRON = "20 3 * * *"; // After predictions — the ensemble predictions job below reads today's Elo ratings, so this must run before that.
export const ENSEMBLE_PREDICTIONS_CRON = "25 3 * * *"; // After elo_ratings — reads Elo ratings, the current poisson-baseline prediction, and today's league calibration.
export const BUILD_ACCUMULATORS_CRON = "30 3 * * *"; // After predictions_ensemble — reads its output, so must run last in the daily chain.
export const LINEUPS_SYNC_CRON = "0,15,30,45 * * * *";
export const ODDS_SYNC_CRON = "5,20,35,50 * * * *";

const FIXTURES_SYNC_DAYS = 3; // Today + 2 days ahead — enough runway between daily runs without an expensive wide sync.
const KICKOFF_WINDOW_HOURS = 24; // Same default as the admin endpoints; frequency (every 15m), not window width, is what "closer to kickoff" buys here.
const FIXTURE_STATISTICS_WINDOW_HOURS = 72; // Matches the admin endpoint's own default — 3 days back is enough to catch a finished match the vendor was slow to finalize stats for.
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

export async function runPlayerStatisticsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncPlayerStatistics(deps.supabase, deps.provider, deps.logger);
  deps.logger.info({ job: "sync_player_statistics", result }, "Scheduled sync finished");
}

export async function runInjuriesSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncInjuries(deps.supabase, oddsProvider(deps), deps.logger);
  deps.logger.info({ job: "sync_injuries", result }, "Scheduled sync finished");
}

export async function runStandingsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncStandings(deps.supabase, deps.provider, deps.logger);
  deps.logger.info({ job: "sync_standings", result }, "Scheduled sync finished");
}

export async function runLineupsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncLineups(deps.supabase, oddsProvider(deps), deps.logger, KICKOFF_WINDOW_HOURS);
  deps.logger.info({ job: "sync_lineups", result }, "Scheduled sync finished");
}

export async function runOddsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncOdds(deps.supabase, oddsProvider(deps), deps.logger, KICKOFF_WINDOW_HOURS);
  deps.logger.info({ job: "sync_odds", result }, "Scheduled sync finished");
}

// Runs ahead of sync_injuries/sync_lineups/sync_odds (see their own cron
// constants below) so a fixture created by `provider`'s own sync earlier
// this run has a chance to be linked to its `secondaryProvider` counterpart
// before those three jobs go looking for one.
export async function runMatchFixturesToSecondaryProvider(deps: SchedulerDeps): Promise<void> {
  const result = await matchFixturesToSecondaryProvider(deps.supabase, oddsProvider(deps), deps.logger);
  deps.logger.info({ job: "match_fixtures_secondary_provider", result }, "Scheduled sync finished");
}

export async function runFixtureStatisticsSync(deps: SchedulerDeps): Promise<void> {
  const result = await syncFixtureStatistics(deps.supabase, deps.provider, deps.logger, FIXTURE_STATISTICS_WINDOW_HOURS);
  deps.logger.info({ job: "sync_fixture_statistics", result }, "Scheduled sync finished");
}

// Reads only from fixtures already in the database (no provider call) —
// same reasoning as runPredictions below for why this isn't gated behind
// isProviderConfigured.
export async function runLeagueCalibrationSync(deps: SchedulerDeps): Promise<void> {
  const result = await runLeagueCalibration(deps.supabase, deps.logger);
  deps.logger.info({ job: "calibrate_leagues", result }, "Scheduled sync finished");
}

export async function runPredictions(deps: SchedulerDeps): Promise<void> {
  const result = await runLatestPoissonPredictionsJob(deps.supabase, deps.mlServiceUrl, deps.logger, PREDICTIONS_WINDOW_HOURS);
  if (!result.modelVersionId) {
    deps.logger.warn({ job: "predictions" }, "Scheduled predictions run skipped: no poisson-baseline model_version row exists yet");
    return;
  }
  deps.logger.info({ job: "predictions", result }, "Scheduled predictions run finished");
}

// Reads/writes only fixtures and team_elo_ratings already in the database
// (no provider call, no ml-service call — see computeEloRatings.ts's
// module docstring for why rating maintenance is in-process) — same
// reasoning as runLeagueCalibrationSync for why this isn't gated behind
// isProviderConfigured.
export async function runEloRatings(deps: SchedulerDeps): Promise<void> {
  const result = await computeCurrentEloRatings(deps.supabase, deps.logger);
  deps.logger.info({ job: "compute_elo_ratings", result }, "Scheduled Elo rating computation finished");
}

// Reads only the database (current poisson-baseline predictions, Elo
// ratings, team_statistics, injuries, odds_snapshots) and calls
// ml-service — no football data provider call, same reasoning as
// runPredictions for why this isn't gated behind isProviderConfigured.
export async function runEnsemblePredictions(deps: SchedulerDeps): Promise<void> {
  const result = await runLatestEnsemblePredictionsJob(deps.supabase, deps.mlServiceUrl, deps.logger);
  if (!result.modelVersionId) {
    deps.logger.warn({ job: "predictions_ensemble" }, "Scheduled ensemble predictions run skipped: no ensemble model_version row exists yet");
    return;
  }
  deps.logger.info({ job: "predictions_ensemble", result }, "Scheduled ensemble predictions run finished");
}

// Reads only ensemble_predictions/fixtures/config already in the
// database — no provider or ml-service call, same reasoning as
// runLeagueCalibrationSync for why this isn't gated behind
// isProviderConfigured.
export async function runBuildAccumulators(deps: SchedulerDeps): Promise<void> {
  const result = await buildAccumulatorRecommendations(deps.supabase, deps.logger);
  deps.logger.info({ job: "build_accumulators", result }, "Scheduled accumulator build finished");
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

// Cross-process guard, composed around guarded() (see add() below) rather
// than into it: guarded() is a general "don't let a thrown error escape
// node-cron's callback" wrapper with no opinion on locking, while this is
// specifically "don't run at all if another instance already claimed this
// job's lock" (job_locks, 0016_job_locks.sql — see jobLock.ts). Exported
// for direct unit testing, same reasoning as guarded() itself: real cron
// timing isn't something a fast test should depend on.
export function withJobLock(jobName: string, deps: SchedulerDeps, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const acquired = await acquireJobLock(deps.supabase, jobName, deps.logger);
    if (!acquired) {
      deps.logger.info({ job: jobName }, "Skipped: another instance already holds this job's lock");
      return;
    }
    await fn();
  };
}

export interface ScheduledJobStatus {
  name: string;
  cronExpression: string;
  /** ISO timestamp of the next scheduled run, or null if node-cron can't compute one (e.g. just stopped). */
  nextRun: string | null;
}

export interface Scheduler {
  /** Names of the jobs actually scheduled, for logging/introspection and tests. */
  jobs: string[];
  /** Per-job cron expression and next-run time, for GET /health/scheduler. */
  status(): ScheduledJobStatus[];
  stop(): void;
}

// Starts all recurring sync/prediction jobs in-process. Assumes a single
// backend instance — node-cron has no cross-process coordination, so
// running this in more than one replica would sync everything N times over
// with no lock between them (see Deployment.md's "Known gaps").
export function startScheduler(deps: SchedulerDeps): Scheduler {
  const entries: Array<{ name: string; expression: string; task: ScheduledTask }> = [];
  const options = { timezone: "UTC", noOverlap: true };

  function add(name: string, expression: string, fn: () => Promise<void>): void {
    const task = cron.schedule(expression, guarded(name, deps.logger, withJobLock(name, deps, fn)), options);
    entries.push({ name, expression, task });
  }

  if (isProviderConfigured(deps.provider)) {
    add("sync_fixtures", FIXTURES_SYNC_CRON, () => runFixturesSync(deps));
    add("sync_team_statistics", TEAM_STATISTICS_SYNC_CRON, () => runTeamStatisticsSync(deps));
    add("sync_player_statistics", PLAYER_STATISTICS_SYNC_CRON, () => runPlayerStatisticsSync(deps));
    add("sync_standings", STANDINGS_SYNC_CRON, () => runStandingsSync(deps));
    add("sync_fixture_statistics", FIXTURE_STATISTICS_SYNC_CRON, () => runFixtureStatisticsSync(deps));
  } else {
    // No fabricated syncing against an unconfigured provider — skip
    // scheduling these entirely (rather than scheduling them to silently
    // no-op every tick) and say why, once, at startup.
    deps.logger.warn(
      "Scheduler starting with no football data provider configured (FOOTBALL_DATA_PROVIDER=null) — " +
        "fixture/team-statistics/player-statistics/standings/fixture-statistics sync jobs will NOT be " +
        "scheduled. The predictions and league-calibration jobs still run; they read from the database, " +
        "not the provider."
    );
  }

  // Gated on the odds/injuries/lineups provider specifically (defaults to
  // `provider` when no distinct secondary is configured — see
  // oddsProvider()), independent of the block above: a deployment can have
  // fixtures configured but odds/injuries/lineups not, or vice versa.
  if (isProviderConfigured(oddsProvider(deps))) {
    add("match_fixtures_secondary_provider", MATCH_FIXTURES_SECONDARY_PROVIDER_CRON, () => runMatchFixturesToSecondaryProvider(deps));
    add("sync_injuries", INJURIES_SYNC_CRON, () => runInjuriesSync(deps));
    add("sync_lineups", LINEUPS_SYNC_CRON, () => runLineupsSync(deps));
    add("sync_odds", ODDS_SYNC_CRON, () => runOddsSync(deps));
  } else {
    deps.logger.warn(
      "Scheduler starting with no odds/injuries/lineups provider configured — match_fixtures_secondary_provider/ " +
        "sync_injuries/sync_lineups/sync_odds jobs will NOT be scheduled."
    );
  }

  // Always scheduled: reads fixtures/team_statistics already in the
  // database rather than calling the provider, so neither is gated on one
  // being configured (matches /admin/predictions/run, which has never
  // required a provider). calibrate_leagues runs first — predictions
  // should read the freshest per-competition calibration, not stale data.
  add("calibrate_leagues", LEAGUE_CALIBRATION_CRON, () => runLeagueCalibrationSync(deps));
  add("predictions", PREDICTIONS_CRON, () => runPredictions(deps));
  add("compute_elo_ratings", ELO_RATINGS_CRON, () => runEloRatings(deps));
  add("predictions_ensemble", ENSEMBLE_PREDICTIONS_CRON, () => runEnsemblePredictions(deps));
  add("build_accumulators", BUILD_ACCUMULATORS_CRON, () => runBuildAccumulators(deps));

  const jobs = entries.map((e) => e.name);
  deps.logger.info({ jobs }, "Scheduler started");

  return {
    jobs,
    status() {
      return entries.map((e) => {
        const nextRun = e.task.getNextRun();
        return { name: e.name, cronExpression: e.expression, nextRun: nextRun ? nextRun.toISOString() : null };
      });
    },
    stop() {
      for (const e of entries) e.task.stop();
    }
  };
}
