-- Per-competition Dixon-Coles rho fits (ML_Model.md's "Rho fitting"
-- section, per-competition extension) — a refinement of the
-- poisson-baseline model's rho for one specific competition, computed and
-- stored separately from the single global fit that already lives in
-- model_versions.notes/ml-service's process-wide _fitted_rho.
--
-- Shaped like model_evaluations (model_version_id + competition_id + a
-- window + diagnostics) rather than league_calibration's plain
-- (competition_id, value) shape — rho fitting is a model calibration
-- record tied to one specific model version, not a cross-model
-- observational stat the way a league's raw average goals is.
create table competition_rho (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references model_versions(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  fitted_rho numeric not null,
  default_rho numeric not null,
  sample_size integer not null,
  informative_matches integer not null,
  log_likelihood_at_fitted_rho numeric not null,
  log_likelihood_at_default_rho numeric not null,
  evaluation_window text not null, -- e.g. '2025-08-01T00:00:00.000Z..2025-08-31T23:59:59.000Z'
  computed_at timestamptz not null default now(),
  unique (model_version_id, competition_id)
);
