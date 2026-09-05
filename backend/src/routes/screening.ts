import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAccumulatorRecommendations,
  getMatchesToAvoid,
  getTop20,
  type AccumulatorRecommendationView,
  type ScreeningRow
} from "../services/screeningService.js";
import { createRequireAuth } from "../middleware/auth.js";
import { TtlCache, cached } from "../lib/ttlCache.js";

const MAX_TOP_N = 20;

// 5 minutes: these three views are all derived from ensemble_predictions/
// accumulator_recommendations, which only change once a day (the
// predictions_ensemble/build_accumulators scheduler jobs) — a TTL this
// long relative to that cadence still means every real update is visible
// within minutes, while sparing the database from being re-queried on
// every dashboard view/refresh in between.
const SCREENING_CACHE_TTL_MS = 5 * 60 * 1000;

// AI Football Analyst screening endpoints (Phase 1) — any signed-in user,
// same auth level as /matches/:id, not admin-only (this is a read-only
// view of already-generated ensemble_predictions rows).
export function createScreeningRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  const top20Cache = new TtlCache<ScreeningRow[]>(SCREENING_CACHE_TTL_MS);
  const matchesToAvoidCache = new TtlCache<ScreeningRow[]>(SCREENING_CACHE_TTL_MS);
  const accumulatorsCache = new TtlCache<AccumulatorRecommendationView[]>(SCREENING_CACHE_TTL_MS);

  router.get("/top20", async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? MAX_TOP_N);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_TOP_N) : MAX_TOP_N;
      const data = await cached(top20Cache, String(limit), () => getTop20(supabase, limit));
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/matches-to-avoid", async (_req, res, next) => {
    try {
      const data = await cached(matchesToAvoidCache, "all", () => getMatchesToAvoid(supabase));
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/accumulators", async (req, res, next) => {
    try {
      const legsParam = req.query.legs !== undefined ? Number(req.query.legs) : undefined;
      const legs = legsParam !== undefined && Number.isFinite(legsParam) ? Math.trunc(legsParam) : undefined;
      const data = await cached(accumulatorsCache, String(legs), () => getAccumulatorRecommendations(supabase, legs));
      res.json({ data, meta: { count: data.length } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
