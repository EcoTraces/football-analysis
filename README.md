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
  "not configured" responses), a prediction-generation job, and an admin
  endpoint to trigger it. See `API.md`.
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

- No real football data provider is wired in (fixtures/injuries/lineups/odds
  all report "unavailable" until one is implemented against
  `FootballDataProvider`).
- No authentication/authorization — the admin endpoints have no auth
  middleware and must not be exposed publicly as-is.
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
# 1. Apply the schema to your Supabase project
supabase db push   # or run supabase/migrations/0001_init.sql manually

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
```

Or `docker compose up` from the repo root once `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set in your environment.

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
