-- Football Analysis Platform — initial schema
-- Design notes:
--   * Every time-sensitive table carries source, source_timestamp, and updated_at
--     so the API can compute LIVE / RECENT / STALE / UNAVAILABLE freshness.
--   * is_synthetic flags rows created by the dev-only seed script so they can
--     never be mistaken for provider data and are trivial to purge.
--   * Money/odds are numeric, not float, to avoid rounding drift in EV math.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table if not exists countries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text unique, -- ISO 3166-1 alpha-2/3 where known
  confederation text, -- UEFA, CONMEBOL, CONCACAF, AFC, CAF, OFC
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists competitions (
  id uuid primary key default gen_random_uuid(),
  country_id uuid references countries(id),
  name text not null,
  short_name text,
  tier integer, -- 1 = top flight, 2 = second tier, etc.
  competition_type text not null check (competition_type in ('league', 'cup', 'continental', 'playoff')),
  external_ref jsonb not null default '{}'::jsonb, -- provider-specific ids, e.g. {"api_football": 39}
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country_id, name)
);

create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  label text not null, -- e.g. "2025/2026"
  start_date date,
  end_date date,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (competition_id, label)
);

create table if not exists venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  country_id uuid references countries(id),
  capacity integer,
  surface text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  country_id uuid references countries(id),
  name text not null,
  short_name text,
  crest_url text,
  venue_id uuid references venues(id),
  external_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists managers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nationality_country_id uuid references countries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists team_managers (
  team_id uuid not null references teams(id) on delete cascade,
  manager_id uuid not null references managers(id) on delete cascade,
  start_date date not null,
  end_date date,
  primary key (team_id, manager_id, start_date)
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id),
  name text not null,
  position text check (position in ('GK', 'DF', 'MF', 'FW')),
  date_of_birth date,
  nationality_country_id uuid references countries(id),
  external_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists referees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_id uuid references countries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Fixtures / matches
-- ---------------------------------------------------------------------------

create table if not exists fixtures (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  competition_id uuid not null references competitions(id),
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  venue_id uuid references venues(id),
  referee_id uuid references referees(id),
  round text, -- e.g. "Matchday 12", "Quarter-final"
  kickoff_utc timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'abandoned')),
  home_score integer,
  away_score integer,
  home_score_ht integer,
  away_score_ht integer,
  importance_tags text[] not null default '{}', -- e.g. {title_race, relegation_battle, derby}
  source text not null,
  source_timestamp timestamptz not null,
  data_version integer not null default 1,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint valid_score check (
    (status <> 'finished') or (home_score is not null and away_score is not null)
  )
);

create index if not exists idx_fixtures_kickoff on fixtures (kickoff_utc);
create index if not exists idx_fixtures_competition on fixtures (competition_id, season_id);
create index if not exists idx_fixtures_teams on fixtures (home_team_id, away_team_id);
create index if not exists idx_fixtures_status on fixtures (status);
-- Prevent duplicate ingestion of the same fixture from re-run sync jobs.
create unique index if not exists uq_fixtures_natural_key on fixtures (competition_id, season_id, home_team_id, away_team_id, kickoff_utc);

create table if not exists standings (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  team_id uuid not null references teams(id),
  position integer not null,
  played integer not null default 0,
  wins integer not null default 0,
  draws integer not null default 0,
  losses integer not null default 0,
  goals_for integer not null default 0,
  goals_against integer not null default 0,
  points integer not null default 0,
  form text, -- last 5 as e.g. "WWDLW"
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (season_id, team_id)
);

create table if not exists team_statistics (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id),
  season_id uuid not null references seasons(id) on delete cascade,
  scope text not null check (scope in ('overall', 'home', 'away', 'last_5', 'last_10')),
  matches_played integer not null default 0,
  goals_scored numeric,
  goals_conceded numeric,
  xg numeric,
  xga numeric,
  shots numeric,
  shots_on_target numeric,
  possession_pct numeric,
  corners numeric,
  clean_sheets integer,
  failed_to_score integer,
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (team_id, season_id, scope)
);

create table if not exists injuries (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  team_id uuid not null references teams(id),
  status text not null check (status in ('injured', 'suspended', 'international_duty', 'doubtful', 'returned')),
  description text,
  expected_return date,
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lineups (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  team_id uuid not null references teams(id),
  confirmation_status text not null check (confirmation_status in ('expected', 'confirmed')),
  formation text,
  starting_players uuid[] not null default '{}',
  substitute_players uuid[] not null default '{}',
  source text not null,
  source_timestamp timestamptz not null,
  is_synthetic boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (fixture_id, team_id)
);

create table if not exists odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  bookmaker text not null,
  market text not null, -- e.g. '1x2', 'btts', 'over_under_2_5'
  selection text not null, -- e.g. 'home', 'yes', 'over'
  decimal_odds numeric not null check (decimal_odds > 1),
  captured_at timestamptz not null,
  source text not null,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_odds_fixture on odds_snapshots (fixture_id, market);

create table if not exists weather_observations (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  temperature_c numeric,
  precipitation_mm numeric,
  wind_kph numeric,
  humidity_pct numeric,
  observed_at timestamptz not null,
  source text not null,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Model / predictions
-- ---------------------------------------------------------------------------

create table if not exists model_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null, -- e.g. 'poisson-baseline'
  version text not null,
  algorithm text not null,
  trained_at timestamptz,
  training_dataset_version text,
  notes text,
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table if not exists model_evaluations (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references model_versions(id) on delete cascade,
  competition_id uuid references competitions(id), -- null = all competitions
  market text not null,
  evaluation_window text not null, -- e.g. '2025-08-01..2025-08-31'
  accuracy numeric,
  log_loss numeric,
  brier_score numeric,
  sample_size integer not null,
  created_at timestamptz not null default now()
);

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  model_version_id uuid not null references model_versions(id),
  market text not null, -- '1x2', 'btts', 'over_under_2_5', ...
  selection text not null, -- 'home', 'draw', 'away', 'yes', 'no', 'over', 'under'
  probability numeric not null check (probability >= 0 and probability <= 1),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  data_quality text not null check (data_quality in ('insufficient', 'limited', 'strong')),
  risk_classification text check (risk_classification in ('low', 'moderate', 'high')),
  factors jsonb not null default '[]'::jsonb, -- [{ "direction": "positive", "label": "Strong home form" }, ...]
  generated_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_predictions_fixture on predictions (fixture_id, market);
create index if not exists idx_predictions_current on predictions (fixture_id) where superseded_at is null;

-- ---------------------------------------------------------------------------
-- Users / notifications (Supabase auth.users is the identity source of truth)
-- ---------------------------------------------------------------------------

create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  favorite_team_ids uuid[] not null default '{}',
  favorite_competition_ids uuid[] not null default '{}',
  notification_preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_profiles(id) on delete cascade,
  type text not null check (type in (
    'match_starting_soon', 'lineup_confirmed', 'injury_update',
    'prediction_changed', 'match_result', 'daily_analysis', 'model_update'
  )),
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user on notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Data quality / ingestion observability
-- ---------------------------------------------------------------------------

create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  provider text not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'partial')),
  records_processed integer not null default 0,
  records_rejected integer not null default 0,
  error_summary text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists data_quality_flags (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null, -- 'fixture', 'player', etc.
  entity_id uuid not null,
  issue text not null, -- 'duplicate', 'invalid_score', 'stale', ...
  detail text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table user_profiles enable row level security;
alter table notifications enable row level security;

-- Postgres has no "create policy if not exists" — drop-then-create is the
-- standard idempotent pattern (already used by 0004's own policy/trigger
-- redefinitions below it in this migration set).
drop policy if exists "Users read own profile" on user_profiles;
create policy "Users read own profile" on user_profiles
  for select using (auth.uid() = id);
drop policy if exists "Users update own profile" on user_profiles;
create policy "Users update own profile" on user_profiles
  for update using (auth.uid() = id);
drop policy if exists "Users insert own profile" on user_profiles;
create policy "Users insert own profile" on user_profiles
  for insert with check (auth.uid() = id);

drop policy if exists "Users read own notifications" on notifications;
create policy "Users read own notifications" on notifications
  for select using (auth.uid() = user_id);
drop policy if exists "Users update own notifications" on notifications;
create policy "Users update own notifications" on notifications
  for update using (auth.uid() = user_id);

-- Public football data (fixtures, teams, predictions, etc.) is read-only via
-- the anon key and written only by the backend using the service role key,
-- which bypasses RLS — so no RLS policies are defined on those tables here.
-- The backend is the sole writer; see Coding_Rules.md.
