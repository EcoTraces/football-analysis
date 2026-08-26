# Roadmap

Phases follow the master spec's development workflow. Status reflects this
repository as of the initial scaffold — see `Changelog.md` for dates.

| Phase | Status | Notes |
|---|---|---|
| 1. Audit existing project | ✅ Done | New repo; no prior football code existed |
| 2. PRD | ✅ Done | `PRD.md` |
| 3. Architecture | ✅ Done | `Architecture.md` |
| 4. Database design | ✅ Done | `Database.md`, `supabase/migrations/0001_init.sql` |
| 5. Data providers | 🟡 Implemented, unverified | `ApiFootballProvider` against api-football v3; not yet exercised against a live key (see `Data_Sources.md`) |
| 6. Ingestion pipeline | 🟡 Fixtures + team stats | `syncFixtures.ts` and `syncTeamStatistics.ts` are idempotent and tested; injuries/lineups/standings/odds have provider methods but no sync job yet |
| 7. Data normalization | 🟡 Partial | Reference-data upsert (country/competition/season/team) by external id done; team nationality and competition type not yet correctly populated |
| 8. Backend API | ✅ Core routes done | fixtures/matches/teams/competitions/standings/health/admin |
| 9. Prediction engine | 🟡 Baseline only | Poisson/Dixon-Coles; no ensemble, no other algorithms yet |
| 10. Model training/backtesting | ⬜ Not started | No historical dataset loaded; `model_evaluations` has no writer |
| 11. Frontend | 🟡 Core pages done | Fixtures today + match detail; no dashboard/search/auth UI |
| 12. Analytics dashboard | ⬜ Not started | |
| 13. Daily analysis | ⬜ Not started | |
| 14. Accumulator research | ⬜ Not started | |
| 15. Notifications | ⬜ Not started | Schema exists (`notifications` table); no delivery |
| 16. Admin dashboard (UI) | ⬜ Not started | API endpoints exist and are now authenticated (`/api/admin/*`); no UI |
| 17. Testing | 🟡 Ongoing | Unit tests for all business logic shipped so far, including auth middleware against a fake Supabase client; no integration/E2E or real-Supabase-project test yet |
| 18. Security | 🟡 Partial | helmet/CORS/rate-limit/zod validation done; admin routes now require a Supabase JWT + admin role (unverified against a real project — see Task.md); still no audit log, no signup/role-assignment UI |
| 19. Performance optimization | ⬜ Not started | No caching layer yet |
| 20. Production deployment | ⬜ Not started | Dockerfiles + compose only; no hosting configured |

## Immediate next steps (see Task.md for details)

1. Test `requireAdmin` against a real Supabase project (create an admin
   user per README.md, get a real JWT, confirm `/api/admin/*` accepts it
   and rejects a non-admin user's JWT) — so far only verified against a
   fake auth client and against a running server's rejection paths.
2. Get a real API-Football key and run `POST /api/admin/sync?days=1`
   against a real Supabase project to verify `ApiFootballProvider`'s
   mapping against a live response — it has only been tested against
   documentation-derived fakes so far.
3. Run `/admin/sync` then `/admin/team-statistics/sync` then
   `/admin/predictions/run` against a real Supabase project + API key to
   confirm predictions actually generate end-to-end on real fixtures —
   `team_statistics.overall` can now be populated (via `syncTeamStatistics.ts`),
   but this full chain hasn't been exercised against live data.
4. Wire `syncFixturesForDateRange`, `syncTeamStatistics`, and the
   prediction job to a scheduler instead of manual admin triggers.
5. Start the backtesting pipeline once enough real historical results exist.
