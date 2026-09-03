# Roadmap

Phases follow the master spec's development workflow. Status reflects this
repository as of the initial scaffold — see `Changelog.md` for dates.

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
| 17. Testing | 🟡 Ongoing | Unit tests for all business logic shipped so far, including auth middleware against a fake Supabase client; no integration/E2E or real-Supabase-project test yet |
| 18. Security | 🟡 Partial | helmet/CORS/rate-limit/zod validation done; the entire app (not just `/api/admin/*`) now requires a signed-in user, admin routes additionally require the admin role (unverified against a real project — see Task.md); a real signup + admin-promotion UI now exists, closing the "no signup/role-assignment UI" gap; a role self-escalation RLS gap was found and fixed (`0004_user_profiles_role_guard.sql`, also unverified against a live project); still no admin-action audit log |
| 19. Performance optimization | ⬜ Not started | No caching layer yet |
| 20. Production deployment | 🟡 Backend deploy config only | `render.yaml` Blueprint for the backend exists (`Deployment.md`), now defaulting to `FOOTBALL_DATA_PROVIDER=football-data-org` and `SCHEDULER_ENABLED=true` (only `FOOTBALL_DATA_ORG_API_KEY` and the Supabase secrets need entering at deploy time); not yet actually deployed anywhere (no hosting account connected in this environment) — ML service and frontend still have no concrete hosting target |
| 21. Observability | 🟡 Infrastructure done, OBSERVATION PENDING | `GET /admin/jobs`/`GET /admin/jobs/summary` (real `ingestion_runs` history), `GET /health/scheduler`, `GET /health/api-football`, `GET /health/data` with per-dataset freshness — all built and tested against fakes; the scheduler has NOT yet run for real against live data over any meaningful period (see "Immediate next steps" below and `Task.md`) |

## Immediate next steps (see Task.md for details)

**Steps 1 and 3–5 below are now BLOCKED ONLY on a real Supabase project**,
not on a data-provider key — `FOOTBALL_DATA_ORG_API_KEY` is real and has
already verified `FootballDataOrgProvider`'s own HTTP mapping directly (see
`Changelog.md`'s "First live verification" entry), but no Supabase project
is reachable from this environment to also verify the
database-writing/reference-data side, `requireAdmin` against real JWTs, or
the scheduler running unattended. `render.yaml` now defaults to
`FOOTBALL_DATA_PROVIDER=football-data-org` and `SCHEDULER_ENABLED=true`,
ready to deploy the moment a Supabase project and a Render account are
connected — see `Deployment.md`. Step 2 (api-football specifically) is
still additionally blocked on a real `FOOTBALL_DATA_API_KEY`, which remains
unavailable in this environment. Creating either requires a human with a
real account — see README.md → "Configuring a live football data provider"
for the exact steps. Everything these steps need (the client, retry/
rate-limit handling, the sync jobs, the scheduler, the observability
endpoints) is already built and tested against fakes; only the live
verification itself is outstanding for the pieces above.

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
