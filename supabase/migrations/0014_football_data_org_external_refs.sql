-- football-data.org is a second, SWAPPABLE FootballDataProvider
-- (FOOTBALL_DATA_PROVIDER=football-data-org — see FootballDataOrgProvider.ts
-- and Data_Sources.md), not a second simultaneous source alongside
-- api-football: the two vendors use unrelated external-id namespaces for
-- the same real teams/competitions, so each gets its own external_ref jsonb
-- key ("football_data_org" here, "api_football" from 0002/0003) rather than
-- sharing one. Same partial-unique-index pattern as 0002 — enforced only
-- where this specific provider's id is actually present, so rows created by
-- the other provider (or the synthetic seed) are unaffected.
--
-- Deliberately NOT extended to countries or players: countries are matched
-- by name for every provider (see referenceDataService.ts's
-- upsertCountryByName — 0002's own countries index is unused dead schema
-- for the same reason), and football-data.org's free tier has no
-- player-level endpoint at all (see FootballDataOrgProvider.ts), so nothing
-- will ever write players.external_ref->>'football_data_org'.

create unique index if not exists uq_seasons_external_football_data_org
  on seasons (competition_id, (external_ref->>'football_data_org'))
  where external_ref ? 'football_data_org';

create unique index if not exists uq_fixtures_external_football_data_org
  on fixtures ((external_ref->>'football_data_org'))
  where external_ref ? 'football_data_org';

create unique index if not exists uq_teams_external_football_data_org
  on teams ((external_ref->>'football_data_org'))
  where external_ref ? 'football_data_org';

create unique index if not exists uq_competitions_external_football_data_org
  on competitions ((external_ref->>'football_data_org'))
  where external_ref ? 'football_data_org';
