-- Player-level season statistics, for the anytime-goalscorer markets
-- (home_anytime_goalscorer/away_anytime_goalscorer — see ML_Model.md).
-- Nothing in this schema tracked goals-per-player before this; `players`
-- (0001/0003) only has name/position/team.
--
-- player_name is a deliberate denormalization of players.name: every
-- consumer of this table (generatePredictions.ts) needs a human-readable
-- name per row without a join, and this repo's shared FakeSupabase test
-- double has no support for relational embeds (`select("...,
-- players(name)")`) the way real supabase-js does — see testSupabaseFake.ts.
-- Keeping the name here avoids that gap entirely, at the cost of a name
-- that could drift from players.name if a player is ever renamed (not
-- expected to happen in practice, and not worth a sync step to guard).
create table if not exists player_statistics (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  team_id uuid not null references teams(id),
  season_id uuid not null references seasons(id) on delete cascade,
  player_name text not null,
  matches_played integer not null default 0,
  goals_scored numeric,
  minutes_played integer,
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (player_id, team_id, season_id)
);

create index if not exists idx_player_statistics_team_season on player_statistics (team_id, season_id);
