import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAuth } from "../middleware/auth.js";
import { TtlCache, cached } from "../lib/ttlCache.js";

// 5 minutes — team_statistics only changes via the daily
// sync_team_statistics scheduler job, same cadence reasoning as the
// screening views (routes/screening.ts).
const TEAM_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;

// Every route here requires a signed-in user (any role) — see
// README.md → "User access control".
export function createTeamsRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  const teamDetailCache = new TtlCache<Record<string, unknown>>(TEAM_DETAIL_CACHE_TTL_MS);

  router.get("/teams/:id", async (req, res, next) => {
    try {
      // A 404 (team not found) throws out of the factory below before
      // cache.set() runs, same as any other error — never cached as a
      // false "not found" if the team is created moments later.
      const body = await cached(teamDetailCache, req.params.id, async () => {
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

        return { ...team, statistics: stats ?? [] };
      });

      res.json({ data: body });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
