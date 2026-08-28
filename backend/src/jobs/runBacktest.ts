import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { PredictionClient } from "../services/predictionClient.js";
import { LEAGUE_AVG_AWAY_GOALS, LEAGUE_AVG_HOME_GOALS, MIN_MATCHES_FOR_PREDICTION } from "./generatePredictions.js";

export interface PointInTimeStrength {
  matchesPlayed: number;
  goalsScoredAvg: number;
  goalsConcededAvg: number;
}

interface FixtureHistoryRow {
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
}

// The genuine walk-forward computation this pipeline exists for: team
// strength as it actually stood strictly *before* `beforeKickoffUtc`,
// derived directly from fixtures' own finished-match history — never from
// team_statistics, which is a single current snapshot and would leak
// future-season data into a "historical" prediction (lookahead bias).
// Returns null (not zeros) when the team has no finished, non-synthetic
// prior fixture at all, so the caller can skip rather than predict off
// nothing.
export async function computePointInTimeStrength(
  supabase: SupabaseClient,
  teamId: string,
  beforeKickoffUtc: string
): Promise<PointInTimeStrength | null> {
  const { data, error } = await supabase
    .from("fixtures")
    .select("home_team_id, away_team_id, home_score, away_score")
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .eq("status", "finished")
    .eq("is_synthetic", false)
    .lt("kickoff_utc", beforeKickoffUtc);
  if (error) throw new Error(`Failed to load point-in-time fixture history: ${error.message}`);

  const rows = (data ?? []) as FixtureHistoryRow[];
  if (rows.length === 0) return null;

  let scored = 0;
  let conceded = 0;
  for (const row of rows) {
    const isHome = row.home_team_id === teamId;
    scored += isHome ? row.home_score : row.away_score;
    conceded += isHome ? row.away_score : row.home_score;
  }

  return { matchesPlayed: rows.length, goalsScoredAvg: scored / rows.length, goalsConcededAvg: conceded / rows.length };
}

const ONE_X_TWO_OUTCOMES = ["home", "draw", "away"] as const;
type OneXTwoOutcome = (typeof ONE_X_TWO_OUTCOMES)[number];

function actualOutcome(homeScore: number, awayScore: number): OneXTwoOutcome {
  if (homeScore > awayScore) return "home";
  if (homeScore < awayScore) return "away";
  return "draw";
}

export interface BacktestOptions {
  from: string; // ISO timestamp — inclusive lower bound on kickoff_utc
  to: string; // ISO timestamp — inclusive upper bound on kickoff_utc
  competitionId?: string;
}

export interface BacktestResult {
  evaluationId: string | null;
  sampleSize: number;
  skipped: number;
  accuracy: number | null;
  logLoss: number | null;
  brierScore: number | null;
}

interface BacktestFixtureRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
  home_score: number;
  away_score: number;
}

// Walk-forward backtest of the 1x2 market only (the other ~19 markets this
// platform predicts are not yet backtested — see ML_Model.md). For every
// finished, non-synthetic fixture in [from, to], recomputes both teams'
// strength from strictly-prior finished fixtures, asks the *real*
// prediction service for a 1x2 forecast, and scores it against what
// actually happened. Writes exactly one model_evaluations row per run
// (or none, if zero fixtures qualified).
export async function runBacktest(
  supabase: SupabaseClient,
  predictionClient: PredictionClient,
  modelVersionId: string,
  logger: Logger,
  options: BacktestOptions
): Promise<BacktestResult> {
  let query = supabase
    .from("fixtures")
    .select("id, home_team_id, away_team_id, kickoff_utc, home_score, away_score")
    .eq("status", "finished")
    .eq("is_synthetic", false)
    .gte("kickoff_utc", options.from)
    .lte("kickoff_utc", options.to);
  if (options.competitionId) query = query.eq("competition_id", options.competitionId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load fixtures for backtest: ${error.message}`);
  const fixtures = (data ?? []) as BacktestFixtureRow[];

  let sampleSize = 0;
  let skipped = 0;
  let accuracyHits = 0;
  let logLossSum = 0;
  let brierSum = 0;

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
        skipped += 1; // Insufficient point-in-time history — never predicted off too little data, same rule as live predictions.
        continue;
      }

      const result = await predictionClient.predictPoisson({
        homeTeam: homeStrength,
        awayTeam: awayStrength,
        leagueAvgHomeGoals: LEAGUE_AVG_HOME_GOALS,
        leagueAvgAwayGoals: LEAGUE_AVG_AWAY_GOALS
      });

      if (!result) {
        skipped += 1;
        logger.warn({ fixtureId: fixture.id }, "Prediction service unavailable during backtest");
        continue;
      }

      const oneXTwo = result.predictions.filter((p) => p.market === "1x2");
      if (oneXTwo.length !== ONE_X_TWO_OUTCOMES.length) {
        skipped += 1;
        logger.warn({ fixtureId: fixture.id }, "1x2 market missing or incomplete in backtest prediction");
        continue;
      }

      const probByOutcome = new Map(oneXTwo.map((p) => [p.selection, p.probability]));
      const actual = actualOutcome(fixture.home_score, fixture.away_score);
      const argmax = oneXTwo.reduce((best, p) => (p.probability > best.probability ? p : best));

      sampleSize += 1;
      if (argmax.selection === actual) accuracyHits += 1;

      // Clamp away from exactly 0 so one zero-probability forecast for the
      // outcome that actually happened doesn't blow log loss to infinity
      // and corrupt the run's aggregate average.
      const predictedProbForActual = probByOutcome.get(actual) ?? 0;
      logLossSum += -Math.log(Math.max(predictedProbForActual, 1e-10));

      for (const outcome of ONE_X_TWO_OUTCOMES) {
        const forecast = probByOutcome.get(outcome) ?? 0;
        const indicator = outcome === actual ? 1 : 0;
        brierSum += (forecast - indicator) ** 2;
      }
    } catch (err) {
      skipped += 1;
      logger.error({ err, fixtureId: fixture.id }, "Failed to backtest fixture");
    }
  }

  if (sampleSize === 0) {
    return { evaluationId: null, sampleSize: 0, skipped, accuracy: null, logLoss: null, brierScore: null };
  }

  const accuracy = accuracyHits / sampleSize;
  const logLoss = logLossSum / sampleSize;
  const brierScore = brierSum / sampleSize; // multi-class Brier: sum over classes per sample, averaged over samples.

  const { data: row, error: insertError } = await supabase
    .from("model_evaluations")
    .insert({
      model_version_id: modelVersionId,
      competition_id: options.competitionId ?? null,
      market: "1x2",
      evaluation_window: `${options.from}..${options.to}`,
      accuracy,
      log_loss: logLoss,
      brier_score: brierScore,
      sample_size: sampleSize
    })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to write model_evaluations row: ${insertError.message}`);

  return { evaluationId: row.id as string, sampleSize, skipped, accuracy, logLoss, brierScore };
}

export interface RunLatestBacktestResult {
  runId: string | null;
  modelVersionId: string | null;
  evaluationId: string | null;
  sampleSize: number;
  skipped: number;
  accuracy: number | null;
  logLoss: number | null;
  brierScore: number | null;
}

// Mirrors runLatestPoissonPredictionsJob's ingestion_runs bookkeeping so
// backtest runs show up in the same admin job-history view as every sync
// job — but is never wired into the scheduler (scheduler.ts): backtesting
// is an occasional evaluation an admin chooses to run over a chosen date
// range, not ongoing ingestion.
export async function runLatestBacktestJob(
  supabase: SupabaseClient,
  mlServiceUrl: string,
  logger: Logger,
  options: BacktestOptions
): Promise<RunLatestBacktestResult> {
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
      evaluationId: null,
      sampleSize: 0,
      skipped: 0,
      accuracy: null,
      logLoss: null,
      brierScore: null
    };
  }

  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "backtest", provider: "ml-service", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const client = new PredictionClient(mlServiceUrl);
  const result = await runBacktest(supabase, client, modelVersion.id as string, logger, options);

  const status = result.sampleSize === 0 ? "failed" : result.skipped > 0 ? "partial" : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: result.sampleSize,
      records_rejected: result.skipped,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, modelVersionId: modelVersion.id as string, ...result };
}
