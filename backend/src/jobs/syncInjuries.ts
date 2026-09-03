import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderInjury } from "../providers/types.js";
import { externalId, loadExternalRefs, providerRefKey, upsertPlayer } from "../services/referenceDataService.js";

export interface SyncInjuriesResult {
  runId: string;
  combinationsConsidered: number;
  combinationsSkipped: number;
  combinationsFailed: number;
  playersProcessed: number;
  playersRejected: number;
}

interface TeamSeasonExternal {
  teamId: string;
  teamExternalId: string;
  seasonExternalId: string;
}

interface LoadedCombinations {
  combinations: TeamSeasonExternal[];
  skipped: number;
}

// The provider's /injuries endpoint is keyed on (team, season) only, not
// competition — a player's injury doesn't depend on which competition a
// fixture belongs to. Deduplicated on the (teamExternalId, seasonExternalId)
// pair actually sent to the provider, since two internal season_id rows for
// the same team (one per competition) can share the same external season
// id (e.g. both "2026") and would otherwise trigger a redundant call.
async function loadCombinations(supabase: SupabaseClient, providerKey: string): Promise<LoadedCombinations> {
  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("home_team_id, away_team_id, season_id")
    .eq("is_synthetic", false);
  if (error) throw new Error(`Failed to load fixtures for injuries sync: ${error.message}`);

  const teamIds = new Set<string>();
  const seasonIds = new Set<string>();
  const teamSeasonPairs = new Set<string>();
  for (const fixture of fixtures ?? []) {
    const seasonId = fixture.season_id as string;
    seasonIds.add(seasonId);
    for (const teamId of [fixture.home_team_id as string, fixture.away_team_id as string]) {
      teamIds.add(teamId);
      teamSeasonPairs.add(`${teamId}|${seasonId}`);
    }
  }

  const teams = await loadExternalRefs(supabase, "teams", [...teamIds]);
  const seasons = await loadExternalRefs(supabase, "seasons", [...seasonIds]);

  const seen = new Map<string, TeamSeasonExternal>();
  let skipped = 0;
  for (const pair of teamSeasonPairs) {
    const [teamId, seasonId] = pair.split("|") as [string, string];
    const teamExternalId = externalId(teams.get(teamId), providerKey);
    const seasonExternalId = externalId(seasons.get(seasonId), providerKey);
    if (!teamExternalId || !seasonExternalId) {
      skipped += 1; // No provider id to call with for this pair — not an error.
      continue;
    }
    const key = `${teamExternalId}|${seasonExternalId}`;
    if (!seen.has(key)) seen.set(key, { teamId, teamExternalId, seasonExternalId });
  }

  return { combinations: [...seen.values()], skipped };
}

// The provider reports one entry per (player, fixture) a player was missing
// for, not a single current-status flag — this keeps only each player's
// most recently dated report, which is the closest available proxy for
// "their status right now." A player who has since recovered but doesn't
// appear in a fresher report will show a stale row rather than a wrong
// "still injured" one being actively reasserted — freshness classification
// (lib/freshness.ts) surfaces that staleness to callers instead of this job
// guessing at recovery.
function mostRecentPerPlayer(injuries: ProviderInjury[]): ProviderInjury[] {
  const latest = new Map<string, ProviderInjury>();
  for (const injury of injuries) {
    const existing = latest.get(injury.playerExternalId);
    if (!existing || injury.reportedForFixtureUtc > existing.reportedForFixtureUtc) {
      latest.set(injury.playerExternalId, injury);
    }
  }
  return [...latest.values()];
}

// Idempotent via a real upsert-on-conflict against injuries(player_id) —
// see migration 0003's comment: this schema models "current status per
// player," not a history of every report, so one row per player is correct.
export async function syncInjuries(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger
): Promise<SyncInjuriesResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_injuries", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const providerKey = providerRefKey(provider.name);
  const { combinations, skipped: combinationsSkipped } = await loadCombinations(supabase, providerKey);

  let playersProcessed = 0;
  let playersRejected = 0;
  let combinationsFailed = 0;
  const errors: string[] = [];

  for (const combo of combinations) {
    const result = await provider.getInjuries(combo.teamExternalId, combo.seasonExternalId);
    if (!result.ok) {
      combinationsFailed += 1;
      errors.push(`team ${combo.teamExternalId}/season ${combo.seasonExternalId}: ${result.reason} — ${result.message}`);
      logger.warn({ combo, reason: result.reason }, "Failed to fetch injuries");
      continue;
    }

    for (const injury of mostRecentPerPlayer(result.data)) {
      try {
        const playerId = await upsertPlayer(supabase, providerKey, injury.playerExternalId, injury.playerName, combo.teamId);
        const sourceTimestamp = new Date().toISOString();
        const { error } = await supabase.from("injuries").upsert(
          {
            player_id: playerId,
            team_id: combo.teamId,
            status: injury.status,
            description: injury.description,
            source: provider.name,
            source_timestamp: sourceTimestamp,
            is_synthetic: false
          },
          { onConflict: "player_id" }
        );
        if (error) throw new Error(error.message);
        playersProcessed += 1;
      } catch (err) {
        playersRejected += 1;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`player ${injury.playerExternalId}: ${message}`);
        logger.error({ err, injury }, "Failed to upsert injury");
      }
    }
  }

  const status =
    playersProcessed === 0 && (combinationsFailed > 0 || playersRejected > 0 || combinationsSkipped > 0)
      ? "failed"
      : combinationsFailed > 0 || playersRejected > 0 || combinationsSkipped > 0
        ? "partial"
        : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: playersProcessed,
      records_rejected: playersRejected + combinationsFailed + combinationsSkipped,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return {
    runId,
    combinationsConsidered: combinations.length,
    combinationsSkipped,
    combinationsFailed,
    playersProcessed,
    playersRejected
  };
}
