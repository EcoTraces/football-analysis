-- Real provider ingestion needs a stable external id to upsert against.
-- The fixtures natural-key unique index (teams + kickoff) breaks the moment
-- a fixture is postponed and rescheduled — the provider's own fixture id
-- does not change, so ingestion must be able to look rows up by it.
-- Discovered while implementing ApiFootballProvider; see Data_Sources.md.

alter table countries add column if not exists external_ref jsonb not null default '{}'::jsonb;
alter table seasons add column if not exists external_ref jsonb not null default '{}'::jsonb;
alter table fixtures add column if not exists external_ref jsonb not null default '{}'::jsonb;

-- Partial unique indexes: only enforce uniqueness where a given provider's
-- external id is actually present, so rows with no external_ref yet (e.g.
-- the synthetic seed) are unaffected.
-- Reserved for a future dedicated countries sync (API-Football exposes a
-- stable country id via a separate /countries endpoint). Fixture ingestion
-- itself only ever gets a country *name* from the fixtures payload, so it
-- matches/creates countries by name — this index stays unused until that
-- endpoint is wired in.
create unique index if not exists uq_countries_external_api_football
  on countries ((external_ref->>'api_football'))
  where external_ref ? 'api_football';

-- A season's provider id (e.g. "2026") is only unique within its own
-- competition — every league has a season called "2026" — so the
-- uniqueness constraint must be scoped by competition_id, not global.
create unique index if not exists uq_seasons_external_api_football
  on seasons (competition_id, (external_ref->>'api_football'))
  where external_ref ? 'api_football';

create unique index if not exists uq_fixtures_external_api_football
  on fixtures ((external_ref->>'api_football'))
  where external_ref ? 'api_football';

-- Teams and competitions already have an external_ref column from the
-- initial schema (0001) but no uniqueness constraint on it yet — add one
-- now that real ingestion relies on it to avoid creating duplicate rows.
create unique index if not exists uq_teams_external_api_football
  on teams ((external_ref->>'api_football'))
  where external_ref ? 'api_football';

create unique index if not exists uq_competitions_external_api_football
  on competitions ((external_ref->>'api_football'))
  where external_ref ? 'api_football';
