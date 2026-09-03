import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { externalId, loadExternalRefs, providerRefKey, upsertTeam } from "../services/referenceDataService.js";

export interface SyncStandingsResult {
  runId: string;
  combinationsConsidered: number;
  combinationsSkipped: number;
  combinationsFailed: number;
  rowsProcessed: number;
  rowsRejected: number;
}

interface CompetitionSeason {
  competitionId: string;
  seasonId: string;
}

// Standings are scoped by competition+season, not by team — one provider
// call returns the whole table. Unlike a season's external id (which
// repeats across competitions — see syncTeamStatistics.ts), an internal
// competition_id is already 1:1 with one real competition, so plain
// internal-id deduplication is enough here; no separate external-key pass
// is needed the way syncInjuries.ts needs one.
async function loadCombinations(supabase: SupabaseClient): Promise<CompetitionSeason[]> {
  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("competition_id, season_id")
    .eq("is_synthetic", false);
  if (error) throw new Error(`Failed to load fixtures for standings sync: ${error.message}`);

  const seen = new Map<string, CompetitionSeason>();
  for (const fixture of fixtures ?? []) {
    const competitionId = fixture.competition_id as string;
    const seasonId = fixture.season_id as string;
    seen.set(`${competitionId}|${seasonId}`, { competitionId, seasonId });
  }
  return [...seen.values()];
}

// Idempotent via a real upsert-on-conflict against standings(season_id,
// team_id) — a genuine plain-column constraint from the initial schema,
// same category as team_statistics and injuries.
export async function syncStandings(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger
): Promise<SyncStandingsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_standings", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const providerKey = providerRefKey(provider.name);
  const combinations = await loadCombinations(supabase);
  const competitions = await loadExternalRefs(supabase, "competitions", [...new Set(combinations.map((c) => c.competitionId))]);
  const seasons = await loadExternalRefs(supabase, "seasons", [...new Set(combinations.map((c) => c.seasonId))]);

  let rowsProcessed = 0;
  let rowsRejected = 0;
  let combinationsSkipped = 0;
  let combinationsFailed = 0;
  const errors: string[] = [];

  for (const combo of combinations) {
    const competitionExternalId = externalId(competitions.get(combo.competitionId), providerKey);
    const seasonExternalId = externalId(seasons.get(combo.seasonId), providerKey);

    if (!competitionExternalId || !seasonExternalId) {
      combinationsSkipped += 1; // No provider id to call with — not an error.
      continue;
    }

    const result = await provider.getStandings(competitionExternalId, seasonExternalId);
    if (!result.ok) {
      combinationsFailed += 1;
      errors.push(`competition ${competitionExternalId}/season ${seasonExternalId}: ${result.reason} — ${result.message}`);
      logger.warn({ combo, reason: result.reason }, "Failed to fetch standings");
      continue;
    }

    for (const row of result.data) {
      try {
        const teamId = await upsertTeam(supabase, providerKey, row.teamExternalId, row.teamName, null);
        const sourceTimestamp = new Date().toISOString();
        const { error } = await supabase.from("standings").upsert(
          {
            season_id: combo.seasonId,
            team_id: teamId,
            position: row.position,
            played: row.played,
            wins: row.wins,
            draws: row.draws,
            losses: row.losses,
            goals_for: row.goalsFor,
            goals_against: row.goalsAgainst,
            points: row.points,
            form: row.form,
            source: provider.name,
            source_timestamp: sourceTimestamp,
            is_synthetic: false
          },
          { onConflict: "season_id,team_id" }
        );
        if (error) throw new Error(error.message);
        rowsProcessed += 1;
      } catch (err) {
        rowsRejected += 1;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`team ${row.teamExternalId}: ${message}`);
        logger.error({ err, row }, "Failed to upsert standings row");
      }
    }
  }

  const status =
    rowsProcessed === 0 && (combinationsFailed > 0 || rowsRejected > 0 || combinationsSkipped > 0)
      ? "failed"
      : combinationsFailed > 0 || rowsRejected > 0 || combinationsSkipped > 0
        ? "partial"
        : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: rowsProcessed,
      records_rejected: rowsRejected + combinationsFailed + combinationsSkipped,
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
    rowsProcessed,
    rowsRejected
  };
}
