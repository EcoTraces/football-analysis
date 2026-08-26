# Outstanding Tasks

## Security (blocking any public deployment)

- [ ] `/api/admin/*` has no authentication/authorization. Add Supabase JWT
  verification + `user_profiles.role = 'admin'` check before this is
  reachable outside a trusted network.
- [ ] Add request logging/audit trail for admin actions once auth exists.

## Data

- [ ] Implement a real `FixtureProvider` (e.g. against a licensed
  football-data API) and register it in `providers/registry.ts`.
- [ ] Build the fixture ingestion job (idempotent upsert keyed on the
  `fixtures` natural-key unique index).
- [ ] Build a results-sync job and a team-statistics aggregation job so
  `team_statistics.overall` is populated from real match history.
- [ ] Build injuries/lineups/standings/odds sync jobs once a provider is
  chosen for each.
- [ ] Wire `generatePredictionsForUpcomingFixtures` to a scheduler (cron /
  Cloud Scheduler / Supabase Edge Function cron).

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
