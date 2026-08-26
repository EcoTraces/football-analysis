import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { runLatestPoissonPredictionsJob } from "../jobs/generatePredictions.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";
import { syncInjuries } from "../jobs/syncInjuries.js";
import { syncStandings } from "../jobs/syncStandings.js";
import { syncLineups } from "../jobs/syncLineups.js";
import { syncOdds } from "../jobs/syncOdds.js";
import type { FootballDataProvider } from "../providers/types.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAdmin } from "../middleware/requireAdmin.js";

const MAX_SYNC_DAYS = 14; // Guardrail against an accidental huge/expensive sync.
const MAX_KICKOFF_WINDOW_HOURS = 168; // 7 days — same stopgap reasoning as MAX_SYNC_DAYS; shared by lineups and odds sync.
const MAX_JOB_HISTORY_LIMIT = 200;
const JOB_HISTORY_SUMMARY_SAMPLE = 500; // Rows scanned client-side to compute "last run per job" — see /admin/jobs/summary.

export interface IngestionRunRow {
  id: string;
  job_name: string;
  provider: string;
  status: string;
  records_processed: number;
  records_rejected: number;
  started_at: string;
  finished_at: string | null;
}

// Pure and exported for direct unit testing — reduces a batch of
// ingestion_runs rows (already ordered newest-first by the caller) into
// "most recent run" and "most recent succeeded run" per distinct job_name.
export function summarizeIngestionRuns(
  runsNewestFirst: IngestionRunRow[]
): Record<string, { lastRun: IngestionRunRow; lastSuccess: IngestionRunRow | null }> {
  const summary: Record<string, { lastRun: IngestionRunRow; lastSuccess: IngestionRunRow | null }> = {};
  for (const run of runsNewestFirst) {
    const existing = summary[run.job_name];
    if (!existing) {
      summary[run.job_name] = { lastRun: run, lastSuccess: run.status === "succeeded" ? run : null };
    } else if (!existing.lastSuccess && run.status === "succeeded") {
      existing.lastSuccess = run;
    }
  }
  return summary;
}

function requireProvider(provider: FootballDataProvider): void {
  if (provider.name === "null") {
    throw new ApiError(
      409,
      "No football data provider is configured (FOOTBALL_DATA_PROVIDER=null). See Data_Sources.md.",
      "no_provider_configured"
    );
  }
}

// Every route on this router requires a valid Supabase JWT for a user whose
// user_profiles.role is 'admin' — see requireAdmin.ts and README.md →
// "Creating the first admin user". Applied once via router.use() so a
// future route added here can't accidentally ship unauthenticated.
export function createAdminRouter(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  mlServiceUrl: string,
  logger: Logger
): Router {
  const router = Router();
  router.use(createRequireAdmin(supabase));

  router.post("/admin/sync", async (req, res, next) => {
    try {
      requireProvider(provider);

      const daysParam = Number(req.query.days ?? 1);
      const days = Number.isFinite(daysParam) ? Math.min(Math.max(Math.trunc(daysParam), 1), MAX_SYNC_DAYS) : 1;

      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + (days - 1));

      const result = await syncFixturesForDateRange(supabase, provider, from.toISOString(), to.toISOString(), logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/team-statistics/sync", async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncTeamStatistics(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/injuries/sync", async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncInjuries(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/standings/sync", async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncStandings(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/lineups/sync", async (req, res, next) => {
    try {
      requireProvider(provider);

      const hoursParam = Number(req.query.hours ?? 24);
      const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(Math.trunc(hoursParam), 1), MAX_KICKOFF_WINDOW_HOURS) : 24;

      const result = await syncLineups(supabase, provider, logger, hours);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/odds/sync", async (req, res, next) => {
    try {
      requireProvider(provider);

      const hoursParam = Number(req.query.hours ?? 24);
      const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(Math.trunc(hoursParam), 1), MAX_KICKOFF_WINDOW_HOURS) : 24;

      const result = await syncOdds(supabase, provider, logger, hours);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/predictions/run", async (_req, res, next) => {
    try {
      const result = await runLatestPoissonPredictionsJob(supabase, mlServiceUrl, logger);
      if (!result.modelVersionId) {
        res.status(409).json({
          error: { code: "no_model_version", message: "No poisson-baseline model_version row exists yet." }
        });
        return;
      }
      res.json({ data: { runId: result.runId, processed: result.processed, skipped: result.skipped, failed: result.failed } });
    } catch (err) {
      next(err);
    }
  });

  // Job execution history from ingestion_runs — every sync job (and now
  // predictions) writes one row per invocation here already; this just
  // reads it back. Backs the admin monitoring page's "recent jobs / failed
  // jobs" view and the multi-day scheduler observation this table exists
  // to make possible (see Task.md).
  router.get("/admin/jobs", async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_JOB_HISTORY_LIMIT) : 50;
      const jobName = typeof req.query.job_name === "string" ? req.query.job_name : null;

      let query = supabase
        .from("ingestion_runs")
        .select("id, job_name, provider, status, records_processed, records_rejected, error_summary, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(limit);
      if (jobName) query = query.eq("job_name", jobName);

      const { data, error } = await query;
      if (error) throw new Error(error.message);

      res.json({ data: data ?? [] });
    } catch (err) {
      next(err);
    }
  });

  // Per-job "last run" / "last successful run" summary, derived from the
  // same table — reduced client-side (a handful of distinct job_name
  // values) rather than one query per job, since PostgREST has no "distinct
  // on" the JS client can express directly.
  router.get("/admin/jobs/summary", async (_req, res, next) => {
    try {
      const { data, error } = await supabase
        .from("ingestion_runs")
        .select("id, job_name, provider, status, records_processed, records_rejected, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(JOB_HISTORY_SUMMARY_SAMPLE);
      if (error) throw new Error(error.message);

      res.json({ data: summarizeIngestionRuns((data ?? []) as IngestionRunRow[]) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/data-health", async (_req, res, next) => {
    try {
      const [{ count: fixtureCount }, { count: syntheticCount }, { count: predictionCount }] = await Promise.all([
        supabase.from("fixtures").select("id", { count: "exact", head: true }).eq("is_synthetic", false),
        supabase.from("fixtures").select("id", { count: "exact", head: true }).eq("is_synthetic", true),
        supabase.from("predictions").select("id", { count: "exact", head: true }).is("superseded_at", null)
      ]);

      res.json({
        data: {
          productionFixtures: fixtureCount ?? 0,
          syntheticFixtures: syntheticCount ?? 0,
          currentPredictions: predictionCount ?? 0
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
