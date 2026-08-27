import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAuth } from "../middleware/auth.js";

// Every route here requires a signed-in user (any role) — see
// README.md → "User access control".
export function createTeamsRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  router.get("/teams/:id", async (req, res, next) => {
    try {
      const { data: team, error } = await supabase
        .from("teams")
        .select("id, country_id, name, short_name, crest_url, venue_id")
        .eq("id", req.params.id)
        .maybeSingle();

      if (error) throw new Error(`Failed to load team: ${error.message}`);
      if (!team) throw new ApiError(404, "Team not found", "not_found");

      const { data: stats, error: statsError } = await supabase
        .from("team_statistics")
        .select(
          "season_id, scope, matches_played, goals_scored, goals_conceded, xg, xga, shots, shots_on_target, possession_pct, corners, clean_sheets, failed_to_score, source_timestamp, is_synthetic"
        )
        .eq("team_id", req.params.id);

      if (statsError) throw new Error(`Failed to load team statistics: ${statsError.message}`);

      res.json({ data: { ...team, statistics: stats ?? [] } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
