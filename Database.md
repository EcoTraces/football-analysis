# Database

Postgres via Supabase. Schema: `supabase/migrations/0001_init.sql` (initial
schema), `0002_provider_external_refs.sql` (external-id columns/indexes for
countries/seasons/fixtures/teams/competitions), and
`0003_injuries_and_players_refs.sql` (external-id uniqueness for `players`,
plus a uniqueness constraint on `injuries` that 0001 didn't anticipate
needing), and `0004_user_profiles_role_guard.sql` (closes a role
self-escalation gap in the 0001 RLS policies — see "Access control" below)
— each added once a real need showed up, through `0009`–`0013` (the AI
Football Analyst / Accumulator Engine — Elo ratings, admin-editable
config, ensemble prediction history, and accumulator recommendations; see
"AI Football Analyst / Accumulator Engine tables" below and `ML_Model.md`'s
"Ensemble model" section) and `0014_football_data_org_external_refs.sql`
(a second provider's own external-id uniqueness — see "Two providers, one
external_ref column" below). Dev-only synthetic seed:
`supabase/seed/dev_seed_synthetic.sql`.

## Design conventions

- **Provenance on every time-sensitive table.** `source`, `source_timestamp`,
  and `updated_at`/`created_at` on fixtures, standings, team_statistics,
  injuries, lineups, odds_snapshots, weather_observations. The backend uses
  `source_timestamp` to classify LIVE/RECENT/STALE/UNAVAILABLE
  (`backend/src/lib/freshness.ts`).
- **`is_synthetic` flag.** Every table that dev seed data touches carries
  this column, defaulting to `false`. Production read paths filter it out by
  default (`listFixtures`, `/api/leagues`, standings, etc.) so a
  misconfigured deployment cannot surface fabricated rows to real users.
- **Idempotent ingestion.** `fixtures` has a unique index on
  `(competition_id, season_id, home_team_id, away_team_id, kickoff_utc)`
  from 0001, plus a partial unique index on `external_ref->>'api_football'`
  from 0002 (and, since this platform gained a second swappable provider,
  an equivalent `external_ref->>'football_data_org'` index from 0014 — see
  "Two providers, one external_ref column" below) — the one real ingestion
  job (`syncFixtures.ts`) actually upserts against the active provider's
  own key, since a postponed-and-rescheduled fixture keeps its provider id
  but changes kickoff time (the natural key would treat that as a new row).
  `teams` and `competitions` got the same external-id uniqueness in 0002
  (and 0014). `seasons`' external id is scoped by `competition_id` — a
  season's provider id like "2026" repeats across every competition, so
  global uniqueness there would be wrong.
  `team_statistics`'s uniqueness (`team_id, season_id, scope`),
  `standings`'s (`season_id, team_id`), and `lineups`'s (`fixture_id,
  team_id`), by contrast, are genuine plain-column constraints from 0001,
  and `injuries`' new uniqueness on `player_id` (0003) is too —
  `syncTeamStatistics.ts`, `syncStandings.ts`, `syncLineups.ts`, and
  `syncInjuries.ts` all use a real `upsert(..., { onConflict: ... })`
  against them rather than the find-then-insert pattern the expression-index
  tables need (see `Data_Sources.md`). `injuries` models "current status per
  player," not a history of every report — see 0003's comment for the
  known edge case that simplification accepts. `odds_snapshots` is the one
  exception to "idempotent ingestion": it has no unique constraint at all,
  by design — it's a genuine price-history time series, so `syncOdds.ts`
  does a plain `insert()` on every run rather than upserting, and running it
  twice with the same prices deliberately produces two rows, not one (see
  `Data_Sources.md`).
- **Prediction history, not overwrite.** `predictions` rows are never
  mutated after creation; recalculating sets `superseded_at` on the old row
  and inserts a new one. `idx_predictions_current` (partial index on
  `superseded_at is null`) keeps "give me the current prediction" queries
  fast.
- **RLS.** Enabled on `user_profiles` and `notifications` (user reads/writes
  only their own rows). Football-domain tables have no RLS policies — the
  backend, using the service role key, is their only writer, and reads go
  through the API rather than directly from the frontend with the anon key.
  `user_profiles` is the one table the frontend now does read/write
  directly with the anon key (for Auth + reading its own row) — see
  "Access control" below for how `role` specifically is still kept out of
  that direct-write path.

## Access control

`user_profiles.role` (`'user'` default, `'admin'`) is the platform's entire
privilege boundary — `requireAdmin.ts` trusts it completely. 0001's RLS
policies restricted which *row* a signed-in user could touch (`auth.uid()
= id`) but not which *columns*, so the original "Users update own profile"
policy let any signed-in user PATCH their own `role` to `'admin'` via a
direct Supabase client call, and "Users insert own profile" let a
freshly-registered user's own insert set `role: 'admin'` immediately.
Nothing in this repo exploited this before `0004_user_profiles_role_guard.sql`
(the frontend had no direct Supabase client at all until the same change
that added one), but it was a live landmine for the moment one showed up —
which is exactly what happened once sign-in/sign-up pages were built.

`0004` fixes it two ways: the INSERT policy's `with check` now pins
`role = 'user'`, and a `before update` trigger blocks any change to `role`
unless the request is running as the service role (`auth.role() =
'service_role'`) — which RLS's `using`/`with check` clauses can't express
on their own, since the service role bypasses RLS entirely rather than
being subject to a stricter policy. The backend's admin role-management
endpoints (`POST /admin/users/:id/role`, `admin.ts`) and the one-time
first-admin SQL bootstrap (README.md → "User access control") both still
work because they always run as the service role or with direct database
access respectively; a signed-in end user's session, via the anon key,
never does.

## Core entities

| Table | Purpose |
|---|---|
| `countries`, `competitions`, `seasons` | Reference hierarchy for leagues/cups |
| `venues`, `teams`, `managers`, `team_managers`, `players`, `referees` | Football entities |
| `fixtures` | Matches — scheduled through finished, with scores and importance tags |
| `standings` | League table snapshots per season |
| `team_statistics` | Per-team stats by scope (`overall`/`home`/`away`/`last_5`/`last_10`) — `yellow_cards`/`red_cards` and `corners` (0005) are season totals/averages, `overall` scope only |
| `fixture_statistics` (0005) | Per-fixture, per-team box-score stats — today, only `corners` (the one field not in `/teams/statistics`'s season aggregate); aggregated into `team_statistics.corners` by `syncFixtureStatistics.ts` |
| `player_statistics` (0006) | Per-player season stats (goals, appearances, minutes), scoped to one team — powers the anytime-goalscorer markets. `player_name` is a deliberate denormalization of `players.name` (see 0006's comment) |
| `injuries` | Player availability, status enum (`injured`/`suspended`/`international_duty`/`doubtful`/`returned`) |
| `lineups` | Expected vs. confirmed XI per fixture (`confirmation_status`) |
| `odds_snapshots` | Bookmaker odds per market/selection, timestamped |
| `weather_observations` | Match-day weather |
| `model_versions`, `model_evaluations` | Model registry and backtest metrics |
| `league_calibration` (0007) | One row per competition — real average home/away goals computed from that competition's own finished fixtures, replacing the fixed cross-league default for live predictions (see `ML_Model.md`'s "League-specific calibration" section) |
| `competition_rho` (0008) | One row per (`model_version_id`, `competition_id`) — a Dixon-Coles rho fit scoped to just that competition's own matches, stored alongside (never overwriting) the global fit (see `ML_Model.md`'s "Per-competition rho" section) |
| `predictions` | Market probabilities per fixture, with confidence/data_quality/factors |
| `user_profiles`, `notifications` | User-owned data, RLS-protected |
| `ingestion_runs`, `data_quality_flags` | Observability for sync jobs and data validation |
| `team_elo_ratings` (0009) | One row per team — global Elo rating, recomputed from scratch and upserted on each run of `computeEloRatings.ts` |
| `competition_allowlist` (0010) | Which competitions the screening/ensemble pipeline is allowed to consider — ships empty by design; see "Known gaps" below |
| `ensemble_config`, `screening_config`, `accumulator_targets` (0011) | Admin-editable weights/thresholds — per-component ensemble weights, selection-score weights + risk-tier thresholds, and per-leg-target minimum score, respectively. The first genuinely admin-*edited* config in this schema, distinct from admin-*computed* tables like `league_calibration`/`competition_rho` |
| `ensemble_predictions` (0012) | Prediction history for the ensemble model — combined probability, which components were present vs. missing, consensus level, 0-100 selection score, 5-tier risk classification, EV/edge against real odds, data quality. Same never-overwrite/`superseded_at` versioning as `predictions` |
| `accumulator_recommendations` (0013) | One row per built accumulator (per target leg count, per run) — a self-describing snapshot of its legs (`leg_selections` jsonb) so the row stays meaningful even after the underlying `ensemble_predictions` rows are superseded, plus combined odds/probability, correlation penalty, composite score, and an `is_best_overall` flag |

## AI Football Analyst / Accumulator Engine tables

Migrations `0009`–`0013` back the ensemble/screening/accumulator feature
described in `ML_Model.md`'s "Ensemble model" section. Two design points
worth calling out here specifically:

- **No new table for "Matches to Avoid."** It's a filtered read of
  `ensemble_predictions` (`risk_tier in ('high_risk','avoid')` or
  `consensus_level = 'conflicting'` or `data_quality = 'insufficient'`) —
  see `screeningService.ts`'s `getMatchesToAvoid()`.
- **The 5-tier risk scheme (elite/strong/medium/high_risk/avoid) got its
  own column on `ensemble_predictions` rather than reusing
  `predictions.risk_classification`**, whose check constraint
  (`'low'|'moderate'|'high'`) is already load-bearing for the existing
  Poisson/gradient-boosting output — the same reasoning that gave
  `competition_rho` its own table instead of folding into
  `league_calibration`.

## Two providers, one external_ref column

`0014_football_data_org_external_refs.sql` added `football-data.org` as a
second, real, **swappable-alternative** `FootballDataProvider`
(`FOOTBALL_DATA_PROVIDER=football-data-org` — see `Data_Sources.md`'s "Two
providers, never blended" section for the full reasoning). Rather than a
new column or a new table, it reuses the existing `external_ref jsonb`
column every entity table already has (from 0001/0002/0003), keyed by a
second jsonb key: `external_ref->>'football_data_org'`, alongside
`external_ref->>'api_football'`. A row can in principle carry both keys at
once (nothing prevents it), but in practice a row is only ever written by
whichever single provider was active at the time — there is no
cross-provider merge step.

`referenceDataService.ts`'s `providerRefKey()` derives the jsonb key from
whichever provider is actually running (`FootballDataProvider.name`, e.g.
`"api-football"` → `"api_football"`), so every `upsertX`/`externalId` call
in every sync job (`syncFixtures.ts`, `syncTeamStatistics.ts`, etc.) is
parameterized by it — none of them hardcode a provider's key anymore. This
was a real refactor, not just additive: before this feature,
`referenceDataService.ts` hardcoded a single `PROVIDER_KEY = "api_football"`
constant used by every function, which would have silently mislabeled
football-data.org-sourced rows as `api_football` ones had it not been
generalized — a real correctness bug this migration's own indexes would not
have caught, since the jsonb *key itself* would have been wrong, not just
its uniqueness.

`0014` adds `football_data_org` partial unique indexes on `seasons`,
`fixtures`, `teams`, and `competitions` — the same four tables 0002/0003
cover for `api_football`, **deliberately excluding `countries` and
`players`**: countries are matched by name for every provider (see
`upsertCountryByName` — 0002's own `api_football` countries index is
unused dead schema for the identical reason), and football-data.org's free
tier has no player-level endpoint at all, so nothing will ever populate
`players.external_ref->>'football_data_org'`.

Verified directly against a real local Postgres 16 instance (unlike most
migrations in this file — see "Known gaps" below): applied `0001`–`0014` in
order against a fresh database, then confirmed two rows with the *same*
external id under *different* provider keys (e.g. both `"39"`, one keyed
`api_football`, one `football_data_org`) coexist without a false collision,
while inserting a genuine duplicate within one provider's key correctly
raises a unique-constraint violation.

## Known gaps

- No migration tooling wired up yet (no `supabase/config.toml`/CLI
  integration in CI) — migrations are applied manually today.
- `0004_user_profiles_role_guard.sql`'s trigger and tightened INSERT policy
  have not been run against a real Postgres/Supabase project — no live
  project is available in this environment. The logic (a `before update`
  trigger checking `auth.role() = 'service_role'`) follows documented
  Supabase/Postgres behavior, not a confirmed live test; apply and smoke-test
  it (sign up a user, confirm they can't PATCH their own `role` via the
  Supabase client, confirm `POST /admin/users/:id/role` still works) before
  relying on it in production.
- `0005_fixture_statistics_and_cards.sql` (new `fixture_statistics` table,
  new `team_statistics.yellow_cards`/`red_cards` columns) has not been run
  against a real Postgres/Supabase project either — same caveat as every
  migration in this file. Apply it and confirm `syncFixtureStatistics.ts`'s
  upserts actually behave as documented (partial column update on conflict,
  not a full-row overwrite) before relying on it.
- `0006_player_statistics.sql` (new `player_statistics` table) — same
  unrun-against-a-real-project caveat. Also worth confirming once a live
  project exists: `upsertPlayer` (`referenceDataService.ts`) creates a new
  `players` row keyed by external id but never updates `team_id` on an
  existing row, so a player transferred mid-season will show their
  `players.team_id` as whichever team `syncPlayerStatistics.ts` (or
  `syncLineups.ts`) happened to see them under first — `player_statistics`
  itself is unaffected (it's keyed by `player_id, team_id, season_id`, so a
  transfer correctly gets its own row), but anything reading `players.team_id`
  directly should know it can be stale.
- `0007_league_calibration.sql` (new `league_calibration` table) — same
  unrun-against-a-real-project caveat as every migration in this file. Its
  writer (`calibrateLeagues.ts`) and reader (`getLeagueAverages()`) are
  both unit-tested against `FakeSupabase`, but the real
  `upsert(..., { onConflict: "competition_id" })` behavior — updating the
  existing row in place on a rerun, not inserting a duplicate — has only
  been exercised against the fake, not a live Postgres unique constraint.
- `0008_competition_rho.sql` (new `competition_rho` table) — same
  unrun-against-a-real-project caveat as every migration in this file. Its
  writer (`runLatestDixonColesRhoFitJob()` in `fitDixonColesRho.ts`) and
  reader (`getCompetitionRho()` in `calibrateLeagues.ts`) are both
  unit-tested against `FakeSupabase`, but the real
  `upsert(..., { onConflict: "model_version_id,competition_id" })` behavior
  — updating the existing row in place on a rerun, not inserting a
  duplicate — has only been exercised against the fake, same as
  `league_calibration`'s equivalent caveat above. Both `model_version_id`
  and `competition_id` are `references ... on delete cascade`, unverified
  against a live project like the rest of this schema.
- Real fixtures and `overall`/`home`/`away` team statistics can now be
  synced (`syncFixtures.ts`, `syncTeamStatistics.ts`), so predictions can
  run on non-synthetic fixtures once both have been run — but this hasn't
  been exercised end-to-end against a live provider/database (see Task.md).
- `team_statistics.last_5`/`last_10` scopes are never written by any
  current job — the vendor's aggregated stats endpoint doesn't break
  results down match-by-match, so those scopes need a future results-sync
  job instead (see `Data_Sources.md`).
- `model_evaluations` now has a writer: `backend/src/jobs/runBacktest.ts`
  writes one row per walk-forward backtest run of the `1x2` market, for
  whichever model (`poisson-baseline` or `gradient-boosting`) the run was
  scoped to (see `ML_Model.md`'s "Backtesting" and "Gradient boosting
  model" sections). It has never actually been run against real data in
  this environment — no live API-Football key has ever been connected,
  so there's no real fixture history to backtest against — so the table
  remains empty in practice; only the writer exists.
- `model_versions` still has no admin route to insert a row — every row
  (`poisson-baseline`, and now `gradient-boosting`) is manually seeded
  (`supabase/seed/dev_seed_synthetic.sql` for dev; a real deployment needs
  the same one-time manual SQL insert, same bootstrap pattern as the first
  admin account — see README.md). `gradient-boosting`'s seeded row is
  deliberately left untrained (`trained_at = null`): `backend/src/jobs/
  trainGradientBoosting.ts` is that row's real writer for
  `trained_at`/`training_dataset_version`/`notes`, but there's no real
  fixture history in this environment to train it on yet.
  `backend/src/jobs/fitDixonColesRho.ts` is a second, later writer for
  those same three columns on `poisson-baseline`'s row specifically (a
  Dixon-Coles `rho` fit refines that existing model rather than creating a
  new one — see `ML_Model.md`'s "Rho fitting" section) — same "real writer
  exists, never actually run against real data" caveat applies.
- `teams.country_id` and `competitions.competition_type` are not correctly
  populated by fixture ingestion — see `Data_Sources.md`'s "Known
  limitation" notes.
- `injuries` never transitions a row to `returned` — a recovered player's
  row simply goes stale (see freshness classification) rather than being
  actively updated, since nothing in the current sync detects recovery.
- `standings` has no column for which group a row came from, so a
  competition with a split table (group stages, championship/relegation
  rounds) has its groups flattened by `syncStandings.ts` — a team in two
  groups the same season just has the later one win on upsert.
- `lineups.confirmation_status` is always written as `'confirmed'` by
  `syncLineups.ts` — the `'expected'` value this column supports is never
  used by any current job, since api-football's lineups endpoint is
  reasoned (not yet verified) to only return officially released lineups.
- `odds_snapshots` has no de-duplication: `syncOdds.ts` inserts a full new
  set of rows every run regardless of whether prices changed, so running it
  on a tight schedule grows the table with duplicate-valued history. A
  future version could skip inserting a selection whose price matches its
  immediately preceding snapshot — not implemented yet (see `Task.md`).
- `0009`–`0013` (Elo ratings, admin config, ensemble predictions,
  accumulator recommendations) have been applied and smoke-tested against a
  local Postgres 16 instance with a stubbed `auth` schema, unlike most
  migrations in this list — but never against a real Supabase project, so
  RLS/service-role behavior and any Supabase-specific trigger semantics
  remain unverified the same as everything else here.
- `competition_allowlist` (0010) ships with zero rows by design — an admin
  has to explicitly enable competitions before the ensemble/screening
  pipeline will consider any fixture. Until that happens, `/top20`,
  `/matches-to-avoid`, and `/accumulators` all correctly return empty, not
  "everything" — see `ML_Model.md`'s "Competition allowlist" note.
- The ensemble/accumulator feature depends on `model_versions` having an
  `'ensemble'` row, exactly like `poisson-baseline`/`gradient-boosting`
  before it — seeded in dev (`dev_seed_synthetic.sql`), but a real
  deployment needs the same one-time manual SQL insert described above for
  `model_versions`.
- `ensemble_predictions`/`accumulator_recommendations` have no settling
  logic yet — nothing writes a result/outcome back onto a row after its
  fixture finishes. The versioning (`generated_at`/`superseded_at`) is
  deliberately shaped so a future settling job can find "the row that was
  live at kickoff" without a breaking migration, but that job, a P&L
  computation, and the Performance/ROI dashboard it would feed are all
  deferred to Phase 2 (see `Road_map.md`).
