-- Accumulator recommendations (AI Football Analyst Phase 1) — the output of
-- backend/src/jobs/buildAccumulators.ts, one row per generated accumulator
-- candidate for a given target leg-count (see accumulator_targets).
--
-- leg_fixture_ids/leg_selections is a denormalized snapshot of the legs
-- (fixture id, market, selection, and the ensemble_predictions row id each
-- came from) rather than a join table, so this row stays self-describing
-- even after the underlying ensemble_predictions rows it was built from
-- get superseded by a later run — needed for later settling/P&L (Phase 2)
-- without having to reconstruct "what did this accumulator actually
-- contain at the time" from possibly-overwritten state.
create table if not exists accumulator_recommendations (
  id uuid primary key default gen_random_uuid(),
  target_legs integer not null,
  leg_fixture_ids uuid[] not null,
  leg_selections jsonb not null, -- [{ ensemblePredictionId, fixtureId, market, selection, odds }, ...]
  combined_probability numeric not null check (combined_probability >= 0 and combined_probability <= 1),
  combined_decimal_odds numeric,
  correlation_penalty numeric not null default 0,
  composite_score numeric not null check (composite_score >= 0 and composite_score <= 100),
  risk_tier text not null check (risk_tier in ('elite', 'strong', 'medium', 'high_risk', 'avoid')),
  is_best_overall boolean not null default false,
  generated_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_accumulator_recommendations_target on accumulator_recommendations (target_legs) where superseded_at is null;
