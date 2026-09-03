import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccumulatorRecommendations, getMatchesToAvoid, getTop20 } from "../services/screeningService.js";
import { createRequireAuth } from "../middleware/auth.js";

const MAX_TOP_N = 20;

// AI Football Analyst screening endpoints (Phase 1) — any signed-in user,
// same auth level as /matches/:id, not admin-only (this is a read-only
// view of already-generated ensemble_predictions rows).
export function createScreeningRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  router.get("/top20", async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? MAX_TOP_N);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_TOP_N) : MAX_TOP_N;
      const data = await getTop20(supabase, limit);
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/matches-to-avoid", async (_req, res, next) => {
    try {
      const data = await getMatchesToAvoid(supabase);
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/accumulators", async (req, res, next) => {
    try {
      const legsParam = req.query.legs !== undefined ? Number(req.query.legs) : undefined;
      const legs = legsParam !== undefined && Number.isFinite(legsParam) ? Math.trunc(legsParam) : undefined;
      const data = await getAccumulatorRecommendations(supabase, legs);
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
