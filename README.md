# Football Analysis

A football analytics and match-prediction platform: fixtures, team/form
analysis, an explainable ensemble-ready prediction engine, and (eventually)
daily/monthly statistical reports — built so real data providers can be
added without rewriting the application.

**Status: early scaffold, not production-ready.** This repository currently
implements one real, working vertical slice end-to-end (fixture → team form →
Poisson prediction → UI) against a schema designed for the full feature set
described in `PRD.md`. It ships with **no football data provider configured**
and **no fabricated production data** — see "What's actually implemented"
below and `Road_map.md` for what's still missing before any of the
broader spec is true.

## Why it looks the way it does

Building the full spec in `PRD.md` in one pass — dozens of countries, a model
ensemble, odds/value analysis, notifications, an admin dashboard, full
backtesting — without a real data provider or user would mean fabricating
data to make it look finished. That violates the platform's own first
principle (`Coding_Rules.md` → "No Fake Data Rule"). Instead this repo has:

- a real database schema for the whole domain (`supabase/migrations/0001_init.sql`),
- a provider abstraction so a real vendor can be plugged in later without
  touching application code (`backend/src/providers/`),
- one complete, tested, honest slice: fixtures → predictions → UI,
- explicit "Data unavailable" states everywhere real data isn't configured,
  instead of demo data pretending to be real.

## What's actually implemented

- **Database** (Supabase/Postgres): full schema — countries, competitions,
  seasons, teams, fixtures, standings, team statistics, injuries, lineups,
  odds, predictions, model versions/evaluations, notifications — with RLS on
  user-owned tables. See `Database.md`.
- **Backend** (Node/Express/TypeScript): health endpoints, fixtures/matches/
  teams/competitions/standings reads, a `FootballDataProvider` abstraction
  with a `NullProvider` default (never fabricates data — returns explicit
  "not configured" responses) and a real `ApiFootballProvider` (disabled by
  default; opt in via env vars), fixture/team-statistics/injuries/standings
  sync jobs, a prediction-generation job, and admin endpoints to trigger
  each — authenticated by a Supabase JWT plus an admin role check. See
  `API.md`.
- **ML service** (Python/FastAPI): a Dixon-Coles-adjusted independent Poisson
  goals model computing 1X2, BTTS, and Over/Under 2.5 probabilities from each
  team's scoring/conceding averages, with confidence/data-quality derived
  from sample size — not from the probability itself. See `ML_Model.md`.
- **Frontend** (React/Vite/TypeScript/Tailwind): today's fixtures, a match
  detail page with prediction cards and explainability factors, dark/light
  mode, accessible freshness badges, and a responsible-gambling footer on
  every page.
- **Dev-only synthetic seed data** (`supabase/seed/dev_seed_synthetic.sql`):
  clearly flagged `is_synthetic = true`, excluded from every production read
  path by default, used to exercise the pipeline locally without a live data
  provider.
- **Tests**: unit tests for the freshness classifier, the provider
  abstraction, the Poisson model's math (probabilities sum to 1, stronger
  teams are favoured, sample-size-driven data quality), and frontend
  components. CI runs lint + typecheck + tests + build for all three
  services on every push.

## What's explicitly NOT implemented yet

See `Road_map.md` and `Task.md` for the full list. The highlights:

- `ApiFootballProvider` and the fixture sync job exist but have **not been
  verified against a live API key** in this environment — the mapping
  follows the vendor's documentation, tested only against injected fake
  HTTP responses. Get a real key and run a sync before trusting it in
  production. See `Data_Sources.md`.
- Lineups/odds have no sync job yet (`getLineup` exists on the provider but
  nothing calls it; there's no `getOdds` implementation at all) — fixtures,
  team statistics, injuries, and standings are the data actually ingested
  today.
- The standings sync (`syncStandings.ts`) feeds the existing `GET
  /standings/:leagueId` route with real data for the first time — that
  route existed since the initial scaffold but had nothing real to read
  until now. It flattens every group in a competition's table (some
  competitions split into group stages or championship/relegation rounds)
  into one list, since this schema has no column for which group a row
  came from.
- The team-statistics sync (`syncTeamStatistics.ts`) calls the vendor's own
  aggregated stats endpoint per team/competition/season rather than
  computing it from our own results — real data either way, but it means
  `last_5`/`last_10` rolling windows aren't populated (the vendor's
  aggregate endpoint doesn't break stats down match-by-match); that needs a
  separate results-sync job. Predictions can now run on real fixtures once
  both syncs have been run for them, in that order.
- The injuries sync (`syncInjuries.ts`) classifies status (injured/
  suspended/international duty/doubtful) with a keyword heuristic over the
  vendor's free-text fields, not a documented enum — treat it as
  approximate until checked against real responses. It also never marks a
  recovered player `returned`; they just go stale (surfaced by the
  freshness classifier) rather than being actively corrected.
- Admin endpoints now require a Supabase-authenticated admin user (see
  "Creating the first admin user" below) — but there's still no
  signup/role-assignment UI, no audit log of admin actions, and no
  automated test running the middleware against a real Supabase project
  (only against a fake auth/database — see `Task.md`).
- No model backtesting/validation pipeline, no league-specific calibration,
  no model ensemble — one baseline Poisson model only.
- No accumulator research, value/EV analysis, notifications, or admin
  dashboard UI.
- No CI security scanning, no production deployment configuration beyond
  Dockerfiles.

## Repository layout

```
backend/          Node/Express/TypeScript API gateway
ml-service/        Python/FastAPI prediction engine
frontend/           React/Vite/TypeScript/Tailwind UI
supabase/
  migrations/       SQL schema
  seed/             Dev-only synthetic seed data (never run in production)
```

## Running locally

Requires Node 20+, Python 3.12+, and a Supabase project (or local Supabase
via the Supabase CLI).

```bash
# 1. Apply the schema to your Supabase project, in order
supabase db push   # or run both supabase/migrations/*.sql files manually, in filename order

# 2. (Optional, dev only) load synthetic seed data
psql "$SUPABASE_DB_URL" -f supabase/seed/dev_seed_synthetic.sql

# 3. ML service
cd ml-service && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000

# 4. Backend
cd backend && cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
npm install && npm run dev

# 5. Frontend
cd frontend && cp .env.example .env
npm install && npm run dev

# 6. (Optional) pull real data — set FOOTBALL_DATA_PROVIDER=api-football
# and FOOTBALL_DATA_API_KEY in backend/.env first (see Data_Sources.md),
# then sync in order (see "Creating the first admin user" for $ADMIN_JWT):
curl -X POST "http://localhost:8080/api/admin/sync?days=3" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/team-statistics/sync" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/injuries/sync" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/standings/sync" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/predictions/run" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Or `docker compose up` from the repo root once `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set in your environment.

## Creating the first admin user

Every `/api/admin/*` route requires a valid Supabase-issued JWT for a user
whose `user_profiles.role` is `admin` (`backend/src/middleware/requireAdmin.ts`).
There's no signup or role-assignment UI yet, so the first admin is created
by hand:

1. Create a user via Supabase Auth (dashboard → Authentication → Add user,
   or `supabase.auth.signUp(...)` from any client using your project's
   anon key).
2. Give that user's `user_profiles` row the admin role — it's created
   automatically once they have a session (or insert it directly):
   ```sql
   insert into user_profiles (id, role)
   values ('<the user''s auth.users id>', 'admin')
   on conflict (id) do update set role = 'admin';
   ```
3. Get a JWT for that user (sign in via `supabase.auth.signInWithPassword(...)`
   with the anon key from any script — the access token in the response is
   what you pass as `Authorization: Bearer <token>`).

The service role key (`SUPABASE_SERVICE_ROLE_KEY`) is never used as this
bearer token — it's a backend-only secret with no associated user, and
`auth.getUser()` would reject it anyway.

## Documentation

- `PRD.md` — full product vision (the target, not the current state)
- `Architecture.md` — system architecture and data flow
- `Database.md` — schema reference
- `Coding_Rules.md` — engineering rules, especially the No Fake Data Rule
- `Road_map.md` — phased plan and current status
- `Task.md` — concrete outstanding tasks
- `API.md` — REST API reference
- `ML_Model.md` — prediction model documentation and limitations
- `Data_Sources.md` — provider abstraction and how to add a real provider
- `Deployment.md` — deployment notes
- `Changelog.md` — what changed and when

## Responsible use

Predictions are probabilistic estimates, not guarantees. This is a
statistical research tool. See the footer on every page, and
`Coding_Rules.md` for the language rules enforced throughout the codebase
(no "guaranteed," "sure bet," "fixed," or similar claims).
