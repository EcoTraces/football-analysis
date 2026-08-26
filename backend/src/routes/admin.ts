import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { PredictionClient } from "../services/predictionClient.js";
import { generatePredictionsForUpcomingFixtures } from "../jobs/generatePredictions.js";
import { syncFixturesForDateRange } from "../jobs/syncFixtures.js";
import { syncTeamStatistics } from "../jobs/syncTeamStatistics.js";
import { syncInjuries } from "../jobs/syncInjuries.js";
import { syncStandings } from "../jobs/syncStandings.js";
import { syncLineups } from "../jobs/syncLineups.js";
import type { FootballDataProvider } from "../providers/types.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAdmin } from "../middleware/requireAdmin.js";

const MAX_SYNC_DAYS = 14; // Guardrail against an accidental huge/expensive sync.
const MAX_LINEUP_WINDOW_HOURS = 168; // 7 days — same stopgap reasoning as MAX_SYNC_DAYS.

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
      const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(Math.trunc(hoursParam), 1), MAX_LINEUP_WINDOW_HOURS) : 24;

      const result = await syncLineups(supabase, provider, logger, hours);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/predictions/run", async (req, res, next) => {
    try {
      const { data: modelVersion, error } = await supabase
        .from("model_versions")
        .select("id")
        .eq("name", "poisson-baseline")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!modelVersion) {
        res.status(409).json({
          error: { code: "no_model_version", message: "No poisson-baseline model_version row exists yet." }
        });
        return;
      }

      const client = new PredictionClient(mlServiceUrl);
      const result = await generatePredictionsForUpcomingFixtures(supabase, client, modelVersion.id, logger);
      res.json({ data: result });
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
