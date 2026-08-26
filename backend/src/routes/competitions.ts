import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

export function createCompetitionsRouter(supabase: SupabaseClient): Router {
  const router = Router();

  router.get("/leagues", async (req, res, next) => {
    try {
      const includeSynthetic = req.query.includeSynthetic === "true";
      const query = supabase
        .from("competitions")
        .select("id, country_id, name, short_name, tier, competition_type, is_active")
        .eq("is_active", true)
        .order("name", { ascending: true });

      const { data, error } = await query;
      if (error) throw new Error(`Failed to load competitions: ${error.message}`);

      // Competitions themselves aren't flagged synthetic, but keep the
      // seed's placeholder country/competition out of production listings
      // unless explicitly requested (dev/test tooling).
      const filtered = includeSynthetic
        ? data
        : (data ?? []).filter((c) => c.name !== "Synthetic Premier Division");

      res.json({ data: filtered, meta: { count: filtered?.length ?? 0 } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/standings/:leagueId", async (req, res, next) => {
    try {
      const { data, error } = await supabase
        .from("standings")
        .select(
          "team_id, position, played, wins, draws, losses, goals_for, goals_against, points, form, source_timestamp, is_synthetic"
        )
        .eq("season_id", req.params.leagueId)
        .eq("is_synthetic", false)
        .order("position", { ascending: true });

      if (error) throw new Error(`Failed to load standings: ${error.message}`);
      res.json({ data, meta: { count: data?.length ?? 0 } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
