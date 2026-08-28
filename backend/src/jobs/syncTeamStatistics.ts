import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderTeamStatistics } from "../providers/types.js";
import { externalId, loadExternalRefs } from "../services/referenceDataService.js";

export interface SyncTeamStatisticsResult {
  runId: string;
  combinationsConsidered: number;
  processed: number;
  skipped: number;
  failed: number;
}

interface TeamCompetitionSeason {
  teamId: string;
  competitionId: string;
  seasonId: string;
}

// Every non-synthetic fixture implies two (team, competition, season)
// combinations (home and away) that need stats — deduplicated so a team
// that plays 19 home fixtures in a season only costs one provider call for
// its home-competition-season combination, not nineteen.
async function loadCombinations(supabase: SupabaseClient): Promise<TeamCompetitionSeason[]> {
  const { data: fixtures, error } = await supabase
    .from("fixtures")
    .select("home_team_id, away_team_id, competition_id, season_id")
    .eq("is_synthetic", false);
  if (error) throw new Error(`Failed to load fixtures for team-statistics sync: ${error.message}`);

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

function statisticsRows(
  teamId: string,
  seasonId: string,
  stats: ProviderTeamStatistics,
  provider: string,
  sourceTimestamp: string
) {
  const base = { team_id: teamId, season_id: seasonId, source: provider, source_timestamp: sourceTimestamp, is_synthetic: false };
  return [
    {
      ...base,
      scope: "overall",
      matches_played: stats.matchesPlayed,
      goals_scored: stats.goalsFor,
      goals_conceded: stats.goalsAgainst,
      clean_sheets: stats.cleanSheets,
      failed_to_score: stats.failedToScore,
      yellow_cards: stats.yellowCards,
      red_cards: stats.redCards
    },
    {
      ...base,
      scope: "home",
      matches_played: stats.matchesPlayedHome,
      goals_scored: stats.goalsForHome,
      goals_conceded: stats.goalsAgainstHome,
      clean_sheets: null,
      failed_to_score: null,
      yellow_cards: null,
      red_cards: null
    },
    {
      ...base,
      scope: "away",
      matches_played: stats.matchesPlayedAway,
      goals_scored: stats.goalsForAway,
      goals_conceded: stats.goalsAgainstAway,
      clean_sheets: null,
      failed_to_score: null,
      yellow_cards: null,
      red_cards: null
    }
  ];
}

// Idempotent via a real upsert-on-conflict (unlike syncFixtures.ts's
// find-then-insert): team_statistics has a genuine plain-column unique
// constraint on (team_id, season_id, scope) from the initial schema, not an
// expression index, so PostgREST's on_conflict is documented to work
// correctly against it.
export async function syncTeamStatistics(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger
): Promise<SyncTeamStatisticsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_team_statistics", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const combinations = await loadCombinations(supabase);
  const teams = await loadExternalRefs(supabase, "teams", [...new Set(combinations.map((c) => c.teamId))]);
  const competitions = await loadExternalRefs(supabase, "competitions", [...new Set(combinations.map((c) => c.competitionId))]);
  const seasons = await loadExternalRefs(supabase, "seasons", [...new Set(combinations.map((c) => c.seasonId))]);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const combo of combinations) {
    const teamExternalId = externalId(teams.get(combo.teamId));
    const competitionExternalId = externalId(competitions.get(combo.competitionId));
    const seasonExternalId = externalId(seasons.get(combo.seasonId));

    if (!teamExternalId || !competitionExternalId || !seasonExternalId) {
      // Can't call the provider without its own ids for all three — most
      // often this means the fixture behind this combination was ingested
      // before external_ref existed, or the season/team/competition was
      // created some other way. Not an error worth failing the run over.
      skipped += 1;
      continue;
    }

    try {
      const result = await provider.getTeamStatistics(teamExternalId, competitionExternalId, seasonExternalId);
      if (!result.ok) {
        failed += 1;
        errors.push(`team ${teamExternalId}/competition ${competitionExternalId}/season ${seasonExternalId}: ${result.reason} — ${result.message}`);
        logger.warn({ combo, reason: result.reason }, "Failed to fetch team statistics");
        continue;
      }

      const sourceTimestamp = new Date().toISOString();
      for (const row of statisticsRows(combo.teamId, combo.seasonId, result.data, provider.name, sourceTimestamp)) {
        const { error } = await supabase.from("team_statistics").upsert(row, { onConflict: "team_id,season_id,scope" });
        if (error) throw new Error(error.message);
      }
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`team ${combo.teamId}/competition ${combo.competitionId}/season ${combo.seasonId}: ${message}`);
      logger.error({ err, combo }, "Failed to upsert team statistics");
    }
  }

  const status = processed === 0 && (skipped > 0 || failed > 0) ? "failed" : skipped > 0 || failed > 0 ? "partial" : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: processed,
      records_rejected: skipped + failed,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, combinationsConsidered: combinations.length, processed, skipped, failed };
}
