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
| 6. Ingestion pipeline | 🟡 Fixtures only | `syncFixtures.ts` is idempotent and tested; injuries/lineups/standings/odds have provider methods but no sync job yet |
| 7. Data normalization | 🟡 Partial | Reference-data upsert (country/competition/season/team) by external id done; team nationality and competition type not yet correctly populated |
| 8. Backend API | ✅ Core routes done | fixtures/matches/teams/competitions/standings/health/admin |
| 9. Prediction engine | 🟡 Baseline only | Poisson/Dixon-Coles; no ensemble, no other algorithms yet |
| 10. Model training/backtesting | ⬜ Not started | No historical dataset loaded; `model_evaluations` has no writer |
| 11. Frontend | 🟡 Core pages done | Fixtures today + match detail; no dashboard/search/auth UI |
| 12. Analytics dashboard | ⬜ Not started | |
| 13. Daily analysis | ⬜ Not started | |
| 14. Accumulator research | ⬜ Not started | |
| 15. Notifications | ⬜ Not started | Schema exists (`notifications` table); no delivery |
| 16. Admin dashboard (UI) | ⬜ Not started | API endpoints exist (`/api/admin/*`), no UI, no auth guard |
| 17. Testing | 🟡 Ongoing | Unit tests for all business logic shipped so far; no integration/E2E yet |
| 18. Security | 🟡 Partial | helmet/CORS/rate-limit/zod validation done; **no auth on admin routes — must fix before any public deploy** |
| 19. Performance optimization | ⬜ Not started | No caching layer yet |
| 20. Production deployment | ⬜ Not started | Dockerfiles + compose only; no hosting configured |

## Immediate next steps (see Task.md for details)

1. Add authentication/authorization to `/api/admin/*` before deploying
   anywhere reachable — `/admin/sync` can now pull real data, which makes
   this more urgent, not less.
2. Get a real API-Football key and run `POST /api/admin/sync?days=1`
   against a real Supabase project to verify `ApiFootballProvider`'s
   mapping against a live response — it has only been tested against
   documentation-derived fakes so far.
3. Build a results-sync/team-statistics job so `team_statistics.overall` is
   populated from real match history — predictions still can't run on
   non-synthetic fixtures until this exists, even with real fixtures now
   syncable.
4. Wire `syncFixturesForDateRange` and the prediction job to a scheduler
   instead of manual admin triggers.
5. Start the backtesting pipeline once enough real historical results exist.
