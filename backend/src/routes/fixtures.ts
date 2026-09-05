import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { listFixtures, todayRangeUtc, type FixtureSummary } from "../services/fixturesService.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAuth } from "../middleware/auth.js";
import { TtlCache, cached } from "../lib/ttlCache.js";

// 60 seconds: nothing in this app updates fixtures faster than that
// (FIXTURES_SYNC_CRON is once daily; lineups/odds, the closest-to-kickoff
// jobs, run every 15 minutes) — a short TTL keeps the "today's fixtures"
// page, this app's default landing view, off the database on every single
// page load without meaningfully delaying anyone seeing new data.
const TODAY_FIXTURES_CACHE_TTL_MS = 60 * 1000;

const filtersSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  competitionId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  status: z.enum(["scheduled", "live", "finished", "postponed", "cancelled", "abandoned"]).optional(),
  includeSynthetic: z.enum(["true", "false"]).optional()
});

// Every route here requires a signed-in user (any role) — the platform is
// no longer publicly browsable; see README.md → "User access control".
export function createFixturesRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  const todayFixturesCache = new TtlCache<{ data: FixtureSummary[]; meta: { from: string; to: string; count: number } }>(
    TODAY_FIXTURES_CACHE_TTL_MS
  );

  router.get("/fixtures/today", async (req, res, next) => {
    try {
      const { from, to } = todayRangeUtc();
      const includeSynthetic = req.query.includeSynthetic === "true";
      // Keyed on from/to too, not just includeSynthetic: todayRangeUtc()
      // only actually changes once every 24 hours, but this guarantees a
      // cache entry from just before midnight UTC is never served as
      // "today" for up to TODAY_FIXTURES_CACHE_TTL_MS after the day rolls
      // over, rather than relying on that being shorter than the TTL.
      const body = await cached(todayFixturesCache, `${from}|${to}|${includeSynthetic}`, async () => {
        const fixtures = await listFixtures(supabase, { from, to }, includeSynthetic);
        return { data: fixtures, meta: { from, to, count: fixtures.length } };
      });
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/fixtures", async (req, res, next) => {
    try {
      const parsed = filtersSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_query");
      }
      const { includeSynthetic, ...filters } = parsed.data;
      const fixtures = await listFixtures(supabase, filters, includeSynthetic === "true");
      res.json({ data: fixtures, meta: { count: fixtures.length } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
