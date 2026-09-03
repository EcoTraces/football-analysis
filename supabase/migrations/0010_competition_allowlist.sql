-- Competition allowlist (AI Football Analyst Phase 1) — which competitions
-- the Top 20 screening / accumulator engine is allowed to draw fixtures
-- from, admin-configured via backend/src/services/adminConfigService.ts.
--
-- Ships empty. competitions rows only exist once a live fixture sync has
-- actually populated them (referenceDataService.ts upserts them from
-- provider data), and this table can only reference competition_id values
-- that already exist — so it cannot be pre-seeded with the user's intended
-- 8-country/11-competition list here. An empty table is an explicit
-- "nothing allowlisted yet" state: the screening engine must treat that as
-- "no eligible fixtures," never as "allow everything unfiltered."
create table competition_allowlist (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  enabled boolean not null default true,
  added_at timestamptz not null default now(),
  added_by uuid references user_profiles(id),
  unique (competition_id)
);
