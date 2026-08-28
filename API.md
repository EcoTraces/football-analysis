# API Reference

Base URL: `http://localhost:8080/api` in development. All responses are
JSON, wrapped as `{ "data": ..., "meta"?: {...} }` on success or
`{ "error": { "code": string, "message": string } }` on failure.

## Public

### `GET /health`
Liveness check. `{ status: "ok", timestamp }`.

### `GET /health/data`
Database reachability, provider configuration, and per-dataset freshness
(no secrets). `{ database, databaseError, productionFixtureCount, provider,
providerConfigured, freshness }`, where `freshness` is an array of `{
domain, lastUpdated, status, color }` — one entry per dataset (`fixtures`,
`standings`, `teamStatistics`, `injuries`, `lineups`, `odds`,
`predictions`), `status` one of `LIVE`/`RECENT`/`STALE`/`UNAVAILABLE`
(`backend/src/lib/freshness.ts`) and `color` the same thing as
`GREEN`/`YELLOW`/`RED`/`GRAY` for a dashboard to render directly.

### `GET /health/api-football`
Provider connectivity status derived from real request history — does
**not** make a live call on every hit (that would burn API quota on every
health-check poll). `{ status, message, lastRequest, rateLimit }`, where
`status` is `NOT_CONFIGURED` (provider isn't `api-football`), `UNKNOWN`
(configured, but no request has been made yet), `CONNECTED`, or `ERROR`.
`lastRequest`/`rateLimit` are `null` until at least one real request has
happened (via a sync job or an admin trigger).

### `GET /health/scheduler`
Whether the in-process cron scheduler (`backend/src/scheduler/scheduler.ts`)
is running. `{ status: "DISABLED" | "RUNNING", message, jobs }`, where each
entry in `jobs` is `{ name, cronExpression, nextRun }`.

### `GET /health/model`
Placeholder — model monitoring is not implemented yet.

## Authenticated (any signed-in user)

Every route below requires `Authorization: Bearer <supabase-jwt>` for any
signed-in user — no role check (`backend/src/middleware/auth.ts`'s
`requireAuth`). Missing/malformed header or an unrecognized token → `401
unauthenticated`. The football data itself is not publicly browsable; see
README.md → "User access control".

### `GET /me`
Auto-provisions the caller's own `user_profiles` row on first call (default
role `user`) rather than requiring a separate signup step. Returns `{ id,
email, displayName, role, createdAt }`. Used by the frontend right after
sign-in to decide whether to show admin UI.

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
`403 forbidden`. See README.md → "User access control" for how to get a
token. **Not yet verified against a real Supabase project's JWTs** — see
`Task.md`. The frontend's `/admin` (dashboard) and `/admin/users` pages
consume every endpoint below, plus the health endpoints above — no admin
action requires curl anymore.

### `GET /admin/users`
Lists every real account (via `auth.admin.listUsers()`) joined with its
`user_profiles` role/display name: `{ id, email, role, displayName,
createdAt }[]`. Only the first 200 accounts are fetched — no pagination
yet (see `Task.md`).

### `POST /admin/users/:id/role`
Body `{ role: "user" | "admin" }`. Promotes/demotes the target account.
`404 user_not_found` if no `user_profiles` row exists for that id; `409
last_admin` if this would demote the only remaining admin (refused, not
allowed — there's no recovery from zero admins short of direct database
access). Returns `{ id, role }`.

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

### `POST /admin/player-statistics/sync`
Same (team, competition, season) combinations as
`/admin/team-statistics/sync`, but calls the configured provider's
per-player statistics endpoint instead — upserts a `players` row plus one
`player_statistics` row per player returned. Powers the anytime-goalscorer
markets; run alongside `/admin/team-statistics/sync`, before
`/admin/predictions/run`. Returns `{ runId, combinationsConsidered,
processed, skipped, failed, playersProcessed }`. Same
`409 no_provider_configured` behavior as `/admin/sync`. See `Data_Sources.md`.

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
fixtures yet. Only `1x2`/`btts`/`over_under_2_5` are stored; other
markets/lines a bookmaker offers are read but dropped — this includes
`double_chance`, `correct_score`, `total_cards`, `total_corners`,
`first_half_result`, `second_half_result`, `half_with_most_goals`, and the
anytime-goalscorer markets, which the prediction engine now produces (see
`ML_Model.md`) but odds ingestion does not yet cover, so those have model
probabilities with no bookmaker price to compare against. An empty response
for a fixture (no bookmaker has posted a covered-market price yet) is
counted separately from failures.
**Deliberately not idempotent**: every successful run inserts new
`odds_snapshots` rows rather than upserting, since this table is a genuine
price-history time series, not a "current odds" cache — running this
endpoint repeatedly is expected to keep growing the table (see `Task.md`
for the unimplemented de-duplication optimization). Returns `{ runId,
fixturesConsidered, fixturesSkipped, fixturesFailed,
fixturesNotYetAvailable, snapshotsProcessed, snapshotsRejected }`. Same
`409 no_provider_configured` behavior as the other sync endpoints.

### `POST /admin/fixture-statistics/sync?hours=N`
Calls the configured provider's per-fixture statistics endpoint for every
real (non-synthetic), **finished** fixture whose kickoff falls within the
last `N` hours (default 72, capped at 168) — the only source for corner
kicks, which api-football's team-season aggregate never includes (see
`Data_Sources.md`). Upserts one `fixture_statistics` row per (fixture,
team), then re-aggregates each touched team's average corners for the
season into `team_statistics.corners`. Returns `{ runId,
fixturesConsidered, fixturesSkipped, fixturesFailed, statisticsProcessed,
statisticsRejected, teamsAggregated }`. Same `409 no_provider_configured`
behavior as the other sync endpoints.

### `POST /admin/predictions/run`
Runs `generatePredictionsForUpcomingFixtures` against the latest
`poisson-baseline` model version. Returns `{ processed, skipped, failed }`.

### `GET /admin/data-health`
Counts of production fixtures, synthetic fixtures, and current predictions.

### `GET /admin/jobs?limit=N&job_name=X`
Recent `ingestion_runs` rows, newest first (`limit` default 50, capped at
200; `job_name` optionally filters to one job — e.g. `sync_odds`,
`predictions`). Returns `{ id, job_name, provider, status,
records_processed, records_rejected, error_summary, started_at,
finished_at }[]`. This is the same table every sync job (and now
`predictions`) has always written to — this endpoint just reads it back,
and is what makes the scheduler's multi-day observation period
(`Task.md`) actually observable.

### `GET /admin/jobs/summary`
Per-`job_name` summary reduced from the most recent 500 `ingestion_runs`
rows: `{ [job_name]: { lastRun, lastSuccess } }`, where `lastSuccess` is
`null` if that job has never succeeded in the sampled window.

## Scheduler (no HTTP surface)

Every sync/prediction endpoint above can also run automatically instead of
being called by hand — set `SCHEDULER_ENABLED=true` in the backend's
environment to start an in-process cron scheduler
(`backend/src/scheduler/scheduler.ts`) at boot. There's no admin route for
this; it's a boot-time flag, not something toggled at runtime. See
`Data_Sources.md` for the cadence and known limitations (single-instance
assumption, fixed cron expressions, unverified against real multi-day
timing).

## Not yet implemented

`GET /api/players/:id`, `GET /api/injuries`, `GET /api/lineups/:matchId`,
and `GET /api/odds/:matchId` — no read routes yet, even though
`syncInjuries.ts`/`syncLineups.ts`/`syncOdds.ts` can now populate real
`players`/`injuries`/`lineups`/`odds_snapshots` rows; these are missing
routes, not missing data sources. `GET /api/analysis/daily`, `GET
/api/analysis/monthly` are blocked on a feature not yet built.
