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
  default; opt in via env vars), fixture/team-statistics/injuries/standings/
  lineups/odds sync jobs, a prediction-generation job, admin endpoints to
  trigger each — authenticated by a Supabase JWT plus an admin role check
  — and an optional in-process cron scheduler (`SCHEDULER_ENABLED=true`)
  that runs the same jobs automatically instead of relying on manual
  endpoint calls. `ApiFootballProvider` retries transient failures with
  exponential backoff and tracks rate-limit headers; `GET
  /health/api-football`, `GET /health/scheduler`, and `GET /health/data`
  (now with per-dataset freshness) plus admin-only `GET /admin/jobs`/`GET
  /admin/jobs/summary` expose real job/request history for monitoring. See
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
- The odds sync (`syncOdds.ts`) only looks at scheduled/live fixtures within
  a window around kickoff (±24h by default), like lineups, and only stores
  the three markets the prediction engine actually produces (`1x2`/`btts`/
  `over_under_2_5`) — other markets and lines a bookmaker offers are read
  but not stored. It's deliberately **not idempotent**: `odds_snapshots` is
  a genuine time series (spec section 25 wants price movement, not just a
  current price), so every run appends new rows rather than overwriting,
  and there's no de-duplication yet — running it on a tight schedule with
  unchanged prices still grows the table. **Not yet verified against a live
  API key** — same caveat as the other sync jobs.
- The scheduler (`SCHEDULER_ENABLED=true`, off by default) runs all six
  sync jobs plus predictions in-process via `node-cron`, but assumes a
  single backend instance — there's no cross-process locking, so running
  more than one replica with it enabled would sync everything redundantly
  N times over. Its cron cadences are fixed constants, not configurable per
  environment, and none of its timing has been observed running for real
  over multiple days — only unit-tested and smoke-tested for a few seconds
  at boot.
- The lineups sync (`syncLineups.ts`) only looks at fixtures within a
  window around kickoff (±24h by default) rather than every fixture ever
  recorded, since lineups aren't meaningful further out. It always records
  `confirmation_status: 'confirmed'`, reasoned from api-football's
  documentation saying this endpoint only updates once lineups are
  officially released — not a "predicted lineup" feature — but that
  reasoning is itself unverified against a live response.
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
curl -X POST "http://localhost:8080/api/admin/lineups/sync" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/odds/sync" \
  -H "Authorization: Bearer $ADMIN_JWT"
curl -X POST "http://localhost:8080/api/admin/predictions/run" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Or `docker compose up` from the repo root once `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set in your environment.

Instead of running the curl chain above by hand each time, set
`SCHEDULER_ENABLED=true` in `backend/.env` to run all six sync jobs plus
predictions automatically on a cron schedule (`backend/src/scheduler/scheduler.ts`)
— see that file for the exact cadence, and the caveats above and in
`Task.md` before relying on it.

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

## Configuring a live API-Football key

No real football data has ever flowed through this application — every
sync job has only been tested against fake HTTP responses injected in unit
tests. To actually verify it against live data:

1. Get a key from [api-football.com](https://www.api-football.com/) (direct
   api-sports.io signup) or via [RapidAPI](https://rapidapi.com/api-sports/api/api-football).
   The free tier is enough to verify the integration; check its request cap
   before running a wide sync.
2. Set in `backend/.env`:
   ```
   FOOTBALL_DATA_PROVIDER=api-football
   FOOTBALL_DATA_API_KEY=<your real key>
   ```
   Never commit this file or paste the real key into an issue, a commit
   message, or a log line — `backend/.env` is gitignored, and
   `ApiFootballProvider` never logs the key itself (see `Coding_Rules.md`).
3. Start the backend (`npm run dev`) — it fails fast at boot if
   `FOOTBALL_DATA_API_KEY` is empty while `FOOTBALL_DATA_PROVIDER=api-football`,
   rather than silently falling back to fabricated data.
4. Run the verification chain below against a real Supabase project (get
   `$ADMIN_JWT` per "Creating the first admin user"):
   ```bash
   curl -s http://localhost:8080/api/health/api-football   # expect status: "UNKNOWN" before the first request
   curl -X POST "http://localhost:8080/api/admin/sync?days=1" -H "Authorization: Bearer $ADMIN_JWT"
   curl -s http://localhost:8080/api/health/api-football   # expect status: "CONNECTED" and a populated rateLimit
   curl -s "http://localhost:8080/api/fixtures/today"       # confirm real fixtures came back, not synthetic ones
   curl -X POST "http://localhost:8080/api/admin/team-statistics/sync" -H "Authorization: Bearer $ADMIN_JWT"
   curl -X POST "http://localhost:8080/api/admin/standings/sync" -H "Authorization: Bearer $ADMIN_JWT"
   curl -s http://localhost:8080/api/admin/jobs -H "Authorization: Bearer $ADMIN_JWT"   # real ingestion_runs history
   ```
5. Check `ingestion_runs.error_summary` (via `GET /admin/jobs`) for anything
   indicating a field-mapping mismatch — every mapping in
   `ApiFootballProvider.ts` was written from the vendor's documentation, not
   a confirmed live response, and is expected to need adjustment the first
   time it sees real data (see `Data_Sources.md`).

None of this can be done from this development environment — there is no
real API-Football account or key available here, and creating one requires
a human to sign up with a real account. Everything above is otherwise
finished and ready to run the moment a key is configured, including retry/
backoff and rate-limit tracking (`Data_Sources.md`) and the job-history/
health endpoints to verify the result.

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
