# Database

Postgres via Supabase. Schema: `supabase/migrations/0001_init.sql` (initial
schema), `0002_provider_external_refs.sql` (external-id columns/indexes for
countries/seasons/fixtures/teams/competitions), and
`0003_injuries_and_players_refs.sql` (external-id uniqueness for `players`,
plus a uniqueness constraint on `injuries` that 0001 didn't anticipate
needing) — each added once a real ingestion job needed it. Dev-only
synthetic seed: `supabase/seed/dev_seed_synthetic.sql`.

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
  from 0002 — the one real ingestion job (`syncFixtures.ts`) actually
  upserts against the latter, since a postponed-and-rescheduled fixture
  keeps its provider id but changes kickoff time (the natural key would
  treat that as a new row). `teams` and `competitions` got the same
  external-id uniqueness in 0002. `seasons`' external id is scoped by
  `competition_id` — a season's provider id like "2026" repeats across
  every competition, so global uniqueness there would be wrong.
  `team_statistics`'s uniqueness (`team_id, season_id, scope`) and
  `standings`'s (`season_id, team_id`), by contrast, are genuine
  plain-column constraints from 0001, and `injuries`' new uniqueness on
  `player_id` (0003) is too — `syncTeamStatistics.ts`, `syncStandings.ts`,
  and `syncInjuries.ts` all use a real `upsert(..., { onConflict: ... })`
  against them rather than the find-then-insert pattern the expression-index
  tables need (see `Data_Sources.md`). `injuries` models "current status per
  player," not a history of every report — see 0003's comment for the
  known edge case that simplification accepts.
- **Prediction history, not overwrite.** `predictions` rows are never
  mutated after creation; recalculating sets `superseded_at` on the old row
  and inserts a new one. `idx_predictions_current` (partial index on
  `superseded_at is null`) keeps "give me the current prediction" queries
  fast.
- **RLS.** Enabled on `user_profiles` and `notifications` (user reads/writes
  only their own rows). Football-domain tables have no RLS policies — the
  backend, using the service role key, is their only writer, and reads go
  through the API rather than directly from the frontend with the anon key.

## Core entities

| Table | Purpose |
|---|---|
| `countries`, `competitions`, `seasons` | Reference hierarchy for leagues/cups |
| `venues`, `teams`, `managers`, `team_managers`, `players`, `referees` | Football entities |
| `fixtures` | Matches — scheduled through finished, with scores and importance tags |
| `standings` | League table snapshots per season |
| `team_statistics` | Per-team stats by scope (`overall`/`home`/`away`/`last_5`/`last_10`) |
| `injuries` | Player availability, status enum (`injured`/`suspended`/`international_duty`/`doubtful`/`returned`) |
| `lineups` | Expected vs. confirmed XI per fixture (`confirmation_status`) |
| `odds_snapshots` | Bookmaker odds per market/selection, timestamped |
| `weather_observations` | Match-day weather |
| `model_versions`, `model_evaluations` | Model registry and backtest metrics |
| `predictions` | Market probabilities per fixture, with confidence/data_quality/factors |
| `user_profiles`, `notifications` | User-owned data, RLS-protected |
| `ingestion_runs`, `data_quality_flags` | Observability for sync jobs and data validation |

## Known gaps

- No migration tooling wired up yet (no `supabase/config.toml`/CLI
  integration in CI) — migrations are applied manually today.
- Real fixtures and `overall`/`home`/`away` team statistics can now be
  synced (`syncFixtures.ts`, `syncTeamStatistics.ts`), so predictions can
  run on non-synthetic fixtures once both have been run — but this hasn't
  been exercised end-to-end against a live provider/database (see Task.md).
- `team_statistics.last_5`/`last_10` scopes are never written by any
  current job — the vendor's aggregated stats endpoint doesn't break
  results down match-by-match, so those scopes need a future results-sync
  job instead (see `Data_Sources.md`).
- `model_evaluations` has no writer yet — no backtesting job exists (see
  `ML_Model.md`, `Task.md`).
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
