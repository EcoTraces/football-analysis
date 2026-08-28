-- League-specific calibration (ML_Model.md's "League-specific calibration"
-- section) — replaces the fixed, cross-league LEAGUE_AVG_HOME_GOALS/
-- LEAGUE_AVG_AWAY_GOALS constants (generatePredictions.ts) with a real
-- per-competition average, computed from that competition's own finished,
-- non-synthetic fixtures by backend/src/jobs/calibrateLeagues.ts.
--
-- One row per competition (never per season) — deliberately averaged over
-- all of a competition's real history seen so far, not windowed, since a
-- single season rarely has enough finished matches on its own for a
-- trustworthy average this early in a competition's data history. A
-- competition with too little real history yet simply has no row here;
-- getLeagueAverages() falls back to the fixed cross-league default in that
-- case rather than calibrating off too little data.
create table league_calibration (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  league_avg_home_goals numeric not null,
  league_avg_away_goals numeric not null,
  sample_size integer not null,
  computed_at timestamptz not null default now(),
  unique (competition_id)
);
