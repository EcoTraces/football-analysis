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
providerConfigured, secondaryProvider, secondaryProviderConfigured,
freshness }` — `secondaryProvider`/`secondaryProviderConfigured` describe
the odds/injuries/lineups provider (see Data_Sources.md's "The one
exception"), which can be a different vendor than `provider`.
`freshness` is an array of `{ domain, lastUpdated, status, color }` — one
entry per dataset (`fixtures`, `standings`, `teamStatistics`, `injuries`,
`lineups`, `odds`, `predictions`), `status` one of
`LIVE`/`RECENT`/`STALE`/`UNAVAILABLE` (`backend/src/lib/freshness.ts`) and
`color` the same thing as `GREEN`/`YELLOW`/`RED`/`GRAY` for a dashboard to
render directly.

### `GET /health/api-football`
Primary provider connectivity status derived from real request history —
does **not** make a live call on every hit (that would burn API quota on
every health-check poll). `{ status, message, lastRequest, rateLimit }`,
where `status` is `NOT_CONFIGURED` (provider isn't a real HTTP-backed
provider), `UNKNOWN` (configured, but no request has been made yet),
`CONNECTED`, or `ERROR`. `lastRequest`/`rateLimit` are `null` until at
least one real request has happened (via a sync job or an admin trigger).

### `GET /health/odds-provider`
Same shape as `/health/api-football` above, but for the odds/injuries/
lineups provider specifically (`secondaryProvider` — see Data_Sources.md's
"The one exception"). Reports independently since it can be a genuinely
different provider instance than the primary, with its own connectivity
state.

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

### `GET /top20`
The current, non-superseded ensemble prediction per fixture (see
`ML_Model.md`'s "Ensemble model" section), one entry per fixture, sorted by
`selection_score` descending, excluding `avoid` risk tier. `?limit=N`
(default/max 20). Returns `{ data: [...], meta: { count } }` — `data` is
`[]`, never a forced/padded pick, when nothing qualifies (e.g. no
competitions are allowlisted yet, or no fixture clears the `avoid`
threshold).

### `GET /matches-to-avoid`
Current ensemble predictions flagged `risk_tier in ('high_risk',
'avoid')`, `consensus_level = 'conflicting'`, or `data_quality =
'insufficient'` — every applicable reason is included, not just the first
match. Returns `{ data: [...], meta: { count } }`.

### `GET /accumulators?legs=N`
Current accumulator recommendations (see `ML_Model.md`'s "Accumulator
optimizer" section). Omit `legs` for every target's current recommendation;
pass `legs` (one of the configured targets, default `5/7/10/15/20`) to
fetch just that target's. Returns `{ data: [...], meta: { count } }` — a
target with no qualifying legs is simply absent from `data`, never a
forced/padded accumulator.

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

### `POST /admin/fixtures/match-secondary-provider`
Links each upcoming fixture to its counterpart in the odds/injuries/
lineups provider (see `Data_Sources.md`'s "The one exception") by team-name
+ kickoff-time matching, so `/admin/injuries/sync`, `/admin/lineups/sync`,
and `/admin/odds/sync` below (all of which read the odds/injuries/lineups
provider, not necessarily the same as the primary fixtures provider) have
something to look up. Runs automatically once a day via the scheduler;
this route exists to trigger it immediately instead of waiting. Returns
`{ runId, fixturesConsidered, alreadyLinked, matched, ambiguous,
noCandidate }`. Same `409 no_provider_configured` behavior as the other
sync endpoints (checked against the odds/injuries/lineups provider, not
the primary one).

### `POST /admin/injuries/sync`
Calls the odds/injuries/lineups provider's injuries endpoint (see
`Data_Sources.md`'s "The one exception" — not necessarily the same vendor
as the primary fixtures provider) for every distinct (team, season) pair
implied by real fixtures (deduplicated on the external id pair — the
endpoint isn't competition-scoped), keeps only the most recently dated
report per player, and upserts a `players` row plus one `injuries` row per
player. Returns `{ runId, combinationsConsidered, combinationsSkipped,
combinationsFailed, playersProcessed, playersRejected }`. Same `409
no_provider_configured` behavior as the other sync endpoints. See
`Data_Sources.md` for the status-classification caveat.

### `POST /admin/standings/sync`
Calls the configured provider's standings endpoint for every distinct
(competition, season) pair implied by real fixtures (one call returns the
whole table) and upserts a `standings` row per team. Returns `{ runId,
combinationsConsidered, combinationsSkipped, combinationsFailed,
rowsProcessed, rowsRejected }`. Same `409 no_provider_configured` behavior
as the other sync endpoints. See `Data_Sources.md` for the group-flattening
caveat.

### `POST /admin/lineups/sync?hours=N`
Calls the odds/injuries/lineups provider's lineups endpoint for every real
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
Calls the odds/injuries/lineups provider's odds endpoint for every real (non-synthetic)
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

### `POST /admin/league-calibration/run`
Recomputes every competition's real per-league goal averages from its own
finished, non-synthetic fixtures (`calibrateLeagues.ts` — see
`ML_Model.md`'s "League-specific calibration" section). No provider call,
so no `409 no_provider_configured` (same as `/admin/predictions/run`). No
params — always the competition's full real fixture history, not a
date-windowed sync. Also runs daily on the scheduler
(`calibrate_leagues`); this route is for an out-of-cycle manual trigger.
Returns `{ runId, competitionsCalibrated, competitionsSkipped }` —
`competitionsSkipped` counts competitions with fewer than
`MIN_FIXTURES_FOR_LEAGUE_CALIBRATION` (20) real fixtures, which keep using
the fixed cross-league default instead.

### `GET /admin/league-calibration/results`
Every competition's current calibration, enriched with its name (joined
from `competitions`). Returns `{ id, competition_id, competitionName,
league_avg_home_goals, league_avg_away_goals, sample_size, computed_at }[]`
— empty until at least one competition has enough real fixtures.

### `POST /admin/predictions/run`
Runs `generatePredictionsForUpcomingFixtures` against the latest
`poisson-baseline` model version. Returns `{ processed, skipped, failed }`.

### `POST /admin/backtest/run?from=&to=&competitionId=&model=`
Runs a walk-forward backtest of the `1x2` market over finished,
non-synthetic fixtures whose `kickoff_utc` falls in `[from, to]`
(required; any string `Date` can parse; range capped at 366 days),
optionally restricted to one `competitionId`. `model` is
`poisson-baseline` (default) or `gradient-boosting` — selects which
registered model gets scored (see `ML_Model.md`'s "Gradient boosting
model" section); run this twice over the same range with a different
`model` to get two directly comparable results. Team strength for each
fixture is recomputed point-in-time from `fixtures`' own prior results
(never from the current `team_statistics` snapshot — see `ML_Model.md`'s
"Backtesting" section for why). Writes one `model_evaluations` row per run.
Same `syncTriggerLimit` rate limiting as every other sync/prediction
trigger. `400 invalid_query` if `from`/`to` are missing, unparseable,
`from` is after `to`, the range exceeds 366 days, or `model` isn't one of
the two above. `409 no_model_version` if the selected model's
`model_versions` row doesn't exist yet. Returns `{ runId, modelVersionId,
evaluationId, sampleSize, skipped, accuracy, logLoss, brierScore }` — all
four metric fields are `null` when `sampleSize` is 0 (nothing in range had
enough point-in-time history to predict from). Deliberately not on the
scheduler — an admin picks the window each time.

### `POST /admin/model/gradient-boosting/train?from=&to=&competitionId=`
Trains the gradient-boosting model on point-in-time features built from
finished, non-synthetic fixtures whose `kickoff_utc` falls in `[from, to]`
— same required/validated params and range cap as `/admin/backtest/run`
(minus `model`), same rate limiting. `409 no_model_version` if no
`gradient-boosting` model version exists yet (see `ML_Model.md` for the
manual bootstrap step). `422 training_failed` if ml-service refuses the
training request — most commonly too few qualifying fixtures in range, or
a range whose fixtures produced only one outcome class; the message names
the specific reason. On success, updates the `gradient-boosting`
`model_versions` row's `trained_at`/`training_dataset_version`/`notes` and
returns `{ runId, modelVersionId, sampleSize, skipped, trainAccuracy,
classCounts }` — `trainAccuracy` is in-sample only, never a generalization
metric (backtest the model for that). Like backtesting, never on the
scheduler — retraining is an explicit, occasional admin action.

### `POST /admin/model/poisson/fit-rho?from=&to=&competitionId=`
Fits the Dixon-Coles `rho` parameter by maximum likelihood from real,
point-in-time match data in `[from, to]` — same required/validated params,
range cap, and rate limiting as `/admin/model/gradient-boosting/train`.
`409 no_model_version` if no `poisson-baseline` model version exists yet.
`422 rho_fit_failed` if ml-service refuses the fit — most commonly fewer
than 30 matches in range finished 0-0, 1-0, 0-1, or 1-1 (the only
scorelines a Dixon-Coles rho fit can learn anything from — see
`ML_Model.md`'s "Rho fitting" section); the message names the specific
reason.

`competitionId` branches what the fit does with its result (see
`ML_Model.md`'s "Per-competition rho" section):
- **Omitted — a GLOBAL fit.** Data is drawn from every competition's
  matches in range. Updates `poisson-baseline`'s **existing**
  `model_versions` row's `trained_at`/`training_dataset_version`/`notes`
  (this refines that model, it doesn't create a new one) and, from that
  point on, every `/predict/poisson` call with no per-request override —
  live predictions for a competition with no fit of its own, and any
  backtest run against `poisson-baseline` — uses the fitted value instead
  of the fixed `RHO = -0.1`.
- **Present — a COMPETITION-SCOPED fit.** Data is drawn from just that one
  competition's matches in range. Upserts a row into `competition_rho`
  (`unique(model_version_id, competition_id)` — refitting the same
  competition updates its row in place) instead of touching
  `model_versions`, and never changes ml-service's global fallback rho —
  only that one competition's own live predictions pick it up (via
  `getCompetitionRho()`), every other competition is unaffected.

Either way returns `{ runId, modelVersionId, competitionId, sampleSize,
skipped, informativeMatches, fittedRho, logLikelihoodAtFittedRho,
logLikelihoodAtDefaultRho, defaultRho }` — `competitionId` echoes back
`null` for a global fit or the competition id for a scoped one. Like
backtesting/training, never on the scheduler.

### `GET /admin/model/poisson/rho-status`
Whether a *global* fit is currently in effect for `/predict/poisson`. Not
rate limited — a read-only status check, same as `/admin/data-health`.
Returns `{ fittedRho, defaultRho }` — `fittedRho` is `null` if nobody has
run a global fit yet (predictions with no competition-specific fit of
their own are using the fixed default). Says nothing about
competition-scoped fits — see `/admin/model/poisson/competition-rho` for
those.

### `GET /admin/model/poisson/competition-rho`
Every competition with a per-competition rho fit of its own, enriched with
its name (joined from `competitions`), same "list everything, join for
readability" pattern as `/admin/league-calibration/results`. Not rate
limited — a read-only listing. Returns `{ id, model_version_id,
competition_id, competitionName, fitted_rho, default_rho, sample_size,
informative_matches, log_likelihood_at_fitted_rho,
log_likelihood_at_default_rho, evaluation_window, computed_at }[]` — empty
until at least one competition-scoped fit has been run.

### `GET /admin/backtest/results?limit=N`
Past backtest runs from `model_evaluations` (any model), newest first
(`limit` default 50, capped at 200). Returns `{ id, model_version_id,
modelName, competition_id, market, evaluation_window, accuracy, log_loss,
brier_score, sample_size, created_at }[]` — `modelName` is server-side
enriched from `model_versions` (`null` only if that row was somehow
deleted after the fact).

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

### `GET /admin/audit-log?limit=N&actor_id=X`
Recent `admin_audit_log` rows, newest first (`limit` default 50, capped at
200; `actor_id` optionally filters to one admin). Returns `{ id, actor_id,
actor_email, method, path, status_code, request_body, created_at }[]` — one
row per mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request that reached
`/api/admin/*`, written by `middleware/auditAdminActions.ts`. GET requests
(reads like `/admin/jobs`, `/admin/data-health`) are never recorded here.

### `POST /admin/elo/recompute`
Recomputes every team's global Elo rating from scratch by replaying its
finished, non-synthetic fixture history (`computeEloRatings.ts` — see
`ML_Model.md`'s "Elo ratings" section). No provider call, so no `409
no_provider_configured`. Also runs daily on the scheduler
(`compute_elo_ratings`); this route is for an out-of-cycle manual trigger.
Returns `{ runId, teamsRated, matchesReplayed }` (field names per
`computeCurrentEloRatings()`'s own result shape).

### `GET /admin/elo/ratings`
Every team's current Elo rating, joined with its name, ordered highest
first. Returns `{ id, team_id, teamName, rating, matches_played,
computed_at }[]`.

### `POST /admin/predictions/ensemble/run`
Generates the ensemble prediction (Elo + Poisson + Form + Home/Away +
Injuries + Market) for every upcoming fixture in an allowlisted
competition (see `ML_Model.md`'s "Ensemble model" section). Same `409
no_model_version` contract as `/admin/predictions/run` if no `ensemble`
`model_versions` row exists yet. Returns `{ runId, processed, skipped,
failed }`. Also runs daily on the scheduler (`predictions_ensemble`),
right after `compute_elo_ratings`.

### `POST /admin/accumulators/build`
Builds accumulator recommendations for every enabled target
(`accumulator_targets`) from the current `ensemble_predictions` pool (see
`ML_Model.md`'s "Accumulator optimizer" section). No `model_versions`
gating — this optimizes over already-generated predictions, it isn't
itself a model. Returns `{ runId, targetsBuilt, targetsSkipped }` —
`targetsSkipped` counts enabled targets that had too few qualifying legs to
produce a recommendation (never a padded/forced one). Also runs daily on
the scheduler (`build_accumulators`), right after `predictions_ensemble`.

### AI Football Analyst admin config
None of the routes below call an external provider or ml-service, so none
are rate limited (same reasoning as the read-only calibration routes
above). Each `PUT`/`POST` validates its body with Zod (weights must sum to
1; risk thresholds must be descending) and returns the freshly-read config
on success, same "write, then read back" shape throughout.

- **`GET`/`PUT /admin/config/ensemble-weights`** — the six
  per-component ensemble weights (`elo, poisson, form, home_away,
  injuries, market`). Returns `{ ..., isDefault: boolean }` —
  `isDefault: true` means nobody has ever edited this and the dev-seeded
  defaults are in effect (same shape `getLeagueAverages()` already uses).
- **`GET`/`PUT /admin/config/screening`** — the four selection-score
  weights (`ensemble_confidence, ev, consensus, data_quality`) and four
  risk-tier thresholds (`elite_min, strong_min, medium_min,
  high_risk_min`).
- **`GET /admin/config/accumulator-targets`** / **`PUT
  /admin/config/accumulator-targets/:legs`** — per-leg-target (5/7/10/15/20)
  minimum selection score and enabled flag.
- **`GET /admin/config/competition-allowlist`** / **`POST
  /admin/config/competition-allowlist/:competitionId`** — which
  competitions the ensemble/screening pipeline is allowed to consider.
  Ships with zero rows; `/top20`, `/matches-to-avoid`, and `/accumulators`
  correctly return empty, not "everything," until an admin explicitly
  enables at least one competition here.

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
