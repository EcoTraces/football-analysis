import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { ApiError } from "../middleware/errorHandler.js";
import { PredictionClient, type DixonColesRhoFitRow } from "../services/predictionClient.js";
import { computePointInTimeStrength } from "./runBacktest.js";
import { MIN_MATCHES_FOR_PREDICTION } from "./generatePredictions.js";
import { LEAGUE_AVG_AWAY_GOALS, LEAGUE_AVG_HOME_GOALS } from "./calibrateLeagues.js";

export interface FitDixonColesRhoOptions {
  from: string; // ISO timestamp — inclusive lower bound on kickoff_utc
  to: string; // ISO timestamp — inclusive upper bound on kickoff_utc
  competitionId?: string;
}

interface RhoFittingFixtureRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
  home_score: number;
  away_score: number;
}

// Builds one point-in-time row per qualifying fixture — identical
// walk-forward computation to runBacktest.ts/trainGradientBoosting.ts,
// reused here for the same reason: fitting rho on a team's full-season
// aggregate would leak knowledge of matches that hadn't happened yet at a
// given fixture's own kickoff into the fit (the same lookahead-bias
// concern that motivated backtesting in the first place). Each row carries
// the actual final score, not just the result — rho fitting is sensitive
// to the exact scoreline (see rho_fitting.py), unlike gradient boosting's
// win/draw/loss outcome label.
export async function buildRhoFittingRows(
  supabase: SupabaseClient,
  logger: Logger,
  options: FitDixonColesRhoOptions
): Promise<{ rows: DixonColesRhoFitRow[]; skipped: number }> {
  let query = supabase
    .from("fixtures")
    .select("id, home_team_id, away_team_id, kickoff_utc, home_score, away_score")
    .eq("status", "finished")
    .eq("is_synthetic", false)
    .gte("kickoff_utc", options.from)
    .lte("kickoff_utc", options.to);
  if (options.competitionId) query = query.eq("competition_id", options.competitionId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load fixtures for rho fitting: ${error.message}`);
  const fixtures = (data ?? []) as RhoFittingFixtureRow[];

  const rows: DixonColesRhoFitRow[] = [];
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
        skipped += 1; // Same "no data, no market" threshold live predictions, backtesting, and gradient-boosting training all use.
        continue;
      }

      rows.push({
        homeTeam: homeStrength,
        awayTeam: awayStrength,
        actualHomeGoals: fixture.home_score,
        actualAwayGoals: fixture.away_score
      });
    } catch (err) {
      skipped += 1;
      logger.error({ err, fixtureId: fixture.id }, "Failed to build a rho-fitting row for fixture");
    }
  }

  return { rows, skipped };
}

export interface RunLatestDixonColesRhoFitResult {
  runId: string | null;
  modelVersionId: string | null;
  sampleSize: number;
  skipped: number;
  informativeMatches: number | null;
  fittedRho: number | null;
  logLikelihoodAtFittedRho: number | null;
  logLikelihoodAtDefaultRho: number | null;
  defaultRho: number | null;
}

// Mirrors runLatestGradientBoostingTrainingJob's structure, but updates
// the EXISTING poisson-baseline model_versions row rather than a separate
// model's row — fitting rho refines that same model, it doesn't create a
// new one. Like training/backtesting, never wired into the scheduler —
// this is an occasional, admin-triggered action over a chosen date range.
export async function runLatestDixonColesRhoFitJob(
  supabase: SupabaseClient,
  mlServiceUrl: string,
  logger: Logger,
  options: FitDixonColesRhoOptions
): Promise<RunLatestDixonColesRhoFitResult> {
  const { data: modelVersion, error } = await supabase
    .from("model_versions")
    .select("id")
    .eq("name", "poisson-baseline")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load poisson-baseline model_version: ${error.message}`);
  if (!modelVersion) {
    return {
      runId: null,
      modelVersionId: null,
      sampleSize: 0,
      skipped: 0,
      informativeMatches: null,
      fittedRho: null,
      logLikelihoodAtFittedRho: null,
      logLikelihoodAtDefaultRho: null,
      defaultRho: null
    };
  }
  const modelVersionId = modelVersion.id as string;

  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "fit:dixon-coles-rho", provider: "ml-service", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const { rows, skipped } = await buildRhoFittingRows(supabase, logger, options);

  const client = new PredictionClient(mlServiceUrl);
  let fitResult;
  try {
    fitResult = await client.fitDixonColesRho({
      leagueAvgHomeGoals: LEAGUE_AVG_HOME_GOALS,
      leagueAvgAwayGoals: LEAGUE_AVG_AWAY_GOALS,
      rows
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dixon-Coles rho fit failed.";
    await supabase
      .from("ingestion_runs")
      .update({ status: "failed", records_processed: 0, records_rejected: rows.length, error_summary: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    // 422, not 500: too few matches at the four rho-sensitive scorelines
    // in this date range is a legitimate, actionable response to the
    // admin's chosen window, not a server malfunction.
    throw new ApiError(422, message, "rho_fit_failed");
  }

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status: "succeeded",
      records_processed: fitResult.sampleSize,
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
      notes: `Dixon-Coles rho fit: fittedRho=${fitResult.fittedRho.toFixed(4)} (was ${fitResult.defaultRho}), ` +
        `sampleSize=${fitResult.sampleSize}, informativeMatches=${fitResult.informativeMatches}, ` +
        `logLikelihood ${fitResult.logLikelihoodAtFittedRho.toFixed(2)} vs ${fitResult.logLikelihoodAtDefaultRho.toFixed(2)} at the old default.`
    })
    .eq("id", modelVersionId);
  if (modelUpdateError) logger.error({ err: modelUpdateError, modelVersionId }, "Failed to update model_versions row after rho fit");

  return {
    runId,
    modelVersionId,
    sampleSize: fitResult.sampleSize,
    skipped,
    informativeMatches: fitResult.informativeMatches,
    fittedRho: fitResult.fittedRho,
    logLikelihoodAtFittedRho: fitResult.logLikelihoodAtFittedRho,
    logLikelihoodAtDefaultRho: fitResult.logLikelihoodAtDefaultRho,
    defaultRho: fitResult.defaultRho
  };
}
