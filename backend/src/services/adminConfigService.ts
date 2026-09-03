import type { SupabaseClient } from "@supabase/supabase-js";

// Admin-editable configuration for the AI Football Analyst engine — see
// migration 0011_ensemble_and_screening_config.sql's header comment for
// why these are admin-*edited* tables, unlike league_calibration/
// competition_rho, which are admin-*computed*.
//
// Every get* function's fallback constants below match that migration's
// own column defaults exactly — used only if the DB row is somehow
// missing (an unseeded FakeSupabase test, or a database that predates the
// migration), so every caller always gets a usable, already-normalized
// config rather than an error. `isDefault: true` in that fallback case
// signals "nothing configured in the database at all", not merely
// "using the values the migration seeded" — once migration 0011 has run,
// a row always exists, so isDefault is effectively a test/pre-migration
// safety net rather than a state real deployments spend time in.

export interface EnsembleWeights {
  elo: number;
  poisson: number;
  form: number;
  homeAway: number;
  injuries: number;
  market: number;
  isDefault: boolean;
}

const DEFAULT_ENSEMBLE_WEIGHTS = {
  elo: 0.2667,
  poisson: 0.2,
  form: 0.2,
  homeAway: 0.1333,
  injuries: 0.1333,
  market: 0.0667
};

export async function getEnsembleWeights(supabase: SupabaseClient): Promise<EnsembleWeights> {
  const { data, error } = await supabase
    .from("ensemble_config")
    .select("elo_weight, poisson_weight, form_weight, home_away_weight, injuries_weight, market_weight")
    .eq("key", "default")
    .maybeSingle();
  if (error) throw new Error(`Failed to load ensemble_config: ${error.message}`);
  if (!data) return { ...DEFAULT_ENSEMBLE_WEIGHTS, isDefault: true };
  return {
    elo: data.elo_weight as number,
    poisson: data.poisson_weight as number,
    form: data.form_weight as number,
    homeAway: data.home_away_weight as number,
    injuries: data.injuries_weight as number,
    market: data.market_weight as number,
    isDefault: false
  };
}

export interface EnsembleWeightsInput {
  elo: number;
  poisson: number;
  form: number;
  homeAway: number;
  injuries: number;
  market: number;
}

export async function upsertEnsembleWeights(supabase: SupabaseClient, weights: EnsembleWeightsInput, updatedBy: string): Promise<void> {
  const { error } = await supabase.from("ensemble_config").upsert(
    {
      key: "default",
      elo_weight: weights.elo,
      poisson_weight: weights.poisson,
      form_weight: weights.form,
      home_away_weight: weights.homeAway,
      injuries_weight: weights.injuries,
      market_weight: weights.market,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy
    },
    { onConflict: "key" }
  );
  if (error) throw new Error(`Failed to upsert ensemble_config: ${error.message}`);
}

export interface ScreeningConfig {
  scoreWeights: { ensembleConfidence: number; ev: number; consensus: number; dataQuality: number };
  riskThresholds: { eliteMin: number; strongMin: number; mediumMin: number; highRiskMin: number };
  isDefault: boolean;
}

const DEFAULT_SCREENING_CONFIG = {
  scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
  riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 }
};

interface ScreeningConfigRow {
  score_weight_ensemble_confidence: number;
  score_weight_ev: number;
  score_weight_consensus: number;
  score_weight_data_quality: number;
  risk_tier_elite_min: number;
  risk_tier_strong_min: number;
  risk_tier_medium_min: number;
  risk_tier_high_risk_min: number;
}

export async function getScreeningConfig(supabase: SupabaseClient): Promise<ScreeningConfig> {
  // Explicit generic on maybeSingle<T>(): the select string here has
  // enough columns that supabase-js's own select-string type inference
  // breaks down (same fix generatePredictions.ts's loadOverallStats
  // already uses for the same reason).
  const { data, error } = await supabase
    .from("screening_config")
    .select(
      "score_weight_ensemble_confidence, score_weight_ev, score_weight_consensus, score_weight_data_quality, " +
        "risk_tier_elite_min, risk_tier_strong_min, risk_tier_medium_min, risk_tier_high_risk_min"
    )
    .eq("key", "default")
    .maybeSingle<ScreeningConfigRow>();
  if (error) throw new Error(`Failed to load screening_config: ${error.message}`);
  if (!data) return { ...DEFAULT_SCREENING_CONFIG, isDefault: true };
  return {
    scoreWeights: {
      ensembleConfidence: data.score_weight_ensemble_confidence as number,
      ev: data.score_weight_ev as number,
      consensus: data.score_weight_consensus as number,
      dataQuality: data.score_weight_data_quality as number
    },
    riskThresholds: {
      eliteMin: data.risk_tier_elite_min as number,
      strongMin: data.risk_tier_strong_min as number,
      mediumMin: data.risk_tier_medium_min as number,
      highRiskMin: data.risk_tier_high_risk_min as number
    },
    isDefault: false
  };
}

export type ScreeningConfigInput = Omit<ScreeningConfig, "isDefault">;

export async function upsertScreeningConfig(supabase: SupabaseClient, config: ScreeningConfigInput, updatedBy: string): Promise<void> {
  const { error } = await supabase.from("screening_config").upsert(
    {
      key: "default",
      score_weight_ensemble_confidence: config.scoreWeights.ensembleConfidence,
      score_weight_ev: config.scoreWeights.ev,
      score_weight_consensus: config.scoreWeights.consensus,
      score_weight_data_quality: config.scoreWeights.dataQuality,
      risk_tier_elite_min: config.riskThresholds.eliteMin,
      risk_tier_strong_min: config.riskThresholds.strongMin,
      risk_tier_medium_min: config.riskThresholds.mediumMin,
      risk_tier_high_risk_min: config.riskThresholds.highRiskMin,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy
    },
    { onConflict: "key" }
  );
  if (error) throw new Error(`Failed to upsert screening_config: ${error.message}`);
}

export interface AccumulatorTarget {
  legs: number;
  minSelectionScore: number;
  enabled: boolean;
}

// Matches migration 0011's seeded rows — used only as a fallback if the
// table is somehow empty (unseeded FakeSupabase test), same reasoning as
// the other DEFAULT_* constants above.
const DEFAULT_ACCUMULATOR_TARGETS: AccumulatorTarget[] = [
  { legs: 5, minSelectionScore: 60, enabled: true },
  { legs: 7, minSelectionScore: 65, enabled: true },
  { legs: 10, minSelectionScore: 70, enabled: true },
  { legs: 15, minSelectionScore: 75, enabled: true },
  { legs: 20, minSelectionScore: 80, enabled: true }
];

export async function getAccumulatorTargets(supabase: SupabaseClient): Promise<AccumulatorTarget[]> {
  const { data, error } = await supabase.from("accumulator_targets").select("legs, min_selection_score, enabled").order("legs", { ascending: true });
  if (error) throw new Error(`Failed to load accumulator_targets: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return DEFAULT_ACCUMULATOR_TARGETS;
  return rows.map((r) => ({ legs: r.legs as number, minSelectionScore: r.min_selection_score as number, enabled: r.enabled as boolean }));
}

export async function upsertAccumulatorTarget(
  supabase: SupabaseClient,
  legs: number,
  minSelectionScore: number,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  const { error } = await supabase.from("accumulator_targets").upsert(
    { legs, min_selection_score: minSelectionScore, enabled, updated_at: new Date().toISOString(), updated_by: updatedBy },
    { onConflict: "legs" }
  );
  if (error) throw new Error(`Failed to upsert accumulator_targets: ${error.message}`);
}

export interface CompetitionAllowlistEntry {
  competitionId: string;
  enabled: boolean;
}

export async function getCompetitionAllowlist(supabase: SupabaseClient): Promise<CompetitionAllowlistEntry[]> {
  const { data, error } = await supabase.from("competition_allowlist").select("competition_id, enabled");
  if (error) throw new Error(`Failed to load competition_allowlist: ${error.message}`);
  return (data ?? []).map((r) => ({ competitionId: r.competition_id as string, enabled: r.enabled as boolean }));
}

export async function setCompetitionAllowlistEntry(
  supabase: SupabaseClient,
  competitionId: string,
  enabled: boolean,
  addedBy: string
): Promise<void> {
  const { error } = await supabase
    .from("competition_allowlist")
    .upsert({ competition_id: competitionId, enabled, added_by: addedBy }, { onConflict: "competition_id" });
  if (error) throw new Error(`Failed to upsert competition_allowlist: ${error.message}`);
}

// The read path the screening/ensemble engine (screeningService.ts,
// generateEnsemblePredictions.ts) goes through — returns the set of
// enabled competition ids, or null when NOTHING is allowlisted yet. null
// (not an empty Set) is the signal callers must treat as "no eligible
// fixtures at all", never as "allow everything unfiltered" — see migration
// 0010's header comment for why an empty table can't default to
// permissive.
export async function getEnabledCompetitionIds(supabase: SupabaseClient): Promise<Set<string> | null> {
  const entries = await getCompetitionAllowlist(supabase);
  const enabled = entries.filter((e) => e.enabled).map((e) => e.competitionId);
  return enabled.length > 0 ? new Set(enabled) : null;
}
