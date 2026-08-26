# Outstanding Tasks

## Security (blocking any public deployment)

- [ ] `/api/admin/*` has no authentication/authorization. Add Supabase JWT
  verification + `user_profiles.role = 'admin'` check before this is
  reachable outside a trusted network.
- [ ] Add request logging/audit trail for admin actions once auth exists.

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
- [ ] Build a results-sync job and a team-statistics aggregation job so
  `team_statistics.overall` is populated from real match history (currently
  only fixtures — no scores feed team_statistics yet).
- [ ] Build injuries/lineups/standings/odds sync jobs — `ApiFootballProvider`
  already implements the underlying calls (`getTeamStatistics`,
  `getInjuries`, `getLineup`, `getStandings`); no job calls them yet.
- [ ] Wire `syncFixturesForDateRange` and
  `generatePredictionsForUpcomingFixtures` to a scheduler (cron / Cloud
  Scheduler / Supabase Edge Function cron) instead of manual `POST
  /api/admin/sync` and `/api/admin/predictions/run` calls.
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
