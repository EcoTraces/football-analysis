# Roadmap

Phases follow the master spec's development workflow. Status reflects this
repository as of the initial scaffold — see `Changelog.md` for dates.

| Phase | Status | Notes |
|---|---|---|
| 1. Audit existing project | ✅ Done | New repo; no prior football code existed |
| 2. PRD | ✅ Done | `PRD.md` |
| 3. Architecture | ✅ Done | `Architecture.md` |
| 4. Database design | ✅ Done | `Database.md`, `supabase/migrations/0001_init.sql` |
| 5. Data providers | 🟡 Abstraction only | `NullProvider` in place; no real vendor integrated (needs a licensed API key) |
| 6. Ingestion pipeline | ⬜ Not started | Blocked on phase 5 |
| 7. Data normalization | 🟡 Partial | Schema/constraints exist; no real-provider mapping code yet |
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
   anywhere reachable.
2. Implement one real `FixtureProvider` (e.g. against a licensed
   football-data API) and a corresponding ingestion job.
3. Backfill `team_statistics` from real results so predictions can run on
   non-synthetic fixtures.
4. Wire the prediction job to a scheduler instead of manual trigger.
5. Start the backtesting pipeline once enough real historical results exist.
