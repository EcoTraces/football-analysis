import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

// Exported for reuse by runBacktest.ts/trainGradientBoosting.ts/
// fitDixonColesRho.ts, which still use these fixed constants directly
// rather than getLeagueAverages() below — see that function's comment for
// why. Lives here (not generatePredictions.ts, which would create a
// circular import back to this module) since this is now the authoritative
// module for "what are the league-average-goals inputs."
export const LEAGUE_AVG_HOME_GOALS = 1.5; // conservative cross-league default; see ML_Model.md
export const LEAGUE_AVG_AWAY_GOALS = 1.1;

// Below this many real, finished, non-synthetic fixtures, a competition's
// own average is more likely to be noise than a trustworthy calibration —
// the fixed cross-league default is safer below this line. Same order of
// magnitude as this platform's other "is there enough real data yet"
// thresholds (MIN_TRAINING_ROWS, MIN_INFORMATIVE_MATCHES) — not a claim
// this is a statistically rigorous minimum, just a floor below which an
// average is more noise than signal.
export const MIN_FIXTURES_FOR_LEAGUE_CALIBRATION = 20;

interface FixtureGoalsRow {
  competition_id: string;
  home_score: number;
  away_score: number;
}

export interface LeagueAverages {
  leagueAvgHomeGoals: number;
  leagueAvgAwayGoals: number;
  // false = these are the fixed, cross-league default constants
  // (generatePredictions.ts), not a real per-competition value — either
  // this competition has never been calibrated, or it doesn't have
  // MIN_FIXTURES_FOR_LEAGUE_CALIBRATION real fixtures yet.
  calibrated: boolean;
  sampleSize: number | null;
}

// The read path every live-prediction caller should go through instead of
// reading the fixed LEAGUE_AVG_HOME_GOALS/AWAY_GOALS constants directly —
// see generatePredictions.ts. Deliberately NOT yet used by
// runBacktest.ts/trainGradientBoosting.ts/fitDixonColesRho.ts: those do a
// genuine walk-forward, point-in-time computation for team strength (see
// computePointInTimeStrength), and reading the *current* league_calibration
// row for a historical fixture would reintroduce a lookahead-bias risk of
// exactly the kind that motivated that point-in-time computation in the
// first place — a league's scoring rate can drift era to era, so "the
// league average as of today" isn't quite "the league average as it stood
// at that historical fixture's kickoff." The effect is far smaller than
// team-specific lookahead bias (an average across an entire competition's
// many teams drifts far more slowly than one team's form), but it's a real
// gap, not a silent one — a genuinely point-in-time per-competition average
// is a documented, unimplemented follow-up (see ML_Model.md).
export async function getLeagueAverages(supabase: SupabaseClient, competitionId: string): Promise<LeagueAverages> {
  const { data, error } = await supabase
    .from("league_calibration")
    .select("league_avg_home_goals, league_avg_away_goals, sample_size")
    .eq("competition_id", competitionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load league_calibration: ${error.message}`);

  if (!data) {
    return { leagueAvgHomeGoals: LEAGUE_AVG_HOME_GOALS, leagueAvgAwayGoals: LEAGUE_AVG_AWAY_GOALS, calibrated: false, sampleSize: null };
  }
  return {
    leagueAvgHomeGoals: data.league_avg_home_goals as number,
    leagueAvgAwayGoals: data.league_avg_away_goals as number,
    calibrated: true,
    sampleSize: data.sample_size as number
  };
}

export interface RunLeagueCalibrationResult {
  runId: string;
  competitionsCalibrated: number;
  competitionsSkipped: number;
}

// Recomputes every competition's calibration in one pass: fetches every
// real, finished, non-synthetic fixture's (competition_id, home_score,
// away_score) and groups by competition_id in application code — the same
// "fetch raw rows, aggregate in JS" style computePointInTimeStrength
// (runBacktest.ts) and refreshTeamCornersAverage (syncFixtureStatistics.ts)
// already use, not a database-side GROUP BY/AVG (this repo's FakeSupabase
// test double has no aggregation support — see testSupabaseFake.ts).
//
// Unlike backtesting/training/rho-fitting, this reads only from the
// database (no ml-service call, no admin-chosen date range — always the
// competition's full real fixture history) and is cheap enough to run on
// the scheduler like a regular sync job, not gated behind an admin's
// explicit trigger — see scheduler.ts.
export async function runLeagueCalibration(supabase: SupabaseClient, logger: Logger): Promise<RunLeagueCalibrationResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "calibrate_leagues", provider: "database", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  try {
    const { data, error } = await supabase
      .from("fixtures")
      .select("competition_id, home_score, away_score")
      .eq("status", "finished")
      .eq("is_synthetic", false);
    if (error) throw new Error(`Failed to load fixtures for league calibration: ${error.message}`);

    const byCompetition = new Map<string, { homeSum: number; awaySum: number; count: number }>();
    for (const row of (data ?? []) as FixtureGoalsRow[]) {
      const bucket = byCompetition.get(row.competition_id) ?? { homeSum: 0, awaySum: 0, count: 0 };
      bucket.homeSum += row.home_score;
      bucket.awaySum += row.away_score;
      bucket.count += 1;
      byCompetition.set(row.competition_id, bucket);
    }

    let competitionsCalibrated = 0;
    let competitionsSkipped = 0;

    for (const [competitionId, bucket] of byCompetition) {
      if (bucket.count < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION) {
        competitionsSkipped += 1;
        continue;
      }

      const { error: upsertError } = await supabase.from("league_calibration").upsert(
        {
          competition_id: competitionId,
          league_avg_home_goals: bucket.homeSum / bucket.count,
          league_avg_away_goals: bucket.awaySum / bucket.count,
          sample_size: bucket.count,
          computed_at: new Date().toISOString()
        },
        { onConflict: "competition_id" }
      );
      if (upsertError) throw new Error(`Failed to upsert league_calibration for competition ${competitionId}: ${upsertError.message}`);
      competitionsCalibrated += 1;
    }

    const { error: finishError } = await supabase
      .from("ingestion_runs")
      .update({
        status: "succeeded",
        records_processed: competitionsCalibrated,
        records_rejected: competitionsSkipped,
        finished_at: new Date().toISOString()
      })
      .eq("id", runId);
    if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

    return { runId, competitionsCalibrated, competitionsSkipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : "League calibration failed.";
    await supabase
      .from("ingestion_runs")
      .update({ status: "failed", error_summary: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    throw err;
  }
}

// The read path every live-prediction caller should go through for a
// fixture's competition-specific fitted rho — see fitDixonColesRho.ts for
// how competition_rho rows get written (runLatestDixonColesRhoFitJob, when
// called with a competitionId). Lives here rather than in
// fitDixonColesRho.ts itself for the same reason getLeagueAverages does:
// generatePredictions.ts needs to import it, and fitDixonColesRho.ts
// already imports FROM generatePredictions.ts (MIN_MATCHES_FOR_PREDICTION),
// so the reverse import would be circular. undefined (not the fixed
// default) means no competition-scoped fit exists yet — the caller should
// simply omit `rho` from the /predict/poisson payload rather than resolve
// a fallback itself; ml-service's own _effective_rho() already knows how
// to fall back from the last global fit to the fixed constant (see
// main.py), so duplicating that chain here would just be two places that
// could disagree.
export async function getCompetitionRho(supabase: SupabaseClient, competitionId: string): Promise<number | undefined> {
  const { data, error } = await supabase.from("competition_rho").select("fitted_rho").eq("competition_id", competitionId).maybeSingle();
  if (error) throw new Error(`Failed to load competition_rho: ${error.message}`);
  return data ? (data.fitted_rho as number) : undefined;
}
