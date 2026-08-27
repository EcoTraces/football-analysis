import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { listFixtures, todayRangeUtc } from "../services/fixturesService.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createRequireAuth } from "../middleware/auth.js";

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

  router.get("/fixtures/today", async (req, res, next) => {
    try {
      const { from, to } = todayRangeUtc();
      const includeSynthetic = req.query.includeSynthetic === "true";
      const fixtures = await listFixtures(supabase, { from, to }, includeSynthetic);
      res.json({ data: fixtures, meta: { from, to, count: fixtures.length } });
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
