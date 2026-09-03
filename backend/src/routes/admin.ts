import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { runLatestPoissonPredictionsJob } from "../jobs/generatePredictions.js";
import { runLatestBacktestJob, type BacktestableModel } from "../jobs/runBacktest.js";
import { runLatestGradientBoostingTrainingJob } from "../jobs/trainGradientBoosting.js";
import { runLatestDixonColesRhoFitJob } from "../jobs/fitDixonColesRho.js";
import { runLeagueCalibration } from "../jobs/calibrateLeagues.js";
import { computeCurrentEloRatings } from "../jobs/computeEloRatings.js";
import {
  getAccumulatorTargets,
  getCompetitionAllowlist,
  getEnsembleWeights,
  getScreeningConfig,
  setCompetitionAllowlistEntry,
  upsertAccumulatorTarget,
  upsertEnsembleWeights,
  upsertScreeningConfig
} from "../services/adminConfigService.js";
import { PredictionClient } from "../services/predictionClient.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";
import { syncInjuries } from "../jobs/syncInjuries.js";
import { syncStandings } from "../jobs/syncStandings.js";
import { syncLineups } from "../jobs/syncLineups.js";
import { syncOdds } from "../jobs/syncOdds.js";
import { syncFixtureStatistics } from "../jobs/syncFixtureStatistics.js";
import { syncPlayerStatistics } from "../jobs/syncPlayerStatistics.js";
import type { FootballDataProvider } from "../providers/types.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAdmin } from "../middleware/requireAdmin.js";

const MAX_SYNC_DAYS = 14; // Guardrail against an accidental huge/expensive sync.
const MAX_KICKOFF_WINDOW_HOURS = 168; // 7 days — same stopgap reasoning as MAX_SYNC_DAYS; shared by lineups and odds sync.
const MAX_JOB_HISTORY_LIMIT = 200;
const JOB_HISTORY_SUMMARY_SAMPLE = 500; // Rows scanned client-side to compute "last run per job" — see /admin/jobs/summary.
const MAX_DATE_RANGE_DAYS = 366; // Each fixture in range costs two point-in-time queries plus one prediction call — bound the blast radius of one request. Shared by backtest and gradient-boosting training, which walk the same kind of range.
const MAX_BACKTEST_RESULTS_LIMIT = 200;

const isoDateString = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be a valid date/timestamp" });

// Shared by both schemas below — from/to/competitionId, plus the same two
// range guardrails (from <= to, range within MAX_DATE_RANGE_DAYS). Zod's
// generics don't preserve an `.extend()`ed shape through a shared
// higher-order refine helper cleanly, so this is a plain function applied
// at each call site rather than a schema-returning generic.
function applyDateRangeGuardrails<T extends { from: string; to: string }>(schema: z.ZodType<T>) {
  return schema
    .refine((v) => new Date(v.from).getTime() <= new Date(v.to).getTime(), { message: "from must not be after to" })
    .refine(
      (v) => (new Date(v.to).getTime() - new Date(v.from).getTime()) / (1000 * 60 * 60 * 24) <= MAX_DATE_RANGE_DAYS,
      { message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days` }
    );
}

const dateRangeSchema = z.object({ from: isoDateString, to: isoDateString, competitionId: z.string().uuid().optional() });

// AI Football Analyst config schemas (Phase 1) — weight/threshold bodies
// for PUT /admin/config/*. Sum-to-1 checks live here (Zod), not as a
// database constraint — see migration 0011's header comment for why.
const ensembleWeightsBodySchema = z
  .object({
    elo: z.number().min(0),
    poisson: z.number().min(0),
    form: z.number().min(0),
    homeAway: z.number().min(0),
    injuries: z.number().min(0),
    market: z.number().min(0)
  })
  .refine((w) => Math.abs(w.elo + w.poisson + w.form + w.homeAway + w.injuries + w.market - 1) < 0.01, {
    message: "Weights must sum to 1 (±0.01)"
  });

const screeningConfigBodySchema = z.object({
  scoreWeights: z
    .object({
      ensembleConfidence: z.number().min(0),
      ev: z.number().min(0),
      consensus: z.number().min(0),
      dataQuality: z.number().min(0)
    })
    .refine((w) => Math.abs(w.ensembleConfidence + w.ev + w.consensus + w.dataQuality - 1) < 0.01, {
      message: "Score weights must sum to 1 (±0.01)"
    }),
  riskThresholds: z
    .object({ eliteMin: z.number(), strongMin: z.number(), mediumMin: z.number(), highRiskMin: z.number() })
    .refine((t) => t.eliteMin > t.strongMin && t.strongMin > t.mediumMin && t.mediumMin > t.highRiskMin, {
      message: "Risk thresholds must be strictly descending: eliteMin > strongMin > mediumMin > highRiskMin"
    })
});

const accumulatorTargetParamsSchema = z.object({ legs: z.coerce.number().int().positive() });
const accumulatorTargetBodySchema = z.object({ minSelectionScore: z.number().min(0).max(100), enabled: z.boolean() });

const competitionAllowlistParamsSchema = z.object({ competitionId: z.string().uuid() });
const competitionAllowlistBodySchema = z.object({ enabled: z.boolean() });

const BACKTESTABLE_MODELS = ["poisson-baseline", "gradient-boosting"] as const;

const backtestRunQuerySchema = applyDateRangeGuardrails(
  dateRangeSchema.extend({ model: z.enum(BACKTESTABLE_MODELS).default("poisson-baseline") })
);

const trainGradientBoostingQuerySchema = applyDateRangeGuardrails(dateRangeSchema);
const fitRhoQuerySchema = applyDateRangeGuardrails(dateRangeSchema);

// Every sync/prediction trigger below makes real outbound calls to a
// rate/cost-limited third-party API once one is configured — the app-wide
// rate limiter in index.ts (120 req/60s) is far too generous for these
// specifically, since nothing about normal operation (an occasional manual
// trigger, or the scheduler's own much slower cadence) needs anywhere near
// that. Keyed by the authenticated admin's user id (set by requireAdmin,
// which always runs first via router.use() below) rather than IP, so
// multiple admins behind the same office/NAT IP don't share one budget.
const syncTriggerLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.authUser?.id ?? req.ip ?? "unknown",
  message: { error: { code: "rate_limited", message: "Too many sync triggers — wait a few minutes before retrying." } }
});

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

export interface AdminUserSummary {
  id: string;
  email: string | null;
  role: string;
  displayName: string | null;
  createdAt: string;
}

export const roleUpdateSchema = z.object({ role: z.enum(["user", "admin"]) });

// Pure and exported for direct unit testing — joins auth.users (via the
// admin API, the only way to read it) with user_profiles' role/display_name.
export async function listUsersWithRoles(supabase: SupabaseClient): Promise<AdminUserSummary[]> {
  const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (authError) throw new Error(`Failed to list auth users: ${authError.message}`);

  const { data: profiles, error: profilesError } = await supabase
    .from("user_profiles")
    .select("id, display_name, role, created_at");
  if (profilesError) throw new Error(`Failed to list user_profiles: ${profilesError.message}`);

  const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  return authUsers.users.map((u: { id: string; email?: string; created_at: string }) => {
    const profile = profileById.get(u.id);
    return {
      id: u.id,
      email: u.email ?? null,
      role: (profile?.role as string | undefined) ?? "user",
      displayName: (profile?.display_name as string | null | undefined) ?? null,
      createdAt: u.created_at
    };
  });
}

// Pure and exported for direct unit testing. Refuses to demote the only
// remaining admin (see the route comment) and 404s a role change targeting
// a user with no user_profiles row rather than silently affecting zero rows.
export async function updateUserRole(
  supabase: SupabaseClient,
  targetUserId: string,
  role: "user" | "admin"
): Promise<{ id: string; role: string }> {
  const { data: targetProfile, error: targetError } = await supabase
    .from("user_profiles")
    .select("id, role")
    .eq("id", targetUserId)
    .maybeSingle();
  if (targetError) throw new Error(targetError.message);
  if (!targetProfile) {
    throw new ApiError(404, "No user_profiles row exists for this user id.", "user_not_found");
  }

  if (role === "user" && targetProfile.role === "admin") {
    const { data: admins, error: adminsError } = await supabase.from("user_profiles").select("id").eq("role", "admin");
    if (adminsError) throw new Error(adminsError.message);
    if ((admins ?? []).length <= 1) {
      throw new ApiError(409, "Refusing to demote the only remaining admin account.", "last_admin");
    }
  }

  const { error } = await supabase.from("user_profiles").update({ role }).eq("id", targetUserId);
  if (error) throw new Error(error.message);

  return { id: targetUserId, role };
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
// "User access control". Applied once via router.use() so a future route
// added here can't accidentally ship unauthenticated.
export function createAdminRouter(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  mlServiceUrl: string,
  logger: Logger
): Router {
  const router = Router();
  router.use(createRequireAdmin(supabase));

  router.post("/admin/sync", syncTriggerLimit, async (req, res, next) => {
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

  router.post("/admin/team-statistics/sync", syncTriggerLimit, async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncTeamStatistics(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/player-statistics/sync", syncTriggerLimit, async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncPlayerStatistics(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/injuries/sync", syncTriggerLimit, async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncInjuries(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/standings/sync", syncTriggerLimit, async (_req, res, next) => {
    try {
      requireProvider(provider);
      const result = await syncStandings(supabase, provider, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/lineups/sync", syncTriggerLimit, async (req, res, next) => {
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

  router.post("/admin/odds/sync", syncTriggerLimit, async (req, res, next) => {
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

  router.post("/admin/fixture-statistics/sync", syncTriggerLimit, async (req, res, next) => {
    try {
      requireProvider(provider);

      const hoursParam = Number(req.query.hours ?? 72);
      const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(Math.trunc(hoursParam), 1), MAX_KICKOFF_WINDOW_HOURS) : 72;

      const result = await syncFixtureStatistics(supabase, provider, logger, hours);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Recomputes every competition's real per-league goal averages from its
  // own finished, non-synthetic fixtures (calibrateLeagues.ts) — no
  // provider call, so no requireProvider() guard, same as
  // /admin/predictions/run. Also runs daily on the scheduler
  // (calibrate_leagues, right before predictions); this route is for an
  // out-of-cycle manual trigger, e.g. right after a fixtures backfill.
  router.post("/admin/league-calibration/run", syncTriggerLimit, async (_req, res, next) => {
    try {
      const result = await runLeagueCalibration(supabase, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Reads back every competition's current calibration, joined with its
  // name for readability — small enough (one row per real competition)
  // that no pagination/limit param is needed yet.
  router.get("/admin/league-calibration/results", async (_req, res, next) => {
    try {
      const [{ data: calibrations, error }, { data: competitions, error: competitionsError }] = await Promise.all([
        supabase.from("league_calibration").select("id, competition_id, league_avg_home_goals, league_avg_away_goals, sample_size, computed_at"),
        supabase.from("competitions").select("id, name")
      ]);
      if (error) throw new Error(error.message);
      if (competitionsError) throw new Error(competitionsError.message);

      const competitionNameById = new Map((competitions ?? []).map((c) => [c.id as string, c.name as string]));
      const enriched = (calibrations ?? []).map((row) => ({
        ...row,
        competitionName: competitionNameById.get(row.competition_id as string) ?? null
      }));

      res.json({ data: enriched });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/predictions/run", syncTriggerLimit, async (_req, res, next) => {
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

  // Walk-forward backtest of the 1x2 market over a chosen date range — see
  // runBacktest.ts. `model` picks which registered model_versions row (and
  // which ml-service endpoint) gets scored — defaults to poisson-baseline
  // for compatibility with callers that don't pass it. Running this twice
  // over the same range with a different `model` is how this platform
  // compares a new model against the baseline (Task.md's "before calling
  // anything an ensemble" requirement). Deliberately not on the scheduler:
  // an admin picks the window each time, so this only ever runs on
  // explicit request.
  router.post("/admin/backtest/run", syncTriggerLimit, async (req, res, next) => {
    try {
      const parsed = backtestRunQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_query");
      }

      const result = await runLatestBacktestJob(
        supabase,
        mlServiceUrl,
        logger,
        {
          from: new Date(parsed.data.from).toISOString(),
          to: new Date(parsed.data.to).toISOString(),
          competitionId: parsed.data.competitionId
        },
        parsed.data.model as BacktestableModel
      );

      if (!result.modelVersionId) {
        res.status(409).json({
          error: { code: "no_model_version", message: `No ${parsed.data.model} model_version row exists yet.` }
        });
        return;
      }
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Trains the gradient-boosting model (ml-service's second model — see
  // ML_Model.md) on point-in-time features built from real, finished,
  // non-synthetic fixtures in the chosen range (trainGradientBoosting.ts).
  // Same guardrails/rate-limiting as backtest; also never on the scheduler
  // — retraining is an explicit, occasional admin action.
  router.post("/admin/model/gradient-boosting/train", syncTriggerLimit, async (req, res, next) => {
    try {
      const parsed = trainGradientBoostingQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_query");
      }

      const result = await runLatestGradientBoostingTrainingJob(supabase, mlServiceUrl, logger, {
        from: new Date(parsed.data.from).toISOString(),
        to: new Date(parsed.data.to).toISOString(),
        competitionId: parsed.data.competitionId
      });

      if (!result.modelVersionId) {
        res.status(409).json({
          error: {
            code: "no_model_version",
            message: "No gradient-boosting model_version row exists yet. See ML_Model.md for the manual bootstrap step."
          }
        });
        return;
      }
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Fits the Dixon-Coles low-score correlation parameter (rho) from real,
  // point-in-time match data (fitDixonColesRho.ts) instead of
  // poisson.py's fixed RHO = -0.1 approximation — see ML_Model.md's "Rho
  // fitting" section. `competitionId` branches the outcome: omitted, this
  // is a GLOBAL fit (updates poisson-baseline's existing model_versions
  // row and becomes ml-service's process-wide fallback rho); present,
  // it's a COMPETITION-SCOPED fit (stored in competition_rho, applied only
  // to that competition's own future predictions — never clobbers the
  // global fallback every other competition still falls back to). Same
  // guardrails/rate-limiting as backtest/training; never on the scheduler.
  router.post("/admin/model/poisson/fit-rho", syncTriggerLimit, async (req, res, next) => {
    try {
      const parsed = fitRhoQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_query");
      }

      const result = await runLatestDixonColesRhoFitJob(supabase, mlServiceUrl, logger, {
        from: new Date(parsed.data.from).toISOString(),
        to: new Date(parsed.data.to).toISOString(),
        competitionId: parsed.data.competitionId
      });

      if (!result.modelVersionId) {
        res.status(409).json({
          error: { code: "no_model_version", message: "No poisson-baseline model_version row exists yet." }
        });
        return;
      }
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Passthrough to ml-service's /rho_status — whether a fit is currently
  // in effect for /predict/poisson (and therefore for backtests run
  // against poisson-baseline) or predictions are still using the fixed
  // default. Not rate limited: a read-only status check, same as
  // /admin/data-health.
  router.get("/admin/model/poisson/rho-status", async (_req, res, next) => {
    try {
      const client = new PredictionClient(mlServiceUrl);
      res.json({ data: await client.getRhoStatus() });
    } catch (err) {
      next(err);
    }
  });

  // Every competition's current per-competition rho fit, enriched with its
  // competition name — same "list everything, join for readability"
  // pattern as /admin/league-calibration/results and /admin/backtest/results.
  router.get("/admin/model/poisson/competition-rho", async (_req, res, next) => {
    try {
      const [{ data: rhoRows, error }, { data: competitions, error: competitionsError }] = await Promise.all([
        supabase
          .from("competition_rho")
          .select(
            "id, model_version_id, competition_id, fitted_rho, default_rho, sample_size, informative_matches, log_likelihood_at_fitted_rho, log_likelihood_at_default_rho, evaluation_window, computed_at"
          ),
        supabase.from("competitions").select("id, name")
      ]);
      if (error) throw new Error(error.message);
      if (competitionsError) throw new Error(competitionsError.message);

      const competitionNameById = new Map((competitions ?? []).map((c) => [c.id as string, c.name as string]));
      const enriched = (rhoRows ?? []).map((row) => ({
        ...row,
        competitionName: competitionNameById.get(row.competition_id as string) ?? null
      }));

      res.json({ data: enriched });
    } catch (err) {
      next(err);
    }
  });

  // Reads back model_evaluations rows written by backtest runs — the
  // "did the backtest I ran actually produce anything" view, since
  // /admin/backtest/run's own response is ephemeral once the page reloads.
  // Enriched with each row's model name (from model_versions) so results
  // from different models are distinguishable in the UI without a second
  // round trip per row.
  router.get("/admin/backtest/results", async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitParam)
        ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_BACKTEST_RESULTS_LIMIT)
        : 50;

      const [{ data, error }, { data: modelVersions, error: modelVersionsError }] = await Promise.all([
        supabase
          .from("model_evaluations")
          .select("id, model_version_id, competition_id, market, evaluation_window, accuracy, log_loss, brier_score, sample_size, created_at")
          .order("created_at", { ascending: false })
          .limit(limit),
        supabase.from("model_versions").select("id, name")
      ]);
      if (error) throw new Error(error.message);
      if (modelVersionsError) throw new Error(modelVersionsError.message);

      const modelNameById = new Map((modelVersions ?? []).map((mv) => [mv.id as string, mv.name as string]));
      const enriched = (data ?? []).map((row) => ({ ...row, modelName: modelNameById.get(row.model_version_id as string) ?? null }));

      res.json({ data: enriched });
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

  // Lists every real (auth.users) account, joined with its user_profiles
  // role/display_name — the "real admin team" tool README.md → "User
  // access control" promised: promote/demote without direct SQL, except
  // for the one first-admin bootstrap that still needs it. Only the first
  // page (up to 200 accounts) is fetched; this platform has no user base
  // anywhere near that size yet, so pagination is deferred until it
  // actually matters (see Task.md).
  router.get("/admin/users", async (_req, res, next) => {
    try {
      res.json({ data: await listUsersWithRoles(supabase) });
    } catch (err) {
      next(err);
    }
  });

  // Promotes/demotes an account. Refuses to demote the last remaining
  // admin — there is no other way back in short of direct database access,
  // and locking every admin out is a strictly worse failure mode than
  // rejecting the request.
  router.post("/admin/users/:id/role", async (req, res, next) => {
    try {
      const parsed = roleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_body");
      }
      res.json({ data: await updateUserRole(supabase, req.params.id as string, parsed.data.role) });
    } catch (err) {
      next(err);
    }
  });

  // Recomputes every team's global Elo rating from scratch by replaying
  // its finished, non-synthetic fixture history (computeEloRatings.ts) —
  // no provider call, so no requireProvider() guard, same reasoning as
  // /admin/league-calibration/run. Also runs daily on the scheduler
  // (compute_elo_ratings); this route is for an out-of-cycle manual
  // trigger, e.g. right after a fixtures backfill.
  router.post("/admin/elo/recompute", syncTriggerLimit, async (_req, res, next) => {
    try {
      const result = await computeCurrentEloRatings(supabase, logger);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  // Reads back every team's current Elo rating, joined with its name —
  // small enough (one row per team that has ever played a real fixture)
  // that no pagination/limit param is needed yet, same as
  // /admin/league-calibration/results.
  router.get("/admin/elo/ratings", async (_req, res, next) => {
    try {
      const [{ data: ratings, error }, { data: teams, error: teamsError }] = await Promise.all([
        supabase.from("team_elo_ratings").select("id, team_id, rating, matches_played, computed_at").order("rating", { ascending: false }),
        supabase.from("teams").select("id, name")
      ]);
      if (error) throw new Error(error.message);
      if (teamsError) throw new Error(teamsError.message);

      const teamNameById = new Map((teams ?? []).map((t) => [t.id as string, t.name as string]));
      const enriched = (ratings ?? []).map((row) => ({
        ...row,
        teamName: teamNameById.get(row.team_id as string) ?? null
      }));
      res.json({ data: enriched });
    } catch (err) {
      next(err);
    }
  });

  // AI Football Analyst admin config (Phase 1) — ensemble weights, score
  // weights/risk thresholds, accumulator leg targets, and the competition
  // allowlist. None of these call an external provider or ml-service, so
  // no syncTriggerLimit — same reasoning as the read-only calibration
  // routes above and the existing /admin/users role-update route.
  router.get("/admin/config/ensemble-weights", async (_req, res, next) => {
    try {
      res.json({ data: await getEnsembleWeights(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/admin/config/ensemble-weights", async (req, res, next) => {
    try {
      const parsed = ensembleWeightsBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_body");
      await upsertEnsembleWeights(supabase, parsed.data, req.authUser!.id);
      res.json({ data: await getEnsembleWeights(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/config/screening", async (_req, res, next) => {
    try {
      res.json({ data: await getScreeningConfig(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/admin/config/screening", async (req, res, next) => {
    try {
      const parsed = screeningConfigBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_body");
      await upsertScreeningConfig(supabase, parsed.data, req.authUser!.id);
      res.json({ data: await getScreeningConfig(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/config/accumulator-targets", async (_req, res, next) => {
    try {
      res.json({ data: await getAccumulatorTargets(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/admin/config/accumulator-targets/:legs", async (req, res, next) => {
    try {
      const paramsParsed = accumulatorTargetParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) throw new ApiError(400, "Invalid legs parameter", "invalid_params");
      const bodyParsed = accumulatorTargetBodySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new ApiError(400, bodyParsed.error.issues.map((i) => i.message).join("; "), "invalid_body");
      await upsertAccumulatorTarget(supabase, paramsParsed.data.legs, bodyParsed.data.minSelectionScore, bodyParsed.data.enabled, req.authUser!.id);
      res.json({ data: await getAccumulatorTargets(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/config/competition-allowlist", async (_req, res, next) => {
    try {
      res.json({ data: await getCompetitionAllowlist(supabase) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/config/competition-allowlist/:competitionId", async (req, res, next) => {
    try {
      const paramsParsed = competitionAllowlistParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) throw new ApiError(400, "Invalid competitionId parameter", "invalid_params");
      const bodyParsed = competitionAllowlistBodySchema.safeParse(req.body);
      if (!bodyParsed.success) throw new ApiError(400, bodyParsed.error.issues.map((i) => i.message).join("; "), "invalid_body");
      await setCompetitionAllowlistEntry(supabase, paramsParsed.data.competitionId, bodyParsed.data.enabled, req.authUser!.id);
      res.json({ data: await getCompetitionAllowlist(supabase) });
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
