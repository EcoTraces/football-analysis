# Roadmap

Phases follow the master spec's development workflow. Status reflects this
repository as of the initial scaffold — see `Changelog.md` for dates.

**Live status as of 2026-09-05** (this session's own direct checks against
the deployed services — a factual update, not a rewrite of the phases
below, which mostly still describe true limitations): `football-analysis-
backend`, `football-analysis-ml-service`, and a real Supabase project are
all deployed and reachable. `GET /health/data` reports `database:
reachable`, `provider: football-data-org`, `providerConfigured: true`, 443
real (non-synthetic) fixtures; `GET /health/api-football` reports
`CONNECTED` with real rate-limit data; `GET /health/scheduler` reports
`RUNNING` with all 13 jobs listed. This supersedes Phase 20's "not yet
actually deployed anywhere" and "Immediate next steps"'s "no reachable
Supabase project in this environment" below — both were true when written,
describing this repo's own dev/CI sandbox, never production.

**"Deployed" is not "operationally verified" — most of it still isn't
working.** Same session, same live checks: `standings`/`teamStatistics`/
`playerStatistics`/`injuries`/`lineups`/`odds`/`fixtureStatistics`/
`predictions` were all `UNAVAILABLE` in `GET /health/data`'s freshness
report — none of those datasets has ever successfully populated in
production. Manually triggering the underlying jobs surfaced real bugs,
some now fixed this session (see `Changelog.md`): an unbounded `.in()`
query that could exceed a request-length limit at real data volumes
(fixed); no `model_versions` row for `poisson-baseline`/`ensemble` in
production, causing `409` on every prediction run (still needs a one-time
SQL insert — see `ML_Model.md`); `ML_SERVICE_URL` likely still at its
`localhost` default rather than the real ml-service URL, causing `500`s on
anything that calls it (still needs a Render dashboard fix — see
`Deployment.md`). Read phases 5/6/9/14/17/18/19/21 below with this in
mind rather than their original (pre-deployment) wording alone.

| Phase | Status | Notes |
|---|---|---|
| 1. Audit existing project | ✅ Done | New repo; no prior football code existed |
| 2. PRD | ✅ Done | `PRD.md` |
| 3. Architecture | ✅ Done | `Architecture.md` |
| 4. Database design | ✅ Done | `Database.md`, `supabase/migrations/0001_init.sql` |
| 5. Data providers | 🟡 football-data-org partially live-verified; api-football still blocked | Two real providers exist (`Data_Sources.md`). `FootballDataOrgProvider` has been run against a real key and live data (`Changelog.md`'s "First live verification" entry) — fixture/standings mapping confirmed correct, one real bug (a rate-limit header name) found and fixed. `ApiFootballProvider` remains unexercised against a live key — no `FOOTBALL_DATA_API_KEY` exists anywhere in this development environment. Neither has been verified end-to-end against a real Supabase project (the database-writing half of the live check above couldn't run — no reachable Supabase project in this environment either) — see README.md → "Configuring a live football data provider" |
| 6. Ingestion pipeline | 🟡 Fixtures + team stats + injuries + standings + lineups + odds, schedulable | `syncFixtures.ts`, `syncTeamStatistics.ts`, `syncInjuries.ts`, `syncStandings.ts`, `syncLineups.ts` are idempotent and tested; `syncOdds.ts` is tested but deliberately append-only (a real time series, not idempotent-by-upsert); all six plus predictions can now run on a cron via `SCHEDULER_ENABLED=true` (`scheduler.ts`) instead of manual admin calls, assuming a single backend instance |
| 7. Data normalization | 🟡 Partial | Reference-data upsert (country/competition/season/team) by external id done; team nationality and competition type not yet correctly populated |
| 8. Backend API | ✅ Core routes done | fixtures/matches/teams/competitions/standings/health/admin |
| 9. Prediction engine | 🟡 Poisson/Dixon-Coles + gradient boosting + a real ensemble | `poisson-baseline` (with fitted-RHO support, global and per-competition) and `gradient-boosting` for 1x2; a genuine ensemble now also exists (Elo + Poisson + Form + Home/Away + Injuries + Market, weighted and admin-tunable — see `ML_Model.md`'s "Ensemble model" section) — none of the three has been exercised against real, non-synthetic match history yet |
| 10. Model training/backtesting | ⬜ Not started | No historical dataset loaded; `model_evaluations` has no writer |
| 11. Frontend | 🟡 Core pages + auth + admin dashboard done | Fixtures today + match detail, both now sign-in-gated; sign-in/sign-up pages, an admin sync/jobs dashboard, and a Users panel exist (Supabase Auth); no search UI |
| 12. Analytics dashboard | ⬜ Not started | |
| 13. Daily analysis | ⬜ Not started | |
| 14. Accumulator research | 🟡 Phase 1 done | A real accumulator optimizer exists — 5/7/10/15/20-odds targets, greedy leg selection by selection score, same-team correlation penalty, "best overall" flag, and an honest "no high-confidence accumulator today" empty state — see `ML_Model.md`'s "Accumulator optimizer" section. Not yet exercised against real fixture/odds history |
| 15. Notifications | ⬜ Not started | Schema exists (`notifications` table); no delivery |
| 16. Admin dashboard (UI) | ✅ Done | `/admin` (provider connectivity, scheduler status, per-dataset freshness, job history, manual sync triggers) and `/admin/users` (promote/demote) both have a frontend now — no admin action is curl-only anymore |
| 17. Testing | 🟡 Ongoing | Unit tests for all business logic shipped so far, including auth middleware against a fake Supabase client. CI now has a real-Postgres integration test (`db-migrations` job): every migration applies twice, back to back, against a throwaway Postgres 16 container — see `Database.md`'s "Known gaps" for exactly what that does and doesn't verify (schema/DDL validity, not RLS/PostgREST/real-auth behavior). Still no frontend E2E and no test against an actual Supabase project |
| 18. Security | 🟡 Partial | helmet/CORS/rate-limit/zod validation done; the entire app (not just `/api/admin/*`) now requires a signed-in user, admin routes additionally require the admin role (unverified against a real project — see Task.md); a real signup + admin-promotion UI now exists, closing the "no signup/role-assignment UI" gap; a role self-escalation RLS gap was found and fixed (`0004_user_profiles_role_guard.sql`, also unverified against a live project); still no admin-action audit log |
| 19. Performance optimization | 🟡 Started | An in-process TTL cache (`lib/ttlCache.ts`) now sits in front of the read-heaviest, rarely-changing endpoints — `GET /leagues` (10 min), `GET /fixtures/today` (60s), and the three AI Football Analyst screening views `/top20`/`/matches-to-avoid`/`/accumulators` (5 min each). `GET /fixtures`'s many filter combinations and `GET /teams/:id` are deliberately not cached yet — lower hit-rate value, left for a future pass. Time-based expiry only, no active invalidation on write (see that file's module comment for why that's an acceptable tradeoff here); process-local, not shared across replicas, since this app is still a single Render instance |
| 20. Production deployment | 🟡 Live, not fully operational | `render.yaml` Blueprint deployed for real: `football-analysis-backend` and `football-analysis-ml-service` are both live on Render, a real Supabase project is connected, `FOOTBALL_DATA_PROVIDER=football-data-org` is `CONNECTED`, and `SCHEDULER_ENABLED=true` is `RUNNING` (see the live-status note above). Not fully operational yet, though: `ML_SERVICE_URL` on the backend service likely still needs pointing at the real ml-service URL, and production's `model_versions` table needs its one-time manual seed — see the live-status note above and `Deployment.md`/`ML_Model.md`. |
| 21. Observability | 🟡 Infrastructure done, OBSERVATION PENDING | `GET /admin/jobs`/`GET /admin/jobs/summary` (real `ingestion_runs` history), `GET /health/scheduler`, `GET /health/api-football`, `GET /health/data` with per-dataset freshness — all built and tested against fakes; the scheduler has NOT yet run for real against live data over any meaningful period (see "Immediate next steps" below and `Task.md`) |

## Immediate next steps (see Task.md for details)

**Update (2026-09-05): a real Supabase project and Render deployment now
exist** (see the live-status note at the top of this file) — the
"BLOCKED ONLY on a real Supabase project" framing this paragraph
originally had is no longer accurate; that project exists and
`football-data-org` is `CONNECTED` against it in production. What's
actually still blocking steps 1 and 3–5 below is that **this coding
session/environment has no credentials for that live project or Render
account** — no service-role key, no admin JWT, no Render dashboard access
— so verification against them has to be done by a human with real access
(you), not by a future coding session assuming a Supabase project still
needs to be stood up. Step 2 (api-football specifically) is still
additionally blocked on a real `FOOTBALL_DATA_API_KEY`, which has never
existed in any environment this project has run in. Everything these steps
need (the client, retry/rate-limit handling, the sync jobs, the scheduler,
the observability endpoints, the cross-process lock) is already built and
tested against fakes; only the live verification itself is outstanding for
the pieces below.

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
7. ~~Before running more than one backend replica in production, address
   the scheduler's single-instance assumption~~ — done: every scheduled job
   now claims a real Postgres-backed lock (`0016_job_locks.sql`,
   `withJobLock()`) before running, so a second replica skips a job another
   replica already claimed instead of syncing it redundantly. Still worth
   observing against actually-concurrent replicas before fully trusting it
   at scale (see `Data_Sources.md`'s scheduler section) — this Blueprint
   still deploys a single instance either way.

## AI Football Analyst & Accumulator Engine — Phase 2+ (deferred from Phase 1)

Phase 1 (Elo, a real ensemble, EV/edge, selection scoring, 5-tier risk,
Top 20 / Matches to Avoid, the accumulator optimizer, and admin-editable
config — see `ML_Model.md`'s "Ensemble model" section) is done. Named here,
not silently assumed, per the plan the user approved for this feature:

- A second, xG-capable data provider — this platform has no xG/xGA/shots/
  possession data at all today (see `Data_Sources.md`), so Phase 1 dropped
  that ensemble component and redistributed its weight across the rest.
- Live odds-movement/CLV (closing-line-value) tracking — `odds_snapshots`
  is already a time series (see `Database.md`), but nothing analyzes
  movement over time yet.
- Settling `ensemble_predictions`/`accumulator_recommendations` against
  actual results, a P&L computation, and the Performance/ROI/Brier/
  calibration dashboard the spec described — there is no settled
  prediction history yet, so building this now would be premature. The
  versioning (`generated_at`/`superseded_at`) is already shaped to support
  this without a future breaking migration.
- A dedicated Prediction History UI page.
- A dedicated Settings page — Phase 1's admin config lives in
  `AdminDashboard.tsx` alongside everything else.
- Squad/lineup tactical modeling beyond the current simple key-absence
  count (no minutes-played/starting-XI/position data exists yet).
- Fuller natural-language explanations beyond the existing short `factors`
  labels.
- Turning the scheduler on and verifying the live api-football key — this
  was an explicit, separate decision the user made when scoping Phase 1
  (build now against manual-sync/demo-data capability; verify live data
  independently), not a Phase 1 blocker.
