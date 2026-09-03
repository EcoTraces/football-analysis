import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { PredictionClient } from "../services/predictionClient.js";
import { getEnabledCompetitionIds, getEnsembleWeights, getScreeningConfig } from "../services/adminConfigService.js";
import { getTeamElo } from "./computeEloRatings.js";
import { getLeagueAverages } from "./calibrateLeagues.js";
import { MIN_MATCHES_FOR_PREDICTION } from "./generatePredictions.js";
import { classifyFreshness, type Freshness } from "../lib/freshness.js";

const RECENT_FORM_WINDOW_MATCHES = 5;
const KEY_ABSENCE_STATUSES = new Set(["injured", "suspended", "doubtful"]);

interface FixtureHistoryRow {
  home_team_id: string;
  away_team_id: string;
  home_score: number;
  away_score: number;
}

export interface RecentForm {
  matchesPlayed: number;
  goalsScoredAvg: number;
  goalsConcededAvg: number;
}

// Same point-in-time-safe shape as runBacktest.ts's computePointInTimeStrength
// (only finished, non-synthetic, strictly-prior fixtures), but windowed to
// the last RECENT_FORM_WINDOW_MATCHES rather than full history — this is
// what makes it a distinct "Form" ensemble component instead of a
// duplicate of the season-long Poisson component.
export async function computeRecentForm(
  supabase: SupabaseClient,
  teamId: string,
  beforeKickoffUtc: string,
  windowMatches = RECENT_FORM_WINDOW_MATCHES
): Promise<RecentForm | null> {
  const { data, error } = await supabase
    .from("fixtures")
    .select("home_team_id, away_team_id, home_score, away_score")
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .eq("status", "finished")
    .eq("is_synthetic", false)
    .lt("kickoff_utc", beforeKickoffUtc)
    .order("kickoff_utc", { ascending: false })
    .limit(windowMatches);
  if (error) throw new Error(`Failed to load recent form: ${error.message}`);

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

interface ScopedStatsRow {
  matches_played: number;
  goals_scored: number | null;
  goals_conceded: number | null;
}

// team_statistics has one row per (team, season, scope) — "home"/"away"
// give the Home/Away ensemble component the true split, distinct from the
// "overall" scope generatePredictions.ts's Poisson component already uses.
async function loadScopedStats(
  supabase: SupabaseClient,
  teamId: string,
  seasonId: string,
  scope: "home" | "away"
): Promise<ScopedStatsRow | null> {
  const { data, error } = await supabase
    .from("team_statistics")
    .select("matches_played, goals_scored, goals_conceded")
    .eq("team_id", teamId)
    .eq("season_id", seasonId)
    .eq("scope", scope)
    .maybeSingle<ScopedStatsRow>();
  if (error) throw new Error(`Failed to load ${scope} team_statistics: ${error.message}`);
  return data;
}

// Global (not per-team) freshness gate for the Injuries component. A
// team's own injuries rows can't distinguish "never synced" from
// "genuinely zero flagged absences" — both look like zero rows — so this
// gates on the sync job itself having actually run recently, uniformly
// across every fixture in one generation run, rather than trying to infer
// per-team sync completeness from an inherently ambiguous absence of rows.
export async function getInjuriesSyncFreshness(supabase: SupabaseClient): Promise<Freshness> {
  const { data, error } = await supabase
    .from("ingestion_runs")
    .select("finished_at")
    .eq("job_name", "sync_injuries")
    .in("status", ["succeeded", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load sync_injuries freshness: ${error.message}`);
  return classifyFreshness((data?.finished_at as string | undefined) ?? null, "injuries");
}

interface InjuryStatusRow {
  player_id: string;
  status: string;
}
interface PlayerGoalsRow {
  player_id: string;
  goals_scored: number | null;
}

// "Key" absence = injured/suspended/doubtful AND an above-team-median
// goalscorer this season (player_statistics.goals_scored) — a named,
// unvalidated Phase 1 simplification (see ensemble.py's injury_adjustment
// docstring); there is no minutes-played/starting-XI/position data in this
// platform to do better than a goals-based proxy.
export async function countKeyAbsences(supabase: SupabaseClient, teamId: string, seasonId: string): Promise<number> {
  const [injuriesRes, statsRes] = await Promise.all([
    supabase.from("injuries").select("player_id, status").eq("team_id", teamId),
    supabase.from("player_statistics").select("player_id, goals_scored").eq("team_id", teamId).eq("season_id", seasonId)
  ]);
  if (injuriesRes.error) throw new Error(`Failed to load injuries: ${injuriesRes.error.message}`);
  if (statsRes.error) throw new Error(`Failed to load player_statistics: ${statsRes.error.message}`);

  const flaggedPlayerIds = new Set(
    ((injuriesRes.data ?? []) as InjuryStatusRow[])
      .filter((row) => KEY_ABSENCE_STATUSES.has(row.status))
      .map((row) => row.player_id)
  );
  if (flaggedPlayerIds.size === 0) return 0;

  const statsRows = (statsRes.data ?? []) as PlayerGoalsRow[];
  if (statsRows.length === 0) return 0;

  const sortedGoals = statsRows.map((row) => row.goals_scored ?? 0).sort((a, b) => a - b);
  const median = sortedGoals[Math.floor(sortedGoals.length / 2)] as number;
  const goalsByPlayer = new Map(statsRows.map((row) => [row.player_id, row.goals_scored ?? 0]));

  let count = 0;
  for (const playerId of flaggedPlayerIds) {
    const goals = goalsByPlayer.get(playerId);
    if (goals !== undefined && goals > median) count += 1;
  }
  return count;
}

interface OddsSnapshotRow {
  bookmaker: string;
  selection: string;
  decimal_odds: number;
  captured_at: string;
}

export interface OddsTriple {
  home: number;
  draw: number;
  away: number;
  bookmaker: string;
  capturedAt: string;
}

// Picks ONE bookmaker's most-recently-complete 1x2 triple, not the best
// price per selection across different bookmakers — mixing books would
// produce a triple that no real market ever quoted, with an overround
// devig_market_probabilities() can't meaningfully interpret. Returns null
// when no bookmaker currently has all three selections.
export async function getLatestOddsTriple(supabase: SupabaseClient, fixtureId: string): Promise<OddsTriple | null> {
  const { data, error } = await supabase
    .from("odds_snapshots")
    .select("bookmaker, selection, decimal_odds, captured_at")
    .eq("fixture_id", fixtureId)
    .eq("market", "1x2")
    .order("captured_at", { ascending: false });
  if (error) throw new Error(`Failed to load odds_snapshots: ${error.message}`);

  const byBookmaker = new Map<string, Map<string, OddsSnapshotRow>>();
  for (const row of (data ?? []) as OddsSnapshotRow[]) {
    const bySelection = byBookmaker.get(row.bookmaker) ?? new Map<string, OddsSnapshotRow>();
    if (!bySelection.has(row.selection)) bySelection.set(row.selection, row); // rows are ordered desc by captured_at, so first-seen per selection is the latest.
    byBookmaker.set(row.bookmaker, bySelection);
  }

  let best: { triple: Map<string, OddsSnapshotRow>; latestCapturedAt: string } | null = null;
  for (const bySelection of byBookmaker.values()) {
    if (!bySelection.has("home") || !bySelection.has("draw") || !bySelection.has("away")) continue;
    const latestCapturedAt = [...bySelection.values()].map((r) => r.captured_at).sort().at(-1) as string;
    if (!best || latestCapturedAt > best.latestCapturedAt) best = { triple: bySelection, latestCapturedAt };
  }
  if (!best) return null;

  return {
    home: best.triple.get("home")!.decimal_odds,
    draw: best.triple.get("draw")!.decimal_odds,
    away: best.triple.get("away")!.decimal_odds,
    bookmaker: best.triple.get("home")!.bookmaker,
    capturedAt: best.latestCapturedAt
  };
}

interface CurrentPoissonRow {
  selection: string;
  probability: number;
  data_quality: "insufficient" | "limited" | "strong";
}

type DataQuality = "insufficient" | "limited" | "strong";
type ComponentTriple = { home: number; draw: number; away: number };

export interface GenerateEnsemblePredictionsResult {
  processed: number;
  skipped: number;
  failed: number;
}

// Idempotent, same as generatePredictionsForUpcomingFixtures: supersedes
// the previous current ensemble_predictions rows per fixture rather than
// appending duplicates.
//
// Deliberately reuses the EXISTING current poisson-baseline prediction
// (predictions table) for the Poisson component instead of calling
// /predict/poisson again here — that call already happened in the
// predictions job; re-deriving it would just be two places that could
// disagree. Elo/Form/Home-Away each make their own ml-service call because
// no earlier job already produces them.
export async function generateEnsemblePredictionsForUpcomingFixtures(
  supabase: SupabaseClient,
  predictionClient: PredictionClient,
  ensembleVersionId: string,
  logger: Logger,
  windowHours = 72
): Promise<GenerateEnsemblePredictionsResult> {
  const enabledCompetitionIds = await getEnabledCompetitionIds(supabase);
  if (!enabledCompetitionIds) {
    logger.warn("Ensemble predictions skipped: no competitions allowlisted yet (see /admin/config/competition-allowlist)");
    return { processed: 0, skipped: 0, failed: 0 };
  }

  const now = new Date();
  const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("id, season_id, competition_id, home_team_id, away_team_id, kickoff_utc")
    .eq("status", "scheduled")
    .eq("is_synthetic", false)
    .in("competition_id", [...enabledCompetitionIds])
    .gte("kickoff_utc", now.toISOString())
    .lte("kickoff_utc", until.toISOString());
  if (error) throw new Error(`Failed to load fixtures for ensemble prediction: ${error.message}`);

  const [weights, screeningConfig, injuriesFreshness] = await Promise.all([
    getEnsembleWeights(supabase),
    getScreeningConfig(supabase),
    getInjuriesSyncFreshness(supabase)
  ]);
  const injuriesUsable = injuriesFreshness === "LIVE" || injuriesFreshness === "RECENT";

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const fixture of fixtures ?? []) {
    try {
      const components: Record<string, ComponentTriple> = {};
      const componentDataQuality: Record<string, DataQuality> = {};

      const { data: poissonRows, error: poissonError } = await supabase
        .from("predictions")
        .select("selection, probability, data_quality")
        .eq("fixture_id", fixture.id)
        .eq("market", "1x2")
        .is("superseded_at", null);
      if (poissonError) throw new Error(poissonError.message);
      const poissonBySelection = new Map(((poissonRows ?? []) as CurrentPoissonRow[]).map((r) => [r.selection, r]));
      if (poissonBySelection.size === 3) {
        components.poisson = {
          home: poissonBySelection.get("home")!.probability,
          draw: poissonBySelection.get("draw")!.probability,
          away: poissonBySelection.get("away")!.probability
        };
        componentDataQuality.poisson = poissonBySelection.get("home")!.data_quality;
      }

      const [homeElo, awayElo] = await Promise.all([
        getTeamElo(supabase, fixture.home_team_id as string),
        getTeamElo(supabase, fixture.away_team_id as string)
      ]);
      const eloResult = await predictionClient.predictElo({
        homeTeam: { rating: homeElo.rating, matchesPlayed: homeElo.matchesPlayed },
        awayTeam: { rating: awayElo.rating, matchesPlayed: awayElo.matchesPlayed }
      });
      if (eloResult) {
        const bySelection = new Map(eloResult.predictions.map((p) => [p.selection, p.probability]));
        components.elo = { home: bySelection.get("home") ?? 0, draw: bySelection.get("draw") ?? 0, away: bySelection.get("away") ?? 0 };
        componentDataQuality.elo = eloResult.dataQuality;
      }

      const leagueAverages = await getLeagueAverages(supabase, fixture.competition_id as string);

      const [homeHomeStats, awayAwayStats] = await Promise.all([
        loadScopedStats(supabase, fixture.home_team_id as string, fixture.season_id as string, "home"),
        loadScopedStats(supabase, fixture.away_team_id as string, fixture.season_id as string, "away")
      ]);
      if (
        homeHomeStats &&
        awayAwayStats &&
        homeHomeStats.matches_played >= MIN_MATCHES_FOR_PREDICTION &&
        awayAwayStats.matches_played >= MIN_MATCHES_FOR_PREDICTION
      ) {
        const homeAwayResult = await predictionClient.predictPoisson({
          homeTeam: {
            matchesPlayed: homeHomeStats.matches_played,
            goalsScoredAvg: (homeHomeStats.goals_scored ?? 0) / homeHomeStats.matches_played,
            goalsConcededAvg: (homeHomeStats.goals_conceded ?? 0) / homeHomeStats.matches_played
          },
          awayTeam: {
            matchesPlayed: awayAwayStats.matches_played,
            goalsScoredAvg: (awayAwayStats.goals_scored ?? 0) / awayAwayStats.matches_played,
            goalsConcededAvg: (awayAwayStats.goals_conceded ?? 0) / awayAwayStats.matches_played
          },
          leagueAvgHomeGoals: leagueAverages.leagueAvgHomeGoals,
          leagueAvgAwayGoals: leagueAverages.leagueAvgAwayGoals
        });
        if (homeAwayResult) {
          const oneXTwo = homeAwayResult.predictions.filter((p) => p.market === "1x2");
          const bySelection = new Map(oneXTwo.map((p) => [p.selection, p.probability]));
          components.homeAway = { home: bySelection.get("home") ?? 0, draw: bySelection.get("draw") ?? 0, away: bySelection.get("away") ?? 0 };
          componentDataQuality.home_away = homeAwayResult.dataQuality;
        }
      }

      const [homeForm, awayForm] = await Promise.all([
        computeRecentForm(supabase, fixture.home_team_id as string, fixture.kickoff_utc as string),
        computeRecentForm(supabase, fixture.away_team_id as string, fixture.kickoff_utc as string)
      ]);
      if (
        homeForm &&
        awayForm &&
        homeForm.matchesPlayed >= MIN_MATCHES_FOR_PREDICTION &&
        awayForm.matchesPlayed >= MIN_MATCHES_FOR_PREDICTION
      ) {
        const formResult = await predictionClient.predictPoisson({
          homeTeam: { matchesPlayed: homeForm.matchesPlayed, goalsScoredAvg: homeForm.goalsScoredAvg, goalsConcededAvg: homeForm.goalsConcededAvg },
          awayTeam: { matchesPlayed: awayForm.matchesPlayed, goalsScoredAvg: awayForm.goalsScoredAvg, goalsConcededAvg: awayForm.goalsConcededAvg },
          leagueAvgHomeGoals: leagueAverages.leagueAvgHomeGoals,
          leagueAvgAwayGoals: leagueAverages.leagueAvgAwayGoals
        });
        if (formResult) {
          const oneXTwo = formResult.predictions.filter((p) => p.market === "1x2");
          const bySelection = new Map(oneXTwo.map((p) => [p.selection, p.probability]));
          components.form = { home: bySelection.get("home") ?? 0, draw: bySelection.get("draw") ?? 0, away: bySelection.get("away") ?? 0 };
          componentDataQuality.form = formResult.dataQuality;
        }
      }

      let homeKeyAbsences: number | undefined;
      let awayKeyAbsences: number | undefined;
      if (injuriesUsable) {
        [homeKeyAbsences, awayKeyAbsences] = await Promise.all([
          countKeyAbsences(supabase, fixture.home_team_id as string, fixture.season_id as string),
          countKeyAbsences(supabase, fixture.away_team_id as string, fixture.season_id as string)
        ]);
      }

      const oddsTriple = await getLatestOddsTriple(supabase, fixture.id as string);
      const oddsUsable = oddsTriple !== null && classifyFreshness(oddsTriple.capturedAt, "odds") !== "STALE" && classifyFreshness(oddsTriple.capturedAt, "odds") !== "UNAVAILABLE";

      if (Object.keys(components).length === 0) {
        skipped += 1; // Nothing at all to combine — never fabricate a prediction from zero components.
        continue;
      }

      const ensembleResult = await predictionClient.predictEnsemble({
        components,
        componentDataQuality,
        weights: {
          elo: weights.elo,
          poisson: weights.poisson,
          form: weights.form,
          homeAway: weights.homeAway,
          injuries: weights.injuries,
          market: weights.market
        },
        scoreWeights: screeningConfig.scoreWeights,
        riskThresholds: screeningConfig.riskThresholds,
        decimalOdds: oddsUsable ? { home: oddsTriple.home, draw: oddsTriple.draw, away: oddsTriple.away } : undefined,
        homeKeyAbsences,
        awayKeyAbsences
      });

      if (!ensembleResult) {
        failed += 1;
        logger.warn({ fixtureId: fixture.id }, "Ensemble prediction service unavailable for fixture");
        continue;
      }

      const generatedAt = new Date().toISOString();
      const { error: supersedeError } = await supabase
        .from("ensemble_predictions")
        .update({ superseded_at: generatedAt })
        .eq("fixture_id", fixture.id)
        .is("superseded_at", null);
      if (supersedeError) throw new Error(supersedeError.message);

      const bestOddsBySelection: Record<string, number> = oddsUsable
        ? { home: oddsTriple.home, draw: oddsTriple.draw, away: oddsTriple.away }
        : {};

      const rows = ensembleResult.selections.map((s) => ({
        fixture_id: fixture.id,
        ensemble_version_id: ensembleVersionId,
        market: ensembleResult.market,
        selection: s.selection,
        combined_probability: s.probability,
        component_probabilities: components,
        component_weights_used: ensembleResult.componentWeightsUsed,
        missing_components: ensembleResult.missingComponents,
        consensus_level: ensembleResult.consensusLevel,
        selection_score: s.selectionScore,
        risk_tier: s.riskTier,
        ev: s.ev,
        edge_pct: s.edgePct,
        best_odds: oddsUsable ? (bestOddsBySelection[s.selection] ?? null) : null,
        best_bookmaker: oddsUsable ? oddsTriple.bookmaker : null,
        data_quality: ensembleResult.dataQuality,
        factors: s.factors,
        generated_at: generatedAt
      }));

      const { error: insertError } = await supabase.from("ensemble_predictions").insert(rows);
      if (insertError) throw new Error(insertError.message);

      processed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, fixtureId: fixture.id }, "Failed to generate ensemble prediction for fixture");
    }
  }

  return { processed, skipped, failed };
}

export interface RunLatestEnsemblePredictionsResult {
  runId: string | null;
  modelVersionId: string | null;
  processed: number;
  skipped: number;
  failed: number;
}

// Same "runId/modelVersionId: null means nothing ran" contract as
// runLatestPoissonPredictionsJob — the caller (admin route: a 409;
// scheduler: a log warning) decides how to surface a missing 'ensemble'
// model_versions row, not this function throwing or guessing.
export async function runLatestEnsemblePredictionsJob(
  supabase: SupabaseClient,
  mlServiceUrl: string,
  logger: Logger,
  windowHours = 72
): Promise<RunLatestEnsemblePredictionsResult> {
  const { data: modelVersion, error } = await supabase
    .from("model_versions")
    .select("id")
    .eq("name", "ensemble")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load ensemble model_version: ${error.message}`);
  if (!modelVersion) {
    return { runId: null, modelVersionId: null, processed: 0, skipped: 0, failed: 0 };
  }

  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "predictions_ensemble", provider: "ml-service", status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const client = new PredictionClient(mlServiceUrl);
  const result = await generateEnsemblePredictionsForUpcomingFixtures(supabase, client, modelVersion.id as string, logger, windowHours);

  const status = result.processed === 0 && result.failed > 0 ? "failed" : result.failed > 0 || result.skipped > 0 ? "partial" : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({ status, records_processed: result.processed, records_rejected: result.failed, finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, modelVersionId: modelVersion.id as string, ...result };
}
