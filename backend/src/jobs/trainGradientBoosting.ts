import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { ApiError } from "../middleware/errorHandler.js";
import { PredictionClient, type GradientBoostingTrainingRow, type OneXTwoOutcome } from "../services/predictionClient.js";
import { computePointInTimeStrength } from "./runBacktest.js";
import { MIN_MATCHES_FOR_PREDICTION } from "./generatePredictions.js";

function actualOutcome(homeScore: number, awayScore: number): OneXTwoOutcome {
  if (homeScore > awayScore) return "home";
  if (homeScore < awayScore) return "away";
  return "draw";
}

export interface TrainGradientBoostingOptions {
  from: string; // ISO timestamp — inclusive lower bound on kickoff_utc
  to: string; // ISO timestamp — inclusive upper bound on kickoff_utc
  competitionId?: string;
}

interface TrainingFixtureRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
  home_score: number;
  away_score: number;
}

// Builds one point-in-time training row per qualifying fixture — same
// walk-forward computation runBacktest.ts uses for scoring, reused here for
// training so the model is never fit on a team's full-season aggregate
// (which would leak knowledge of matches that hadn't happened yet at that
// fixture's own kickoff into the training set — the identical lookahead-bias
// concern that motivated the backtesting pipeline in the first place).
export async function buildTrainingRows(
  supabase: SupabaseClient,
  logger: Logger,
  options: TrainGradientBoostingOptions
): Promise<{ rows: GradientBoostingTrainingRow[]; skipped: number }> {
  let query = supabase
    .from("fixtures")
    .select("id, home_team_id, away_team_id, kickoff_utc, home_score, away_score")
    .eq("status", "finished")
    .eq("is_synthetic", false)
    .gte("kickoff_utc", options.from)
    .lte("kickoff_utc", options.to);
  if (options.competitionId) query = query.eq("competition_id", options.competitionId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load fixtures for gradient boosting training: ${error.message}`);
  const fixtures = (data ?? []) as TrainingFixtureRow[];

  const rows: GradientBoostingTrainingRow[] = [];
  let skipped = 0;

  for (const fixture of fixtures) {
    try {
      const [homeStrength, awayStrength] = await Promise.all([
        computePointInTimeStrength(supabase, fixture.home_team_id, fixture.kickoff_utc),
        computePointInTimeStrength(supabase, fixture.away_team_id, fixture.kickoff_utc)
      ]);

      if (
        !homeStrength ||
        !awayStrength ||
        homeStrength.matchesPlayed < MIN_MATCHES_FOR_PREDICTION ||
        awayStrength.matchesPlayed < MIN_MATCHES_FOR_PREDICTION
      ) {
        skipped += 1; // Same "no data, no market" threshold live predictions and backtesting both use.
        continue;
      }

      rows.push({
        homeTeam: homeStrength,
        awayTeam: awayStrength,
        outcome: actualOutcome(fixture.home_score, fixture.away_score)
      });
    } catch (err) {
      skipped += 1;
      logger.error({ err, fixtureId: fixture.id }, "Failed to build a training row for fixture");
    }
  }

  return { rows, skipped };
}

export interface RunLatestGradientBoostingTrainingResult {
  runId: string | null;
  modelVersionId: string | null;
  sampleSize: number;
  skipped: number;
  trainAccuracy: number | null;
  classCounts: Record<string, number> | null;
}

// Mirrors runLatestBacktestJob's ingestion_runs bookkeeping. Like
// backtesting, this is never wired into the scheduler — retraining is an
// occasional, admin-triggered action over a chosen date range, not ongoing
// ingestion. On success, updates the gradient-boosting model_versions row's
// trained_at/training_dataset_version/notes — the same fields
// poisson-baseline's own (manually seeded) row already has, now with a
// real writer for this model.
export async function runLatestGradientBoostingTrainingJob(
  supabase: SupabaseClient,
  mlServiceUrl: string,
  logger: Logger,
  options: TrainGradientBoostingOptions
): Promise<RunLatestGradientBoostingTrainingResult> {
  const { data: modelVersion, error } = await supabase
    .from("model_versions")
    .select("id")
    .eq("name", "gradient-boosting")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load gradient-boosting model_version: ${error.message}`);
  if (!modelVersion) {
    return { runId: null, modelVersionId: null, sampleSize: 0, skipped: 0, trainAccuracy: null, classCounts: null };
  }
  const modelVersionId = modelVersion.id as string;

  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "train:gradient-boosting", provider: "ml-service", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const { rows, skipped } = await buildTrainingRows(supabase, logger, options);

  const client = new PredictionClient(mlServiceUrl);
  let trainResult;
  try {
    trainResult = await client.trainGradientBoosting({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gradient boosting training failed.";
    await supabase
      .from("ingestion_runs")
      .update({ status: "failed", records_processed: 0, records_rejected: rows.length, error_summary: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    // 422, not 500: an untrainable window (too few qualifying fixtures, or
    // one with only a single outcome) is a legitimate, actionable response
    // to the admin's chosen date range, not a server malfunction.
    throw new ApiError(422, message, "training_failed");
  }

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status: "succeeded",
      records_processed: trainResult.sampleSize,
      records_rejected: skipped,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  const { error: modelUpdateError } = await supabase
    .from("model_versions")
    .update({
      trained_at: new Date().toISOString(),
      training_dataset_version: `${options.from}..${options.to}`,
      notes: `sampleSize=${trainResult.sampleSize}, trainAccuracy=${trainResult.trainAccuracy.toFixed(3)} (in-sample, not held-out).`
    })
    .eq("id", modelVersionId);
  if (modelUpdateError) logger.error({ err: modelUpdateError, modelVersionId }, "Failed to update model_versions row after training");

  return {
    runId,
    modelVersionId,
    sampleSize: trainResult.sampleSize,
    skipped,
    trainAccuracy: trainResult.trainAccuracy,
    classCounts: trainResult.classCounts
  };
}
