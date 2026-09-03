-- Admin-editable configuration for the AI Football Analyst ensemble/
-- screening/accumulator engine (Phase 1) — a genuinely new pattern in this
-- schema. Every existing calibration-style table (league_calibration,
-- competition_rho) is admin-*computed* (a job writes it, an admin only
-- triggers the job); these three tables are admin-*edited* directly via
-- backend/src/services/adminConfigService.ts and a form in AdminDashboard.
--
-- Weight columns are not sum-to-1 constrained at the database level —
-- floating-point rounding on partial admin edits would make a check
-- constraint brittle. Sum validation lives in the Zod schema on the PUT
-- route instead.
--
-- Default weights below drop the spec's original "xG Model" component
-- entirely (this project's data provider never supplies xG — see
-- ML_Model.md) and redistribute its intended 25% weight proportionally
-- across the remaining six real components. Like every other model
-- constant in this codebase (poisson.py's RHO, main.py's CARDS_LINE),
-- these are a documented starting point, not a fitted/optimal answer —
-- backtesting these weights is future work.
create table ensemble_config (
  key text primary key default 'default',
  elo_weight numeric not null default 0.2667,
  poisson_weight numeric not null default 0.2000,
  form_weight numeric not null default 0.2000,
  home_away_weight numeric not null default 0.1333,
  injuries_weight numeric not null default 0.1333,
  market_weight numeric not null default 0.0667,
  updated_at timestamptz not null default now(),
  updated_by uuid references user_profiles(id)
);
insert into ensemble_config (key) values ('default');

-- Selection-score weights (0-100 score) and risk-tier score cutoffs used by
-- ml-service's ensemble.selection_score()/risk_tier(). Deliberately only 4
-- score-weight inputs (not the fuller 7-component breakdown in the
-- original spec) because "statistical strength," "opponent adjustment,"
-- and "tactical matchup" as independent signals require data (xG,
-- tactical/formation data) this platform doesn't have — the 4 columns here
-- are exactly the 4 signals Phase 1 actually computes: the ensemble's own
-- combined probability/confidence, EV against real odds, model agreement,
-- and data quality.
create table screening_config (
  key text primary key default 'default',
  score_weight_ensemble_confidence numeric not null default 0.40,
  score_weight_ev numeric not null default 0.30,
  score_weight_consensus numeric not null default 0.20,
  score_weight_data_quality numeric not null default 0.10,
  risk_tier_elite_min numeric not null default 85,
  risk_tier_strong_min numeric not null default 70,
  risk_tier_medium_min numeric not null default 50,
  risk_tier_high_risk_min numeric not null default 30,
  updated_at timestamptz not null default now(),
  updated_by uuid references user_profiles(id)
);
insert into screening_config (key) values ('default');

-- Accumulator combined-odds targets (Task.md's "Accumulator Engine"
-- section) — one row per target, admin-editable min-selection-score floor
-- for a leg to be eligible for that target's accumulator.
create table accumulator_targets (
  id uuid primary key default gen_random_uuid(),
  legs integer not null,
  min_selection_score numeric not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references user_profiles(id),
  unique (legs)
);
insert into accumulator_targets (legs, min_selection_score) values
  (5, 60),
  (7, 65),
  (10, 70),
  (15, 75),
  (20, 80);
