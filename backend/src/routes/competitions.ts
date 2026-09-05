import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequireAuth } from "../middleware/auth.js";
import { TtlCache, cached } from "../lib/ttlCache.js";

// 10 minutes: competitions only ever change via a fixture sync creating a
// new one (rare — see referenceDataService.ts's find-or-create), nothing
// like the daily/15-minute cadence the sync jobs otherwise run on, so a
// long TTL here trades very little real staleness for a lot fewer repeat
// reads of an almost-static table.
const LEAGUES_CACHE_TTL_MS = 10 * 60 * 1000;

// Every route here requires a signed-in user (any role) — see
// README.md → "User access control".
export function createCompetitionsRouter(supabase: SupabaseClient): Router {
  const router = Router();
  router.use(createRequireAuth(supabase));

  // One process-lifetime cache per includeSynthetic value (true/false) —
  // see lib/ttlCache.ts for why an in-process cache is the right scope for
  // this app's current single-instance deployment, and why time-based
  // expiry alone (no active invalidation) is an acceptable tradeoff here.
  const leaguesCache = new TtlCache<{ data: unknown; meta: { count: number } }>(LEAGUES_CACHE_TTL_MS);

  router.get("/leagues", async (req, res, next) => {
    try {
      const includeSynthetic = req.query.includeSynthetic === "true";
      const body = await cached(leaguesCache, String(includeSynthetic), async () => {
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
        const filtered = includeSynthetic ? (data ?? []) : (data ?? []).filter((c) => c.name !== "Synthetic Premier Division");

        return { data: filtered, meta: { count: filtered.length } };
      });

      res.json(body);
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
