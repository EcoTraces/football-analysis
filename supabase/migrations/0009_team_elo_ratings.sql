-- Team Elo ratings (AI Football Analyst Phase 1 — Task.md's "Elo rating
-- model" item) — a global, cross-competition strength rating maintained by
-- backend/src/jobs/computeEloRatings.ts.
--
-- One row per team, recomputed from scratch on every run (same
-- "recompute the whole thing" simplicity as league_calibration, not an
-- incremental update) — the job replays every finished, non-synthetic
-- fixture in chronological order and upserts the resulting rating here.
-- Per-competition Elo is out of scope for Phase 1 (see competition_rho for
-- the precedent of a genuinely per-competition table, added only once a
-- per-competition version of *this* was actually needed).
create table if not exists team_elo_ratings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  rating numeric not null,
  matches_played integer not null default 0,
  computed_at timestamptz not null default now(),
  unique (team_id)
);
