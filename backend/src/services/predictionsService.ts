import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyFreshness, type Freshness } from "../lib/freshness.js";

export interface PredictionFactor {
  direction: "positive" | "negative";
  label: string;
}

export interface PredictionView {
  market: string;
  selection: string;
  probability: number;
  confidence: "low" | "medium" | "high";
  dataQuality: "insufficient" | "limited" | "strong";
  riskClassification: "low" | "moderate" | "high" | null;
  factors: PredictionFactor[];
  modelVersionId: string;
  generatedAt: string;
  freshness: Freshness;
}

// Only ever returns the current (non-superseded) prediction per market —
// recalculation writes a fresh row and marks the old one superseded rather
// than mutating history, so "what changed since yesterday" stays answerable.
export async function getCurrentPredictions(
  supabase: SupabaseClient,
  fixtureId: string
): Promise<PredictionView[]> {
  const { data, error } = await supabase
    .from("predictions")
    .select(
      "market, selection, probability, confidence, data_quality, risk_classification, factors, model_version_id, generated_at"
    )
    .eq("fixture_id", fixtureId)
    .is("superseded_at", null)
    .order("market", { ascending: true });

  if (error) throw new Error(`Failed to load predictions: ${error.message}`);

  return (data ?? []).map((row) => ({
    market: row.market as string,
    selection: row.selection as string,
    probability: row.probability as number,
    confidence: row.confidence as PredictionView["confidence"],
    dataQuality: row.data_quality as PredictionView["dataQuality"],
    riskClassification: row.risk_classification as PredictionView["riskClassification"],
    factors: (row.factors ?? []) as PredictionFactor[],
    modelVersionId: row.model_version_id as string,
    generatedAt: row.generated_at as string,
    freshness: classifyFreshness(row.generated_at as string, "predictions")
  }));
}
