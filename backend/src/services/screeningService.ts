import type { SupabaseClient } from "@supabase/supabase-js";
import { getTeamNamesById } from "./teamsService.js";

interface EnsemblePredictionRow {
  id: string;
  fixture_id: string;
  market: string;
  selection: string;
  combined_probability: number;
  consensus_level: string;
  selection_score: number;
  risk_tier: string;
  ev: number | null;
  edge_pct: number | null;
  best_odds: number | null;
  best_bookmaker: string | null;
  data_quality: string;
  missing_components: string[];
  factors: unknown[];
  generated_at: string;
}

export interface ScreeningRow {
  id: string;
  fixtureId: string;
  market: string;
  selection: string;
  combinedProbability: number;
  consensusLevel: string;
  selectionScore: number;
  riskTier: string;
  ev: number | null;
  edgePct: number | null;
  bestOdds: number | null;
  bestBookmaker: string | null;
  dataQuality: string;
  missingComponents: string[];
  factors: unknown[];
  generatedAt: string;
  competitionName: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  kickoffUtc: string;
}

interface FixtureInfoRow {
  id: string;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
}

// Shared by getTop20/getMatchesToAvoid — same "fetch raw, join in JS via
// Maps" style as fixturesService.ts, reusing its getTeamNamesById rather
// than a bespoke join.
async function enrichWithFixtureInfo(supabase: SupabaseClient, rows: EnsemblePredictionRow[]): Promise<ScreeningRow[]> {
  if (rows.length === 0) return [];

  const fixtureIds = [...new Set(rows.map((r) => r.fixture_id))];
  const { data: fixtures, error: fixturesError } = await supabase
    .from("fixtures")
    .select("id, competition_id, home_team_id, away_team_id, kickoff_utc")
    .in("id", fixtureIds);
  if (fixturesError) throw new Error(`Failed to load fixtures: ${fixturesError.message}`);

  const fixtureById = new Map(((fixtures ?? []) as FixtureInfoRow[]).map((f) => [f.id, f]));

  const teamIds = [...fixtureById.values()].flatMap((f) => [f.home_team_id, f.away_team_id]);
  const competitionIds = [...new Set([...fixtureById.values()].map((f) => f.competition_id))];

  const [teamNamesById, competitionsRes] = await Promise.all([
    getTeamNamesById(supabase, teamIds),
    supabase.from("competitions").select("id, name").in("id", competitionIds)
  ]);
  if (competitionsRes.error) throw new Error(`Failed to load competitions: ${competitionsRes.error.message}`);
  const competitionNameById = new Map((competitionsRes.data ?? []).map((c) => [c.id as string, c.name as string]));

  return rows.map((row) => {
    const fixture = fixtureById.get(row.fixture_id);
    return {
      id: row.id,
      fixtureId: row.fixture_id,
      market: row.market,
      selection: row.selection,
      combinedProbability: row.combined_probability,
      consensusLevel: row.consensus_level,
      selectionScore: row.selection_score,
      riskTier: row.risk_tier,
      ev: row.ev,
      edgePct: row.edge_pct,
      bestOdds: row.best_odds,
      bestBookmaker: row.best_bookmaker,
      dataQuality: row.data_quality,
      missingComponents: row.missing_components,
      factors: row.factors,
      generatedAt: row.generated_at,
      competitionName: fixture ? (competitionNameById.get(fixture.competition_id) ?? null) : null,
      homeTeamName: fixture ? (teamNamesById.get(fixture.home_team_id) ?? null) : null,
      awayTeamName: fixture ? (teamNamesById.get(fixture.away_team_id) ?? null) : null,
      kickoffUtc: fixture?.kickoff_utc ?? ""
    };
  });
}

async function getCurrentEnsemblePredictions(supabase: SupabaseClient): Promise<EnsemblePredictionRow[]> {
  const { data, error } = await supabase
    .from("ensemble_predictions")
    .select(
      "id, fixture_id, market, selection, combined_probability, consensus_level, selection_score, risk_tier, " +
        "ev, edge_pct, best_odds, best_bookmaker, data_quality, missing_components, factors, generated_at"
    )
    .is("superseded_at", null);
  if (error) throw new Error(`Failed to load ensemble_predictions: ${error.message}`);
  // This select string has enough columns that supabase-js's own
  // type inference gives up entirely (each row infers as GenericStringError,
  // not just the array — a step further than adminConfigService.ts's
  // getScreeningConfig/predictionsService.ts's getCurrentPredictions hit),
  // so each row is cast through `unknown` first (TS's own suggested fix)
  // before picking fields off it.
  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: row.id as string,
      fixture_id: row.fixture_id as string,
      market: row.market as string,
      selection: row.selection as string,
      combined_probability: row.combined_probability as number,
      consensus_level: row.consensus_level as string,
      selection_score: row.selection_score as number,
      risk_tier: row.risk_tier as string,
      ev: row.ev as number | null,
      edge_pct: row.edge_pct as number | null,
      best_odds: row.best_odds as number | null,
      best_bookmaker: row.best_bookmaker as string | null,
      data_quality: row.data_quality as string,
      missing_components: (row.missing_components ?? []) as string[],
      factors: (row.factors ?? []) as unknown[],
      generated_at: row.generated_at as string
    };
  });
}

const DEFAULT_TOP_N = 20;

// One entry per fixture — only its single highest-selection_score
// selection, never multiple contradictory picks (home AND away) for the
// same match — ranked across all eligible fixtures, then capped at `limit`.
// "avoid"-tier selections are excluded here entirely; they surface via
// getMatchesToAvoid instead. Screens whatever real fixtures/predictions
// currently exist — never manufactures candidates to reach `limit`.
export async function getTop20(supabase: SupabaseClient, limit = DEFAULT_TOP_N): Promise<ScreeningRow[]> {
  const rows = await getCurrentEnsemblePredictions(supabase);
  const eligible = rows.filter((r) => r.risk_tier !== "avoid");

  const bestPerFixture = new Map<string, EnsemblePredictionRow>();
  for (const row of eligible) {
    const existing = bestPerFixture.get(row.fixture_id);
    if (!existing || row.selection_score > existing.selection_score) bestPerFixture.set(row.fixture_id, row);
  }

  const ranked = [...bestPerFixture.values()].sort((a, b) => b.selection_score - a.selection_score).slice(0, limit);
  return enrichWithFixtureInfo(supabase, ranked);
}

// Matches to avoid: risk_tier "avoid" or "high_risk", OR the model's own
// signals suggest low confidence even at a middling score — conflicting
// consensus or insufficient data. A fixture can appear once per
// disqualifying selection (unlike getTop20, this deliberately does NOT
// collapse to one row per fixture — each flagged selection is its own
// reason to avoid).
export async function getMatchesToAvoid(supabase: SupabaseClient): Promise<ScreeningRow[]> {
  const rows = await getCurrentEnsemblePredictions(supabase);
  const flagged = rows.filter(
    (r) => r.risk_tier === "avoid" || r.risk_tier === "high_risk" || r.consensus_level === "conflicting" || r.data_quality === "insufficient"
  );
  const sorted = flagged.sort((a, b) => a.selection_score - b.selection_score);
  return enrichWithFixtureInfo(supabase, sorted);
}
