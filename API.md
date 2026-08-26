# API Reference

Base URL: `http://localhost:8080/api` in development. All responses are
JSON, wrapped as `{ "data": ..., "meta"?: {...} }` on success or
`{ "error": { "code": string, "message": string } }` on failure.

## Public

### `GET /health`
Liveness check. `{ status: "ok", timestamp }`.

### `GET /health/data`
Database reachability and provider configuration (no secrets).
`{ database, databaseError, productionFixtureCount, provider, providerConfigured }`.

### `GET /health/model`
Placeholder — model monitoring is not implemented yet.

### `GET /fixtures/today`
Fixtures with `kickoff_utc` in today's UTC window, excluding synthetic rows
unless `?includeSynthetic=true`. Each fixture includes a `freshness` field
(`LIVE`/`RECENT`/`STALE`/`UNAVAILABLE`).

### `GET /fixtures`
Query params: `from`, `to` (ISO datetimes), `competitionId`, `teamId`,
`status`, `includeSynthetic`.

### `GET /matches/:id`
Fixture detail plus its current (non-superseded) predictions per market.
`predictionsAvailable: false` when no prediction has been generated (e.g.
insufficient data) — the frontend must render this as "unavailable," not as
an empty/zeroed prediction.

### `GET /teams/:id`
Team plus its `team_statistics` rows across all recorded scopes.

### `GET /leagues`
Active competitions (excludes the synthetic seed's placeholder competition
unless `?includeSynthetic=true`).

### `GET /standings/:leagueId`
Standings for a season (`leagueId` is actually a `season_id` — see
`Task.md` for renaming this once the standings model is fleshed out).

## Admin

Every route below requires `Authorization: Bearer <supabase-jwt>` for a
user whose `user_profiles.role` is `admin`
(`backend/src/middleware/requireAdmin.ts`). Missing/malformed header or an
unrecognized token → `401 unauthenticated`; a valid but non-admin user →
`403 forbidden`. See README.md → "Creating the first admin user" for how to
get a token. **Not yet verified against a real Supabase project's JWTs** —
see `Task.md`.

### `POST /admin/sync?days=N`
Syncs fixtures from today (UTC) through `days` days ahead (default 1,
capped at 14) using the configured `FootballDataProvider`. Returns
`{ runId, daysAttempted, daysFailed, fixturesProcessed, fixturesRejected }`.
Responds `409 no_provider_configured` if `FOOTBALL_DATA_PROVIDER=null`
(the default) rather than silently doing nothing. See `Data_Sources.md`.

### `POST /admin/team-statistics/sync`
Calls the configured provider's aggregated team-statistics endpoint for
every distinct (team, competition, season) implied by real (non-synthetic)
fixtures, and upserts `overall`/`home`/`away` scope rows into
`team_statistics`. Run this after `/admin/sync` and before
`/admin/predictions/run` — predictions read from `team_statistics`, not
from raw fixture scores. Returns `{ runId, combinationsConsidered,
processed, skipped, failed }`. Same `409 no_provider_configured` behavior
as `/admin/sync`. See `Data_Sources.md`.

### `POST /admin/predictions/run`
Runs `generatePredictionsForUpcomingFixtures` against the latest
`poisson-baseline` model version. Returns `{ processed, skipped, failed }`.

### `GET /admin/data-health`
Counts of production fixtures, synthetic fixtures, and current predictions.

## Not yet implemented

`GET /api/players/:id`, `GET /api/injuries`, `GET /api/lineups/:matchId`,
`GET /api/odds/:matchId`, `GET /api/analysis/daily`,
`GET /api/analysis/monthly` — all blocked on a real data provider (players/
injuries/lineups/odds) or a feature not yet built (daily/monthly analysis).
