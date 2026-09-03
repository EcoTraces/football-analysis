import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { getAccumulatorTargets, getScreeningConfig, type AccumulatorTarget } from "../services/adminConfigService.js";

export interface AccumulatorCandidate {
  ensemblePredictionId: string;
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  market: string;
  selection: string;
  selectionScore: number;
  probability: number;
  decimalOdds: number;
}

export interface SelectedAccumulator {
  legs: AccumulatorCandidate[];
  combinedProbability: number;
  combinedDecimalOdds: number;
  correlationPenalty: number;
  compositeScore: number;
}

// Approximate leg-count bands per target, matching the user's own spec
// (section 20) verbatim — never padded with a weak leg just to fill the
// range, and never exceeded just to chase a higher payout.
const LEG_RANGE_BY_TARGET: Record<number, { min: number; max: number }> = {
  5: { min: 4, max: 6 },
  7: { min: 5, max: 7 },
  10: { min: 6, max: 9 },
  15: { min: 8, max: 12 },
  20: { min: 8, max: 15 }
};

// Fixed, documented placeholder — how much each shared-team leg pair
// discounts the accumulator's composite score, same "plausible, not
// fitted" honesty as this platform's other unbacktested constants
// (poisson.py's RHO, elo.py's HOME_ADVANTAGE).
const TEAM_OVERLAP_PENALTY = 0.08;

// Pure, directly-unit-testable selection algorithm: greedily takes the
// highest-selection_score candidates (one per fixture — the caller only
// ever passes one candidate per fixture, its own best eligible selection),
// stopping once the target's odds band is reached or its leg-count max is
// hit. Returns null when there aren't even the target's minimum number of
// qualifying legs — never manufactures a weak leg to hit a count.
export function selectAccumulatorLegs(
  candidates: AccumulatorCandidate[],
  targetLegs: number,
  minSelectionScore: number
): SelectedAccumulator | null {
  const range = LEG_RANGE_BY_TARGET[targetLegs] ?? { min: Math.max(2, targetLegs - 2), max: targetLegs + 5 };
  const eligible = [...candidates].filter((c) => c.selectionScore >= minSelectionScore).sort((a, b) => b.selectionScore - a.selectionScore);

  if (eligible.length < range.min) return null;

  const picked: AccumulatorCandidate[] = [];
  const usedFixtureIds = new Set<string>();
  const usedTeamIds = new Set<string>();
  let correlatedPairs = 0;

  for (const candidate of eligible) {
    if (picked.length >= range.max) break;
    // Defensive, not just documented: never two legs from the same match,
    // even if the caller's pool somehow wasn't already one-per-fixture.
    if (usedFixtureIds.has(candidate.fixtureId)) continue;

    picked.push(candidate);
    usedFixtureIds.add(candidate.fixtureId);
    if (usedTeamIds.has(candidate.homeTeamId) || usedTeamIds.has(candidate.awayTeamId)) correlatedPairs += 1;
    usedTeamIds.add(candidate.homeTeamId);
    usedTeamIds.add(candidate.awayTeamId);

    if (picked.length >= range.min) {
      const combinedOddsSoFar = picked.reduce((acc, c) => acc * c.decimalOdds, 1);
      if (combinedOddsSoFar >= targetLegs) break; // Reached the target's odds band — stop rather than add weaker legs.
    }
  }

  if (picked.length < range.min) return null;

  const combinedProbability = picked.reduce((acc, c) => acc * c.probability, 1);
  const combinedDecimalOdds = picked.reduce((acc, c) => acc * c.decimalOdds, 1);
  const correlationPenalty = Math.min(1, correlatedPairs * TEAM_OVERLAP_PENALTY);
  const averageSelectionScore = picked.reduce((sum, c) => sum + c.selectionScore, 0) / picked.length;
  const compositeScore = Math.max(0, Math.min(100, averageSelectionScore * (1 - correlationPenalty)));

  return { legs: picked, combinedProbability, combinedDecimalOdds, correlationPenalty, compositeScore };
}

// Same risk-tier ladder as ml-service's ensemble.risk_tier(), applied here
// to an accumulator's composite score rather than one selection's score —
// duplicated across languages the same way elo.py's rating math and
// computeEloRatings.ts's applyMatchResult already are, since this is too
// small a piece of logic to justify a network round trip.
export function riskTierForScore(
  score: number,
  thresholds: { eliteMin: number; strongMin: number; mediumMin: number; highRiskMin: number }
): "elite" | "strong" | "medium" | "high_risk" | "avoid" {
  if (score >= thresholds.eliteMin) return "elite";
  if (score >= thresholds.strongMin) return "strong";
  if (score >= thresholds.mediumMin) return "medium";
  if (score >= thresholds.highRiskMin) return "high_risk";
  return "avoid";
}

interface FixtureTeamsRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
}

// One candidate per fixture (its own single highest-selection_score
// eligible row) — a real bookmaker price is required (accumulators are
// fundamentally a combined-odds concept; a leg with no known price can't
// contribute to that math), and "avoid"-tier selections are never
// eligible. Given this platform's currently thin odds coverage (1x2 only,
// synced within a ~24h window), this pool is often small or empty — that
// is a real, expected state, not a bug.
export async function loadAccumulatorCandidatePool(supabase: SupabaseClient): Promise<AccumulatorCandidate[]> {
  const { data, error } = await supabase
    .from("ensemble_predictions")
    .select("id, fixture_id, market, selection, combined_probability, selection_score, risk_tier, best_odds")
    .is("superseded_at", null);
  if (error) throw new Error(`Failed to load ensemble_predictions: ${error.message}`);

  const rows = (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: row.id as string,
      fixture_id: row.fixture_id as string,
      market: row.market as string,
      selection: row.selection as string,
      combined_probability: row.combined_probability as number,
      selection_score: row.selection_score as number,
      risk_tier: row.risk_tier as string,
      best_odds: row.best_odds as number | null
    };
  });

  const withOdds = rows.filter((r) => r.best_odds !== null && r.risk_tier !== "avoid");
  if (withOdds.length === 0) return [];

  const fixtureIds = [...new Set(withOdds.map((r) => r.fixture_id))];
  const { data: fixtures, error: fixturesError } = await supabase.from("fixtures").select("id, home_team_id, away_team_id").in("id", fixtureIds);
  if (fixturesError) throw new Error(`Failed to load fixtures: ${fixturesError.message}`);
  const fixtureById = new Map(((fixtures ?? []) as FixtureTeamsRow[]).map((f) => [f.id, f]));

  const bestPerFixture = new Map<string, (typeof withOdds)[number]>();
  for (const row of withOdds) {
    const existing = bestPerFixture.get(row.fixture_id);
    if (!existing || row.selection_score > existing.selection_score) bestPerFixture.set(row.fixture_id, row);
  }

  const candidates: AccumulatorCandidate[] = [];
  for (const row of bestPerFixture.values()) {
    const fixture = fixtureById.get(row.fixture_id);
    if (!fixture) continue;
    candidates.push({
      ensemblePredictionId: row.id,
      fixtureId: row.fixture_id,
      homeTeamId: fixture.home_team_id,
      awayTeamId: fixture.away_team_id,
      market: row.market,
      selection: row.selection,
      selectionScore: row.selection_score,
      probability: row.combined_probability,
      decimalOdds: row.best_odds as number
    });
  }
  return candidates;
}

export interface BuildAccumulatorsResult {
  runId: string;
  targetsBuilt: number;
  targetsSkipped: number;
}

// Supersedes every prior current accumulator_recommendations row before
// writing new ones — same versioning pattern as predictions/
// ensemble_predictions. A target with too few qualifying legs simply gets
// no row at all (never a forced weak accumulator); if NOTHING qualifies,
// this writes nothing and logs why, matching the platform's own
// "NO HIGH-CONFIDENCE ACCUMULATOR TODAY" rule.
export async function buildAccumulatorRecommendations(supabase: SupabaseClient, logger: Logger): Promise<BuildAccumulatorsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "build_accumulators", provider: "database", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  try {
    const [targets, candidatePool, screeningConfig] = await Promise.all([
      getAccumulatorTargets(supabase),
      loadAccumulatorCandidatePool(supabase),
      getScreeningConfig(supabase)
    ]);

    const enabledTargets = targets.filter((t: AccumulatorTarget) => t.enabled);
    const built: { target: AccumulatorTarget; selected: SelectedAccumulator }[] = [];
    for (const target of enabledTargets) {
      const selected = selectAccumulatorLegs(candidatePool, target.legs, target.minSelectionScore);
      if (selected) built.push({ target, selected });
    }

    const generatedAt = new Date().toISOString();
    const { error: supersedeError } = await supabase
      .from("accumulator_recommendations")
      .update({ superseded_at: generatedAt })
      .is("superseded_at", null);
    if (supersedeError) throw new Error(supersedeError.message);

    if (built.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < built.length; i++) {
        if (built[i]!.selected.compositeScore > built[bestIndex]!.selected.compositeScore) bestIndex = i;
      }

      const rows = built.map(({ target, selected }, i) => ({
        target_legs: target.legs,
        leg_fixture_ids: selected.legs.map((l) => l.fixtureId),
        // Fully self-describing snapshot (not just enough to rebuild combined
        // odds) — probability/selectionScore are included too so a reader
        // never needs to re-join against ensemble_predictions, which may
        // have already been superseded by a later run by the time this is read.
        leg_selections: selected.legs.map((l) => ({
          ensemblePredictionId: l.ensemblePredictionId,
          fixtureId: l.fixtureId,
          market: l.market,
          selection: l.selection,
          odds: l.decimalOdds,
          probability: l.probability,
          selectionScore: l.selectionScore
        })),
        combined_probability: selected.combinedProbability,
        combined_decimal_odds: selected.combinedDecimalOdds,
        correlation_penalty: selected.correlationPenalty,
        composite_score: selected.compositeScore,
        risk_tier: riskTierForScore(selected.compositeScore, screeningConfig.riskThresholds),
        is_best_overall: i === bestIndex,
        generated_at: generatedAt
      }));

      const { error: insertError } = await supabase.from("accumulator_recommendations").insert(rows);
      if (insertError) throw new Error(insertError.message);
    } else {
      logger.warn("No accumulator target currently has enough qualifying legs — writing nothing (never a forced/weak accumulator)");
    }

    const status = built.length === 0 ? "partial" : built.length < enabledTargets.length ? "partial" : "succeeded";
    const { error: finishError } = await supabase
      .from("ingestion_runs")
      .update({
        status,
        records_processed: built.length,
        records_rejected: enabledTargets.length - built.length,
        finished_at: new Date().toISOString()
      })
      .eq("id", runId);
    if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

    return { runId, targetsBuilt: built.length, targetsSkipped: enabledTargets.length - built.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Accumulator build failed.";
    await supabase.from("ingestion_runs").update({ status: "failed", error_summary: message, finished_at: new Date().toISOString() }).eq("id", runId);
    throw err;
  }
}
