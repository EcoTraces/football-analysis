import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderPlayerStatistics } from "../providers/types.js";
import { externalId, loadExternalRefs, providerRefKey, upsertPlayer } from "../services/referenceDataService.js";

export interface SyncPlayerStatisticsResult {
  runId: string;
  combinationsConsidered: number;
  processed: number;
  skipped: number;
  failed: number;
  playersProcessed: number;
}

interface TeamCompetitionSeason {
  teamId: string;
  competitionId: string;
  seasonId: string;
}

// Same dedup shape as syncTeamStatistics.ts's loadCombinations — every
// non-synthetic fixture implies two (team, competition, season)
// combinations that need player stats, deduplicated to one provider call
// each rather than one per fixture.
async function loadCombinations(supabase: SupabaseClient): Promise<TeamCompetitionSeason[]> {
  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("home_team_id, away_team_id, competition_id, season_id")
    .eq("is_synthetic", false);
  if (error) throw new Error(`Failed to load fixtures for player-statistics sync: ${error.message}`);

  const seen = new Map<string, TeamCompetitionSeason>();
  for (const fixture of fixtures ?? []) {
    const competitionId = fixture.competition_id as string;
    const seasonId = fixture.season_id as string;
    for (const teamId of [fixture.home_team_id as string, fixture.away_team_id as string]) {
      const key = `${teamId}|${competitionId}|${seasonId}`;
      if (!seen.has(key)) seen.set(key, { teamId, competitionId, seasonId });
    }
  }
  return [...seen.values()];
}

async function upsertPlayerStatistics(
  supabase: SupabaseClient,
  providerKey: string,
  teamId: string,
  seasonId: string,
  stats: ProviderPlayerStatistics,
  provider: string,
  sourceTimestamp: string
): Promise<void> {
  const playerId = await upsertPlayer(supabase, providerKey, stats.playerExternalId, stats.playerName, teamId);

  const { error } = await supabase.from("player_statistics").upsert(
    {
      player_id: playerId,
      team_id: teamId,
      season_id: seasonId,
      player_name: stats.playerName,
      matches_played: stats.matchesPlayed,
      goals_scored: stats.goalsScored,
      minutes_played: stats.minutesPlayed,
      source: provider,
      source_timestamp: sourceTimestamp,
      is_synthetic: false
    },
    { onConflict: "player_id,team_id,season_id" }
  );
  if (error) throw new Error(error.message);
}

// Idempotent via upsert-on-conflict against player_statistics(player_id,
// team_id, season_id) — a genuine plain-column constraint (0006), same
// category as team_statistics.
export async function syncPlayerStatistics(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger
): Promise<SyncPlayerStatisticsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_player_statistics", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const providerKey = providerRefKey(provider.name);
  const combinations = await loadCombinations(supabase);
  const teams = await loadExternalRefs(supabase, "teams", [...new Set(combinations.map((c) => c.teamId))]);
  const competitions = await loadExternalRefs(supabase, "competitions", [...new Set(combinations.map((c) => c.competitionId))]);
  const seasons = await loadExternalRefs(supabase, "seasons", [...new Set(combinations.map((c) => c.seasonId))]);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let playersProcessed = 0;
  const errors: string[] = [];

  for (const combo of combinations) {
    const teamExternalId = externalId(teams.get(combo.teamId), providerKey);
    const competitionExternalId = externalId(competitions.get(combo.competitionId), providerKey);
    const seasonExternalId = externalId(seasons.get(combo.seasonId), providerKey);

    if (!teamExternalId || !competitionExternalId || !seasonExternalId) {
      skipped += 1; // Same "not an error" reasoning as syncTeamStatistics.ts.
      continue;
    }

    try {
      const result = await provider.getPlayerStatistics(teamExternalId, competitionExternalId, seasonExternalId);
      if (!result.ok) {
        failed += 1;
        errors.push(`team ${teamExternalId}/competition ${competitionExternalId}/season ${seasonExternalId}: ${result.reason} — ${result.message}`);
        logger.warn({ combo, reason: result.reason }, "Failed to fetch player statistics");
        continue;
      }

      const sourceTimestamp = new Date().toISOString();
      for (const playerStats of result.data) {
        try {
          await upsertPlayerStatistics(supabase, providerKey, combo.teamId, combo.seasonId, playerStats, provider.name, sourceTimestamp);
          playersProcessed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`team ${teamExternalId}/player ${playerStats.playerExternalId}: ${message}`);
          logger.error({ err, combo, playerStats }, "Failed to upsert player statistics");
        }
      }
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`team ${combo.teamId}/competition ${combo.competitionId}/season ${combo.seasonId}: ${message}`);
      logger.error({ err, combo }, "Failed to sync player statistics for team");
    }
  }

  const status = processed === 0 && (skipped > 0 || failed > 0) ? "failed" : skipped > 0 || failed > 0 ? "partial" : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: playersProcessed,
      records_rejected: skipped + failed,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, combinationsConsidered: combinations.length, processed, skipped, failed, playersProcessed };
}
