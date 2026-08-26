# Outstanding Tasks

## Security

- [x] `/api/admin/*` authentication — `requireAdmin` middleware
  (`backend/src/middleware/requireAdmin.ts`) verifies a Supabase JWT via
  `auth.getUser()` and requires `user_profiles.role = 'admin'`, applied to
  the whole admin router. Verified manually against a running server
  (missing header → 401, malformed header → 401, unrecognized token → 401)
  and unit-tested against a fake Supabase client (6 tests) — **not yet
  exercised against a real Supabase project's actual JWTs**, only against
  the fake's `auth.getUser`/`user_profiles` behavior. Test against a live
  project before relying on it in production.
- [ ] No signup or role-assignment UI exists — the only way to create an
  admin today is the manual SQL step in README.md → "Creating the first
  admin user." Fine for one operator, not for a real admin team.
- [ ] Add request logging/audit trail for admin actions (who ran
  `/admin/sync`, when, with what result) — `requireAdmin` knows the
  authenticated user id at that point but nothing persists it yet.
- [ ] Consider token revocation/expiry edge cases explicitly: `auth.getUser()`
  should reject an expired or revoked token, but this hasn't been verified
  against Supabase's actual token lifecycle (only against the test fake,
  which has no concept of expiry).

## Data

- [x] Implement a real `FixtureProvider` — `ApiFootballProvider`
  (`backend/src/providers/ApiFootballProvider.ts`), registered in
  `providers/registry.ts`. **Not yet verified against a live API key** —
  see `Data_Sources.md`'s caveat. Get a real key and run `POST
  /api/admin/sync?days=1` against a real Supabase project before trusting it.
- [x] Build the fixture ingestion job — `syncFixtures.ts`, idempotent via
  the fixture's own external id (not the natural key — a postponed fixture
  keeps its id but changes kickoff time).
- [ ] Verify `ApiFootballProvider`'s response mapping against a live key —
  field names/shapes are implemented from documentation, not a confirmed
  live response.
- [ ] Populate team nationality (`teams.country_id`) — intentionally left
  null by `syncFixtures.ts` (see `Data_Sources.md`); needs a dedicated
  `/teams` sync.
- [ ] Sync a real `/countries` list so competitions/teams get an
  authoritative country id and flag instead of match-by-name.
- [x] Build a team-statistics sync job — `syncTeamStatistics.ts`, calling
  the vendor's own aggregated `/teams/statistics` endpoint (not computed
  from our own results) for every distinct (team, competition, season)
  implied by real fixtures, writing `overall`/`home`/`away` scope rows.
  **Not yet verified against a live API key** — same caveat as fixtures.
- [ ] No results-sync job exists — `syncFixtures.ts` only pulls a rolling
  window of fixtures (today + N days), so historical results aren't
  backfilled into our own `fixtures` table. `syncTeamStatistics.ts` doesn't
  need that (it uses the vendor's pre-aggregated stats endpoint instead),
  but nothing else in this repo benefits from historical results yet —
  worth doing once head-to-head analysis (spec section 11) is built.
- [ ] `syncTeamStatistics.ts` only populates `overall`/`home`/`away`
  scopes — `last_5`/`last_10` (spec section 9's rolling windows) need
  actual match-by-match results, which the vendor's aggregated endpoint
  doesn't provide; that's the results-sync job above, not this one.
- [ ] Build injuries/lineups/standings/odds sync jobs — `ApiFootballProvider`
  already implements the underlying calls (`getInjuries`, `getLineup`,
  `getStandings`); no job calls them yet.
- [ ] Wire `syncFixturesForDateRange`, `syncTeamStatistics`, and
  `generatePredictionsForUpcomingFixtures` to a scheduler (cron / Cloud
  Scheduler / Supabase Edge Function cron) instead of manual admin-endpoint
  calls. Order matters: fixtures before team-statistics before predictions,
  since each depends on the previous one's output.
- [ ] Revisit the find-then-insert reference-data upserts
  (`referenceDataService.ts`) for a race condition if ingestion is ever
  parallelized — see its code comments.
- [ ] Set `competition_type` correctly (`syncFixtures.ts` hardcodes
  `"league"` for every synced competition — API-Football's league payload
  doesn't distinguish league/cup in the fixtures endpoint response used
  here; needs its own `/leagues` sync to get this right).

## Model

- [ ] Backtesting pipeline: load historical results, walk-forward
  train/validation/test split, write to `model_evaluations`.
- [ ] Add at least one additional model (e.g. gradient boosting) and compare
  against the Poisson baseline before calling anything an "ensemble."
- [ ] Fit the Dixon-Coles `RHO` parameter from real data instead of using
  the current fixed approximation (`ml-service/app/models/poisson.py`).
- [ ] League-specific calibration once enough leagues have real data.

## Frontend

- [ ] Dashboard, search, notifications, and admin UI — none exist yet.
- [ ] Daily analysis and accumulator research pages.
- [ ] User accounts (Supabase Auth) — schema (`user_profiles`) is ready,
  frontend has no auth flow yet.

## Infra

- [ ] CI: add a security-scanning step (e.g. `npm audit` gate, `pip-audit`)
  before deployment.
- [ ] Production deployment target and config (frontend hosting, backend
  hosting, ML service hosting) — currently Dockerfiles/compose only.
- [ ] Caching layer for fixtures/standings once there's a real provider
  worth caching.

## Housekeeping

- [ ] `npm audit` reported vulnerabilities in dev dependencies (eslint 8
  chain) for both `backend` and `frontend` — track and upgrade to ESLint 9
  when the flat-config migration is scheduled.
