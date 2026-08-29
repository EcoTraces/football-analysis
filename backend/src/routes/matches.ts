import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../middleware/errorHandler.js";
import { getCurrentPredictions } from "../services/predictionsService.js";
import { getTeamNamesById } from "../services/teamsService.js";
import { classifyFreshness } from "../lib/freshness.js";
import { createRequireAuth } from "../middleware/auth.js";

const paramsSchema = z.object({ id: z.string().uuid() });

// Extracted from the route handler so it's directly testable against
// FakeSupabase, the same pattern routes/me.ts's getOrCreateProfile
// already uses — rather than adding a supertest-style HTTP testing
// dependency to this codebase for the sake of one route.
export async function getMatchDetail(supabase: SupabaseClient, matchId: string) {
  const { data: fixture, error } = await supabase
    .from("fixtures")
    .select(
      "id, competition_id, season_id, home_team_id, away_team_id, venue_id, referee_id, round, kickoff_utc, status, home_score, away_score, importance_tags, source, source_timestamp, is_synthetic"
    )
    .eq("id", matchId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load match: ${error.message}`);
  if (!fixture) return null;

  const [predictions, teamNamesById] = await Promise.all([
    getCurrentPredictions(supabase, fixture.id as string),
    getTeamNamesById(supabase, [fixture.home_team_id as string, fixture.away_team_id as string])
  ]);

  return {
    ...fixture,
    homeTeamName: teamNamesById.get(fixture.home_team_id as string) ?? null,
    awayTeamName: teamNamesById.get(fixture.away_team_id as string) ?? null,
    freshness: classifyFreshness(fixture.source_timestamp as string, "fixtures"),
    predictions,
    predictionsAvailable: predictions.length > 0
  };
}

// Every route here requires a signed-in user (any role) — see
// README.md → "User access control".
export function createMatchesRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  router.get("/matches/:id", async (req, res, next) => {
    try {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) throw new ApiError(400, "Invalid match id", "invalid_params");

      const match = await getMatchDetail(supabase, parsed.data.id);
      if (!match) throw new ApiError(404, "Match not found", "not_found");

      res.json({ data: match });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
