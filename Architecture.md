# Architecture

## Overview

```
React Frontend (Vite/TS/Tailwind) ---- Supabase Auth (anon key, RLS)
        |                                       ^
        v                                       |
Node.js/Express API (TypeScript) --------------+
        |
        +--------------------------+
        |                          |
        v                          v
Supabase (Postgres + Auth)   Python/FastAPI ML service
        ^                          (Poisson/Dixon-Coles model)
        |
Football data providers (abstracted — see Data_Sources.md)
```

- **Frontend** talks to the backend's REST API for all football-domain data
  (fixtures, predictions, standings, etc.) — never directly to Supabase for
  that. It does talk directly to Supabase Auth with the anon key (sign in/
  up/out, session/JWT) and to `user_profiles` for its own row, both under
  RLS — the one place this app uses the direct-client pattern Supabase is
  built around, rather than proxying through the backend (see `Database.md`'s
  "Access control" section for how `role` specifically is still kept out of
  that direct-write path). The JWT from that session is what gets sent as
  `Authorization: Bearer <token>` to the backend's `/api/me` and
  `/api/admin/*` routes.
- **Backend** is the sole writer of football-domain tables, using the
  Supabase service role key (bypasses RLS by design — see `Database.md`).
  It reads/writes fixtures, predictions, etc., and proxies prediction
  requests to the ML service.
- **ML service** is a pure function of its inputs: given two teams'
  scoring/conceding rates and league averages, it returns market
  probabilities. It has no database access and no external API calls, which
  keeps it trivially testable and horizontally scalable.
- **Provider abstraction** (`backend/src/providers/`) is the seam where real
  football/odds/weather data providers plug in. Today only `NullProvider`
  exists, which always reports "not configured" rather than inventing data.

## Data flow: prediction generation

1. A job (`backend/src/jobs/generatePredictions.ts`) finds scheduled
   fixtures in the next N hours.
2. For each, it loads both teams' `team_statistics` (scope = `overall`) from
   Supabase. If either team has fewer than 3 recorded matches, the fixture
   is skipped — no prediction is written rather than one built on
   insufficient data.
3. It calls the ML service's `/predict/poisson` with each team's
   matches-played and goals-scored/conceded averages.
4. It writes the returned market probabilities to the `predictions` table,
   marking any previous current prediction for that fixture as superseded
   (never deleted — prediction history stays queryable).
5. The frontend reads current (non-superseded) predictions per fixture via
   `GET /api/matches/:id`.

This job is not yet wired to a scheduler (cron/Cloud Scheduler) — see
`Task.md`. It's triggered manually today via `POST /api/admin/predictions/run`.

## Data flow: fixtures

Fixture ingestion from a real provider is not implemented (`NullProvider`
only). The schema and `listFixtures` service are ready for it: a future
`ApiFootballProvider` (or similar) would implement `FixtureProvider`, an
ingestion job would upsert into `fixtures` keyed by the natural key unique
index (`competition_id, season_id, home_team_id, away_team_id,
kickoff_utc`) to stay idempotent across re-runs, and nothing downstream
changes.

## Why Supabase

Supabase (managed Postgres) was chosen per the project brief. It gives:
relational integrity for a genuinely relational domain (fixtures reference
teams, competitions, seasons — this doesn't fit a document model cleanly),
Row Level Security for user-owned tables (`user_profiles`, `notifications`),
and built-in auth, now used by the frontend for user accounts (sign-in/
sign-up, an admin Users panel — see `Database.md`'s "Access control").

## Deliberately deferred

- Caching layer
- Search/indexing
- Model ensemble beyond the single Poisson baseline
- Admin dashboard UI for the sync/job/health endpoints (`/admin/*/sync`,
  `/admin/jobs*`, `/health/*`) — only the Users panel (`/admin/users`) has
  a frontend so far; the rest is API/curl-only
- Admin-action audit log

See `Road_map.md` for sequencing.
