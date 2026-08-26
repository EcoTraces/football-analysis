import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { PredictionClient } from "../services/predictionClient.js";

const LEAGUE_AVG_HOME_GOALS = 1.5; // conservative cross-league default; see ML_Model.md
const LEAGUE_AVG_AWAY_GOALS = 1.1;
const MIN_MATCHES_FOR_PREDICTION = 3;

interface TeamStatsRow {
  matches_played: number;
  goals_scored: number | null;
  goals_conceded: number | null;
}

async function loadOverallStats(supabase: SupabaseClient, teamId: string, seasonId: string) {
  const { data, error } = await supabase
    .from("team_statistics")
    .select("matches_played, goals_scored, goals_conceded")
    .eq("team_id", teamId)
    .eq("season_id", seasonId)
    .eq("scope", "overall")
    .maybeSingle<TeamStatsRow>();
  if (error) throw new Error(`Failed to load team_statistics: ${error.message}`);
  return data;
}

// Idempotent by design: recomputing simply supersedes the previous current
// row per (fixture, market) rather than appending duplicates, so re-running
// this job on a cron does not corrupt prediction history.
export async function generatePredictionsForUpcomingFixtures(
  supabase: SupabaseClient,
  predictionClient: PredictionClient,
  modelVersionId: string,
  logger: Logger,
  windowHours = 72
): Promise<{ processed: number; skipped: number; failed: number }> {
  const now = new Date();
  const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("id, season_id, home_team_id, away_team_id")
    .eq("status", "scheduled")
    .eq("is_synthetic", false)
    .gte("kickoff_utc", now.toISOString())
    .lte("kickoff_utc", until.toISOString());

  if (error) throw new Error(`Failed to load fixtures for prediction: ${error.message}`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const fixture of fixtures ?? []) {
    try {
      const [homeStats, awayStats] = await Promise.all([
        loadOverallStats(supabase, fixture.home_team_id as string, fixture.season_id as string),
        loadOverallStats(supabase, fixture.away_team_id as string, fixture.season_id as string)
      ]);

      if (
        !homeStats ||
        !awayStats ||
        homeStats.matches_played < MIN_MATCHES_FOR_PREDICTION ||
        awayStats.matches_played < MIN_MATCHES_FOR_PREDICTION
      ) {
        skipped += 1;
        continue; // Insufficient data — no prediction is written, never a guess.
      }

      const result = await predictionClient.predictPoisson({
        homeTeam: {
          matchesPlayed: homeStats.matches_played,
          goalsScoredAvg: (homeStats.goals_scored ?? 0) / homeStats.matches_played,
          goalsConcededAvg: (homeStats.goals_conceded ?? 0) / homeStats.matches_played
        },
        awayTeam: {
          matchesPlayed: awayStats.matches_played,
          goalsScoredAvg: (awayStats.goals_scored ?? 0) / awayStats.matches_played,
          goalsConcededAvg: (awayStats.goals_conceded ?? 0) / awayStats.matches_played
        },
        leagueAvgHomeGoals: LEAGUE_AVG_HOME_GOALS,
        leagueAvgAwayGoals: LEAGUE_AVG_AWAY_GOALS
      });

      if (!result) {
        failed += 1;
        logger.warn({ fixtureId: fixture.id }, "Prediction service unavailable for fixture");
        continue;
      }

      const generatedAt = new Date().toISOString();

      // Supersede prior current predictions for this fixture before writing new ones.
      const { error: supersedeError } = await supabase
        .from("predictions")
        .update({ superseded_at: generatedAt })
        .eq("fixture_id", fixture.id)
        .is("superseded_at", null);
      if (supersedeError) throw new Error(supersedeError.message);

      const rows = result.predictions.map((p) => ({
        fixture_id: fixture.id,
        model_version_id: modelVersionId,
        market: p.market,
        selection: p.selection,
        probability: p.probability,
        confidence: confidenceFor(homeStats.matches_played, awayStats.matches_played, result.dataQuality),
        data_quality: result.dataQuality,
        risk_classification: riskFor(p.probability),
        factors: p.factors,
        generated_at: generatedAt
      }));

      const { error: insertError } = await supabase.from("predictions").insert(rows);
      if (insertError) throw new Error(insertError.message);

      processed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, fixtureId: fixture.id }, "Failed to generate prediction for fixture");
    }
  }

  return { processed, skipped, failed };
}

export interface RunLatestPoissonPredictionsResult {
  modelVersionId: string | null;
  processed: number;
  skipped: number;
  failed: number;
}

// Shared by the admin `/admin/predictions/run` route and the scheduler
// (scheduler/scheduler.ts) so the "which model version to run" lookup lives
// in one place. `modelVersionId: null` means no poisson-baseline
// model_version row exists yet — the caller decides how to surface that
// (a 409 for the HTTP route, a log warning for the scheduler), not this
// function throwing or guessing at a model version.
export async function runLatestPoissonPredictionsJob(
  supabase: SupabaseClient,
  mlServiceUrl: string,
  logger: Logger,
  windowHours = 72
): Promise<RunLatestPoissonPredictionsResult> {
  const { data: modelVersion, error } = await supabase
    .from("model_versions")
    .select("id")
    .eq("name", "poisson-baseline")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to load poisson-baseline model_version: ${error.message}`);
  if (!modelVersion) {
    return { modelVersionId: null, processed: 0, skipped: 0, failed: 0 };
  }

  const client = new PredictionClient(mlServiceUrl);
  const result = await generatePredictionsForUpcomingFixtures(
    supabase,
    client,
    modelVersion.id as string,
    logger,
    windowHours
  );
  return { modelVersionId: modelVersion.id as string, ...result };
}

// Confidence is deliberately NOT a function of probability alone (spec
// section 26) — it reflects how much data backed the estimate.
function confidenceFor(homeMatches: number, awayMatches: number, dataQuality: string): "low" | "medium" | "high" {
  const minMatches = Math.min(homeMatches, awayMatches);
  if (dataQuality === "strong" && minMatches >= 10) return "high";
  if (dataQuality === "insufficient" || minMatches < 5) return "low";
  return "medium";
}

function riskFor(probability: number): "low" | "moderate" | "high" {
  if (probability >= 0.65) return "low";
  if (probability >= 0.45) return "moderate";
  return "high";
}
