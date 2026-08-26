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
`Task.md` for renaming this once the standings model is fleshed out). Now
backed by real data once `POST /admin/standings/sync` has been run for
that season — before that, returns an empty list, not a fabricated table.

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

### `POST /admin/injuries/sync`
Calls the configured provider's injuries endpoint for every distinct
(team, season) pair implied by real fixtures (deduplicated on the external
id pair — the endpoint isn't competition-scoped), keeps only the most
recently dated report per player, and upserts a `players` row plus one
`injuries` row per player. Returns `{ runId, combinationsConsidered,
combinationsSkipped, combinationsFailed, playersProcessed,
playersRejected }`. Same `409 no_provider_configured` behavior as the other
sync endpoints. See `Data_Sources.md` for the status-classification caveat.

### `POST /admin/standings/sync`
Calls the configured provider's standings endpoint for every distinct
(competition, season) pair implied by real fixtures (one call returns the
whole table) and upserts a `standings` row per team. Returns `{ runId,
combinationsConsidered, combinationsSkipped, combinationsFailed,
rowsProcessed, rowsRejected }`. Same `409 no_provider_configured` behavior
as the other sync endpoints. See `Data_Sources.md` for the group-flattening
caveat.

### `POST /admin/lineups/sync?hours=N`
Calls the configured provider's lineups endpoint for every real
(non-synthetic), non-postponed/cancelled/abandoned fixture whose kickoff
falls within `±N` hours of now (default 24, capped at 168). One call per
fixture returns both teams; upserts a `players` row per named starter/
substitute and one `lineups` row per team (`confirmation_status:
"confirmed"` — see `Data_Sources.md`). An empty response for a fixture
(lineups not yet officially released) is counted separately from failures.
Returns `{ runId, fixturesConsidered, fixturesSkipped, fixturesFailed,
fixturesNotYetAvailable, lineupsProcessed, lineupsRejected }`. Same `409
no_provider_configured` behavior as the other sync endpoints.

### `POST /admin/odds/sync?hours=N`
Calls the configured provider's odds endpoint for every real (non-synthetic)
fixture with status `scheduled`/`live` whose kickoff falls within `±N` hours
of now (default 24, capped at 168) — like lineups, odds aren't meaningful
further from kickoff, and there's no "closing odds" use case for finished
fixtures yet. Only the three markets the prediction engine produces
(`1x2`/`btts`/`over_under_2_5`) are stored; other markets/lines a bookmaker
offers are read but dropped. An empty response for a fixture (no bookmaker
has posted a covered-market price yet) is counted separately from failures.
**Deliberately not idempotent**: every successful run inserts new
`odds_snapshots` rows rather than upserting, since this table is a genuine
price-history time series, not a "current odds" cache — running this
endpoint repeatedly is expected to keep growing the table (see `Task.md`
for the unimplemented de-duplication optimization). Returns `{ runId,
fixturesConsidered, fixturesSkipped, fixturesFailed,
fixturesNotYetAvailable, snapshotsProcessed, snapshotsRejected }`. Same
`409 no_provider_configured` behavior as the other sync endpoints.

### `POST /admin/predictions/run`
Runs `generatePredictionsForUpcomingFixtures` against the latest
`poisson-baseline` model version. Returns `{ processed, skipped, failed }`.

### `GET /admin/data-health`
Counts of production fixtures, synthetic fixtures, and current predictions.

## Not yet implemented

`GET /api/players/:id`, `GET /api/injuries`, `GET /api/lineups/:matchId`,
and `GET /api/odds/:matchId` — no read routes yet, even though
`syncInjuries.ts`/`syncLineups.ts`/`syncOdds.ts` can now populate real
`players`/`injuries`/`lineups`/`odds_snapshots` rows; these are missing
routes, not missing data sources. `GET /api/analysis/daily`, `GET
/api/analysis/monthly` are blocked on a feature not yet built.
