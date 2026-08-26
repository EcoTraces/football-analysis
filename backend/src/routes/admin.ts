import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { PredictionClient } from "../services/predictionClient.js";
import { generatePredictionsForUpcomingFixtures } from "../jobs/generatePredictions.js";

// NOTE: This route has no authentication/authorization middleware attached
// yet. It MUST be wrapped with an admin-role check (Supabase JWT verification
// against user_profiles.role = 'admin') before this ever ships publicly —
// tracked in Task.md. Do not expose this port beyond an internal network
// until that is wired in.
export function createAdminRouter(supabase: SupabaseClient, mlServiceUrl: string, logger: Logger): Router {
  const router = Router();

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
