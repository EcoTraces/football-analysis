-- ============================================================================
-- DEV-ONLY SYNTHETIC SEED DATA — NEVER RUN AGAINST A PRODUCTION DATABASE.
--
-- Every row here is fabricated for local development and automated tests.
-- Every row is flagged is_synthetic = true and source = 'synthetic-dev-seed'
-- so the API and frontend can (and must) refuse to present it as real data.
-- Rule: production reads must filter out is_synthetic = true rows, or must
-- run against a database where this file was never applied.
--
-- See Coding_Rules.md ("No Fake Data Rule") before touching this file.
-- ============================================================================

insert into countries (id, name, code, confederation) values
  ('00000000-0000-0000-0000-000000000001', 'Synthetic Land', 'SYN', 'UEFA')
on conflict (name) do nothing;

insert into competitions (id, country_id, name, short_name, tier, competition_type, is_active) values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
   'Synthetic Premier Division', 'SPD', 1, 'league', true)
on conflict (country_id, name) do nothing;

insert into seasons (id, competition_id, label, start_date, end_date, is_current) values
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010',
   '2025/2026-synthetic', '2025-08-01', '2026-05-31', true)
on conflict (competition_id, label) do nothing;

insert into teams (id, country_id, name, short_name) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', 'Synthetic FC Alpha', 'ALP'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', 'Synthetic FC Beta', 'BET')
on conflict do nothing;

-- 6 fabricated finished fixtures giving each side a plausible goal history,
-- enough for the Poisson model to compute non-trivial attack/defense strengths.
insert into fixtures
  (id, season_id, competition_id, home_team_id, away_team_id, kickoff_utc, status,
   home_score, away_score, source, source_timestamp, is_synthetic)
values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000020',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000102',
   now() - interval '35 days', 'finished', 2, 1, 'synthetic-dev-seed', now(), true),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000020',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000101',
   now() - interval '28 days', 'finished', 0, 2, 'synthetic-dev-seed', now(), true),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000020',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000102',
   now() - interval '21 days', 'finished', 3, 0, 'synthetic-dev-seed', now(), true),
  ('00000000-0000-0000-0000-000000000204', '00000000-0000-0000-0000-000000000020',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000101',
   now() - interval '14 days', 'finished', 1, 1, 'synthetic-dev-seed', now(), true),
  -- An upcoming fixture for the frontend "today"/"upcoming" views to render.
  ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000020',
   '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000102',
   now() + interval '1 day', 'scheduled', null, null, 'synthetic-dev-seed', now(), true)
on conflict do nothing;

insert into model_versions (id, name, version, algorithm, trained_at, notes) values
  ('00000000-0000-0000-0000-000000000301', 'poisson-baseline', '0.1.0-dev', 'dixon-coles-poisson',
   now(), 'Development-only model version used for synthetic seed data.')
on conflict (name, version) do nothing;
