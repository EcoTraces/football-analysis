import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider } from "../providers/types.js";

export function createHealthRouter(supabase: SupabaseClient, provider: FootballDataProvider): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Reports whether the database is reachable and how the deployed provider
  // is configured, without leaking credentials — for the admin dashboard's
  // "API health / data source" panel (spec sections 30, 41).
  router.get("/health/data", async (_req, res) => {
    const { error, count } = await supabase
      .from("fixtures")
      .select("id", { count: "exact", head: true })
      .eq("is_synthetic", false);

    res.json({
      database: error ? "unreachable" : "reachable",
      databaseError: error?.message ?? null,
      productionFixtureCount: count ?? 0,
      provider: provider.name,
      providerConfigured: provider.name !== "null"
    });
  });

  router.get("/health/model", async (_req, res) => {
    res.json({
      status: "not_yet_wired",
      message: "Model monitoring endpoint placeholder — see ML_Model.md for the planned metrics."
    });
  });

  return router;
}
