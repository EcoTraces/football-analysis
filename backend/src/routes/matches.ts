import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../middleware/errorHandler.js";
import { getCurrentPredictions } from "../services/predictionsService.js";
import { classifyFreshness } from "../lib/freshness.js";

const paramsSchema = z.object({ id: z.string().uuid() });

export function createMatchesRouter(supabase: SupabaseClient): Router {
  const router = Router();

  router.get("/matches/:id", async (req, res, next) => {
    try {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) throw new ApiError(400, "Invalid match id", "invalid_params");

      const { data: fixture, error } = await supabase
        .from("fixtures")
        .select(
          "id, competition_id, season_id, home_team_id, away_team_id, venue_id, referee_id, round, kickoff_utc, status, home_score, away_score, importance_tags, source, source_timestamp, is_synthetic"
        )
        .eq("id", parsed.data.id)
        .maybeSingle();

      if (error) throw new Error(`Failed to load match: ${error.message}`);
      if (!fixture) throw new ApiError(404, "Match not found", "not_found");

      const predictions = await getCurrentPredictions(supabase, fixture.id as string);

      res.json({
        data: {
          ...fixture,
          freshness: classifyFreshness(fixture.source_timestamp as string, "fixtures"),
          predictions,
          predictionsAvailable: predictions.length > 0
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
