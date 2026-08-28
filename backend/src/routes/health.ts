import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider } from "../providers/types.js";
import { ApiFootballProvider } from "../providers/ApiFootballProvider.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { classifyFreshness, type Freshness, type FreshnessDomain } from "../lib/freshness.js";

// GREEN/YELLOW/RED/GRAY mapping onto the existing LIVE/RECENT/STALE/
// UNAVAILABLE classification used elsewhere in the app (frontend badges,
// fixturesService.ts, predictionsService.ts) — kept as an additional field
// here rather than renaming that enum everywhere it's already used.
export function colorFor(freshness: Freshness): "GREEN" | "YELLOW" | "RED" | "GRAY" {
  switch (freshness) {
    case "LIVE":
      return "GREEN";
    case "RECENT":
      return "YELLOW";
    case "STALE":
      return "RED";
    case "UNAVAILABLE":
      return "GRAY";
  }
}

interface FreshnessCheck {
  domain: FreshnessDomain;
  table: string;
  column: string;
  filterSynthetic: boolean;
}

export const FRESHNESS_CHECKS: FreshnessCheck[] = [
  { domain: "fixtures", table: "fixtures", column: "source_timestamp", filterSynthetic: true },
  { domain: "standings", table: "standings", column: "source_timestamp", filterSynthetic: true },
  { domain: "teamStatistics", table: "team_statistics", column: "source_timestamp", filterSynthetic: true },
  { domain: "injuries", table: "injuries", column: "source_timestamp", filterSynthetic: true },
  { domain: "lineups", table: "lineups", column: "source_timestamp", filterSynthetic: true },
  { domain: "odds", table: "odds_snapshots", column: "captured_at", filterSynthetic: true },
  { domain: "fixtureStatistics", table: "fixture_statistics", column: "source_timestamp", filterSynthetic: true },
  { domain: "predictions", table: "predictions", column: "generated_at", filterSynthetic: false }
];

export async function checkFreshness(supabase: SupabaseClient, check: FreshnessCheck) {
  let query = supabase.from(check.table).select(check.column).order(check.column, { ascending: false }).limit(1);
  if (check.filterSynthetic) query = query.eq("is_synthetic", false);
  const { data, error } = await query.maybeSingle<Record<string, string>>();

  const lastUpdated = error || !data ? null : (data[check.column] ?? null);
  const freshness = classifyFreshness(lastUpdated, check.domain);
  return { domain: check.domain, lastUpdated, status: freshness, color: colorFor(freshness) };
}

export function apiFootballHealthStatus(provider: FootballDataProvider) {
  if (provider.name !== "api-football" || !(provider instanceof ApiFootballProvider)) {
    return {
      status: "NOT_CONFIGURED" as const,
      message: "FOOTBALL_DATA_PROVIDER is not set to api-football — see Data_Sources.md.",
      lastRequest: null,
      rateLimit: null
    };
  }

  const lastRequest = provider.getLastRequestStatus();
  const status = lastRequest === null ? "UNKNOWN" : lastRequest.ok ? "CONNECTED" : "ERROR";

  return {
    status: status as "UNKNOWN" | "CONNECTED" | "ERROR",
    message:
      lastRequest === null ? "Configured, but no request has been made yet — trigger a sync or POST /admin/*/sync to find out." : null,
    lastRequest,
    rateLimit: provider.getRateLimitStatus()
  };
}

export function schedulerHealthStatus(scheduler: Scheduler | null) {
  if (!scheduler) {
    return { status: "DISABLED" as const, message: "SCHEDULER_ENABLED=false — jobs run only via POST /api/admin/*.", jobs: [] };
  }
  return { status: "RUNNING" as const, message: null, jobs: scheduler.status() };
}

export function createHealthRouter(supabase: SupabaseClient, provider: FootballDataProvider, scheduler: Scheduler | null): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Reports whether the database is reachable, how the deployed provider is
  // configured, and per-dataset freshness (GREEN/YELLOW/RED/GRAY) — for the
  // admin dashboard's "data health" panel. Never leaks credentials.
  router.get("/health/data", async (_req, res) => {
    const { error, count } = await supabase
      .from("fixtures")
      .select("id", { count: "exact", head: true })
      .eq("is_synthetic", false);

    const freshness = await Promise.all(FRESHNESS_CHECKS.map((check) => checkFreshness(supabase, check)));

    res.json({
      database: error ? "unreachable" : "reachable",
      databaseError: error?.message ?? null,
      productionFixtureCount: count ?? 0,
      provider: provider.name,
      providerConfigured: provider.name !== "null",
      freshness
    });
  });

  // Provider connectivity status derived from real request history — this
  // does NOT make a live call on every hit (that would burn API quota on
  // every health-check poll); it reports what the provider itself observed
  // on its most recent actual request (made by a sync job or an admin
  // trigger), which is null/UNKNOWN until at least one has happened.
  router.get("/health/api-football", (_req, res) => {
    res.json(apiFootballHealthStatus(provider));
  });

  // Whether the in-process cron scheduler (scheduler.ts) is running, and
  // each job's cron expression / next scheduled run — for the admin
  // dashboard and for verifying the scheduler is actually alive during
  // multi-day observation (see Task.md).
  router.get("/health/scheduler", (_req, res) => {
    res.json(schedulerHealthStatus(scheduler));
  });

  router.get("/health/model", async (_req, res) => {
    res.json({
      status: "not_yet_wired",
      message: "Model monitoring endpoint placeholder — see ML_Model.md for the planned metrics."
    });
  });

  return router;
}
