import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

// Elo's own convention for an unrated/new team — matches ml-service's
// elo.py DEFAULT_RATING exactly, since a fixture-time /predict/elo call
// for a team with no team_elo_ratings row yet must see the same starting
// point this job would have used for it.
export const DEFAULT_RATING = 1500;

// Fixed, documented placeholder — like poisson.py's RHO, not fitted or
// backtested against this platform's own results yet. A higher K-factor
// makes ratings move faster per result; 24 sits in the middle of the
// range commonly used for football Elo variants (chess uses ~16-32 too,
// for comparison, though football's own well-known implementations differ
// from each other on this exact value).
export const K_FACTOR = 24;

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export interface EloState {
  rating: number;
  matchesPlayed: number;
}

// Pure function: applies one finished match's result to both teams'
// current Elo state. Uses classic Elo's actual-score convention (1 = win,
// 0.5 = draw, 0 = loss) for the K-factor update — this is a different,
// simpler thing from ml-service's elo_match_probabilities(), which instead
// converts two ratings into a *prediction* (a 3-way home/draw/away
// probability, with its own football-specific draw-probability model);
// updating a rating after a real result doesn't need that draw model at
// all, only the standard two-outcome expected score.
export function applyMatchResult(
  home: EloState,
  away: EloState,
  homeScore: number,
  awayScore: number
): { home: EloState; away: EloState } {
  const actualHome = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  const actualAway = 1 - actualHome;

  const expectedHome = expectedScore(home.rating, away.rating);
  const expectedAway = 1 - expectedHome;

  return {
    home: { rating: home.rating + K_FACTOR * (actualHome - expectedHome), matchesPlayed: home.matchesPlayed + 1 },
    away: { rating: away.rating + K_FACTOR * (actualAway - expectedAway), matchesPlayed: away.matchesPlayed + 1 }
  };
}

interface FixtureResultRow {
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
}

export interface ComputeEloRatingsResult {
  runId: string;
  teamsRated: number;
  matchesReplayed: number;
}

// Recomputes every team's Elo rating from scratch by replaying every
// finished, non-synthetic fixture in chronological order — same
// "recompute the whole thing, don't try to be incremental yet" simplicity
// as calibrateLeagues.ts's runLeagueCalibration, not an event-sourced
// incremental update. Deliberately in-process, not one ml-service HTTP
// call per historical fixture — see this module's own role in the
// rating-maintenance/probability-conversion split documented in
// ml-service/app/models/elo.py's module docstring.
export async function computeCurrentEloRatings(supabase: SupabaseClient, logger: Logger): Promise<ComputeEloRatingsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "compute_elo_ratings", provider: "database", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  try {
    const { data, error } = await supabase
      .from("fixtures")
      .select("home_team_id, away_team_id, home_score, away_score")
      .eq("status", "finished")
      .eq("is_synthetic", false)
      .order("kickoff_utc", { ascending: true });
    if (error) throw new Error(`Failed to load fixtures for Elo replay: ${error.message}`);

    const ratings = new Map<string, EloState>();
    const stateFor = (teamId: string): EloState => ratings.get(teamId) ?? { rating: DEFAULT_RATING, matchesPlayed: 0 };

    let matchesReplayed = 0;
    for (const row of (data ?? []) as FixtureResultRow[]) {
      const updated = applyMatchResult(stateFor(row.home_team_id), stateFor(row.away_team_id), row.home_score, row.away_score);
      ratings.set(row.home_team_id, updated.home);
      ratings.set(row.away_team_id, updated.away);
      matchesReplayed += 1;
    }

    const computedAt = new Date().toISOString();
    for (const [teamId, state] of ratings) {
      const { error: upsertError } = await supabase
        .from("team_elo_ratings")
        .upsert({ team_id: teamId, rating: state.rating, matches_played: state.matchesPlayed, computed_at: computedAt }, { onConflict: "team_id" });
      if (upsertError) throw new Error(`Failed to upsert team_elo_ratings for team ${teamId}: ${upsertError.message}`);
    }

    const { error: finishError } = await supabase
      .from("ingestion_runs")
      .update({ status: "succeeded", records_processed: ratings.size, records_rejected: 0, finished_at: new Date().toISOString() })
      .eq("id", runId);
    if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

    return { runId, teamsRated: ratings.size, matchesReplayed };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Elo rating computation failed.";
    await supabase
      .from("ingestion_runs")
      .update({ status: "failed", error_summary: message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    throw err;
  }
}

export interface TeamElo {
  rating: number;
  matchesPlayed: number;
  // false = no team_elo_ratings row yet (compute_elo_ratings hasn't run,
  // or this team has zero finished fixtures) — the caller falls back to
  // DEFAULT_RATING/0 matches, which ml-service's elo.py.data_quality_for
  // already classifies as "insufficient". Same "never fabricate
  // confidence" shape as calibrateLeagues.ts's LeagueAverages.calibrated.
  computed: boolean;
}

export async function getTeamElo(supabase: SupabaseClient, teamId: string): Promise<TeamElo> {
  const { data, error } = await supabase.from("team_elo_ratings").select("rating, matches_played").eq("team_id", teamId).maybeSingle();
  if (error) throw new Error(`Failed to load team_elo_ratings: ${error.message}`);
  if (!data) return { rating: DEFAULT_RATING, matchesPlayed: 0, computed: false };
  return { rating: data.rating as number, matchesPlayed: data.matches_played as number, computed: true };
}
