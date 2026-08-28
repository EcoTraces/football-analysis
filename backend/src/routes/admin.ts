import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
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
