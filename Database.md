# Database

Postgres via Supabase. Full schema: `supabase/migrations/0001_init.sql`.
Dev-only synthetic seed: `supabase/seed/dev_seed_synthetic.sql`.

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
  `(competition_id, season_id, home_team_id, away_team_id, kickoff_utc)` so
  re-running a sync job upserts instead of duplicating.
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
- No historical results have been backfilled; `team_statistics` must be
  populated by a future stats-sync job before predictions can be generated
  for real fixtures.
- `model_evaluations` has no writer yet — no backtesting job exists (see
  `ML_Model.md`, `Task.md`).
