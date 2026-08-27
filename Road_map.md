# Roadmap

Phases follow the master spec's development workflow. Status reflects this
repository as of the initial scaffold — see `Changelog.md` for dates.

| Phase | Status | Notes |
|---|---|---|
| 1. Audit existing project | ✅ Done | New repo; no prior football code existed |
| 2. PRD | ✅ Done | `PRD.md` |
| 3. Architecture | ✅ Done | `Architecture.md` |
| 4. Database design | ✅ Done | `Database.md`, `supabase/migrations/0001_init.sql` |
| 5. Data providers | 🟡 Implemented, unverified — BLOCKED on a real key | `ApiFootballProvider` against api-football v3, with retry/backoff and rate-limit tracking; not yet exercised against a live key — no `FOOTBALL_DATA_API_KEY` exists anywhere in this development environment (see `Data_Sources.md` and README.md → "Configuring a live API-Football key") |
| 6. Ingestion pipeline | 🟡 Fixtures + team stats + injuries + standings + lineups + odds, schedulable | `syncFixtures.ts`, `syncTeamStatistics.ts`, `syncInjuries.ts`, `syncStandings.ts`, `syncLineups.ts` are idempotent and tested; `syncOdds.ts` is tested but deliberately append-only (a real time series, not idempotent-by-upsert); all six plus predictions can now run on a cron via `SCHEDULER_ENABLED=true` (`scheduler.ts`) instead of manual admin calls, assuming a single backend instance |
| 7. Data normalization | 🟡 Partial | Reference-data upsert (country/competition/season/team) by external id done; team nationality and competition type not yet correctly populated |
| 8. Backend API | ✅ Core routes done | fixtures/matches/teams/competitions/standings/health/admin |
| 9. Prediction engine | 🟡 Baseline only | Poisson/Dixon-Coles; no ensemble, no other algorithms yet |
| 10. Model training/backtesting | ⬜ Not started | No historical dataset loaded; `model_evaluations` has no writer |
| 11. Frontend | 🟡 Core pages + auth + admin dashboard done | Fixtures today + match detail, both now sign-in-gated; sign-in/sign-up pages, an admin sync/jobs dashboard, and a Users panel exist (Supabase Auth); no search UI |
| 12. Analytics dashboard | ⬜ Not started | |
| 13. Daily analysis | ⬜ Not started | |
| 14. Accumulator research | ⬜ Not started | |
| 15. Notifications | ⬜ Not started | Schema exists (`notifications` table); no delivery |
| 16. Admin dashboard (UI) | ✅ Done | `/admin` (provider connectivity, scheduler status, per-dataset freshness, job history, manual sync triggers) and `/admin/users` (promote/demote) both have a frontend now — no admin action is curl-only anymore |
| 17. Testing | 🟡 Ongoing | Unit tests for all business logic shipped so far, including auth middleware against a fake Supabase client; no integration/E2E or real-Supabase-project test yet |
| 18. Security | 🟡 Partial | helmet/CORS/rate-limit/zod validation done; the entire app (not just `/api/admin/*`) now requires a signed-in user, admin routes additionally require the admin role (unverified against a real project — see Task.md); a real signup + admin-promotion UI now exists, closing the "no signup/role-assignment UI" gap; a role self-escalation RLS gap was found and fixed (`0004_user_profiles_role_guard.sql`, also unverified against a live project); still no admin-action audit log |
| 19. Performance optimization | ⬜ Not started | No caching layer yet |
| 20. Production deployment | ⬜ Not started | Dockerfiles + compose only; no hosting configured |
| 21. Observability | 🟡 Infrastructure done, OBSERVATION PENDING | `GET /admin/jobs`/`GET /admin/jobs/summary` (real `ingestion_runs` history), `GET /health/scheduler`, `GET /health/api-football`, `GET /health/data` with per-dataset freshness — all built and tested against fakes; the scheduler has NOT yet run for real against live data over any meaningful period (see "Immediate next steps" below and `Task.md`) |

## Immediate next steps (see Task.md for details)

**Steps 1–5 below are BLOCKED on a real `FOOTBALL_DATA_API_KEY`.** No such
key exists anywhere in this development environment, and creating one
requires a human to sign up with a real API-Football/RapidAPI account —
see README.md → "Configuring a live API-Football key" for the exact steps
and the commands to run the moment a key is configured. Everything these
steps need (the client, retry/rate-limit handling, the sync jobs, the
scheduler, the observability endpoints) is already built and tested
against fakes; only the live verification itself is outstanding.

1. Test `requireAdmin` against a real Supabase project (create an admin
   user per README.md, get a real JWT, confirm `/api/admin/*` accepts it
   and rejects a non-admin user's JWT) — so far only verified against a
   fake auth client and against a running server's rejection paths. While
   there: apply `0004_user_profiles_role_guard.sql`, sign up a test user
   in the frontend, and confirm they genuinely cannot PATCH their own
   `role` via a direct Supabase client call, then confirm
   `POST /admin/users/:id/role` still works from an admin session — the
   whole point of that migration, unverified against a live project.
2. Get a real API-Football key and run `POST /api/admin/sync?days=1`
   against a real Supabase project to verify `ApiFootballProvider`'s
   mapping against a live response — it has only been tested against
   documentation-derived fakes so far. Check `GET /health/api-football`
   before and after to confirm it flips from `UNKNOWN` to `CONNECTED`.
3. Run `/admin/sync`, `/admin/team-statistics/sync`, `/admin/injuries/sync`,
   `/admin/standings/sync`, `/admin/lineups/sync`, `/admin/odds/sync`, then
   `/admin/predictions/run` against a real Supabase project + API key to
   confirm the whole chain actually works end-to-end on real fixtures —
   none of it has been exercised against live data yet. Use `GET
   /admin/jobs` to confirm each run recorded correctly.
4. Check `syncInjuries.ts`'s status heuristic (`mapInjuryStatus`) against
   real `/injuries` responses — it's a keyword guess over free text, not a
   documented mapping. Also confirm `syncLineups.ts`'s assumption that
   api-football's lineups endpoint never returns a "predicted" (as opposed
   to officially confirmed) lineup, and `syncOdds.ts`'s bet-name
   classification (`mapBet`) against real `/odds` responses.
5. **OBSERVATION PENDING**: run the scheduler (`SCHEDULER_ENABLED=true`) for
   real, over at least 72 hours (7 days preferred), against a real provider
   and Supabase project, in a persistent environment that stays up that
   long — this has NOT started. Use `GET /admin/jobs`/`GET
   /admin/jobs/summary` and `GET /health/scheduler` to monitor job success
   rate, rate-limit events (`GET /health/api-football`'s `rateLimit`
   field), duplicate/stale data, and whether the daily ingestion chain's
   ordering holds up (fixtures → team-stats/injuries/standings →
   predictions) and lineups/odds' 15-minute cadence behaves as expected
   close to kickoff. Do not mark this complete before the observation
   period has actually elapsed — see `Task.md`.
6. Start the backtesting pipeline once enough real historical results exist.
7. Before running more than one backend replica in production, address the
   scheduler's single-instance assumption (`scheduler.ts` has no
   cross-process locking) — either a distributed lock, or moving scheduling
   to an external trigger (e.g. Cloud Scheduler) hitting the existing admin
   endpoints instead of an in-process cron.
