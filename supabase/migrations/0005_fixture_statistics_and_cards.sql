-- Adds data for two new prediction markets (bookings/cards, corners).
--
-- Cards: api-football's /teams/statistics endpoint — already called by
-- syncTeamStatistics.ts — includes a `cards.yellow`/`cards.red` breakdown
-- per team that this codebase has never parsed. Two nullable columns on
-- the existing team_statistics table are enough to hold it; see
-- ApiFootballProvider.ts's mapTeamStatistics for how the per-minute-
-- interval breakdown gets summed into a single season total. Only the
-- 'overall' scope row gets a value (same as clean_sheets/failed_to_score
-- already do) — the vendor's cards breakdown isn't split by home/away.
alter table team_statistics add column if not exists yellow_cards numeric;
alter table team_statistics add column if not exists red_cards numeric;

-- Corners: NOT available from /teams/statistics at all — api-football only
-- exposes it per fixture, via /fixtures/statistics. This table stores one
-- row per (fixture, team) from that endpoint; team_statistics.corners
-- (present since 0001 but never populated until now) is then refreshed as
-- an average over these rows by syncFixtureStatistics.ts, the same way the
-- vendor pre-aggregates goals for us but corners has to be aggregated here
-- instead.
create table if not exists fixture_statistics (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  team_id uuid not null references teams(id),
  season_id uuid not null references seasons(id) on delete cascade,
  corners integer,
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  unique (fixture_id, team_id)
);

create index if not exists idx_fixture_statistics_team_season on fixture_statistics (team_id, season_id);
