import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { externalId, loadExternalRefs, PROVIDER_KEY } from "../services/referenceDataService.js";

export interface SyncFixtureStatisticsResult {
  runId: string;
  fixturesConsidered: number;
  fixturesSkipped: number;
  fixturesFailed: number;
  statisticsProcessed: number;
  statisticsRejected: number;
  teamsAggregated: number;
}

interface FixtureRow {
  id: string;
  season_id: string;
  home_team_id: string;
  away_team_id: string;
  external_ref: Record<string, string> | null;
}

// Corners aren't in api-football's /teams/statistics season aggregate at
// all (see ApiFootballProvider.ts's getFixtureStatistics comment) — the
// only source is per-fixture box-score stats, and only for matches that
// have actually finished. Bounded to a recent-past window (not "every
// finished fixture ever") for the same reason lineups/odds are windowed:
// unbounded backfill would be one provider call per historical fixture,
// which this project has no real quota budget to verify against.
async function loadFinishedFixturesInWindow(supabase: SupabaseClient, windowHours: number): Promise<FixtureRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id, season_id, home_team_id, away_team_id, external_ref")
    .eq("is_synthetic", false)
    .eq("status", "finished")
    .gte("kickoff_utc", from.toISOString())
    .lte("kickoff_utc", now.toISOString());
  if (error) throw new Error(`Failed to load fixtures for fixture-statistics sync: ${error.message}`);
  return (data ?? []) as FixtureRow[];
}

// Idempotent via upsert-on-conflict against fixture_statistics(fixture_id,
// team_id) — same category of genuine plain-column constraint as
// lineups/team_statistics. Then re-aggregates each touched team's average
// corners for the fixture's season into team_statistics.corners (present
// since 0001, unpopulated until this job existed) via a second upsert that
// only supplies team_id/season_id/scope/corners — Postgres's ON CONFLICT DO
// UPDATE only sets the columns present in the payload, so this can't
// clobber goals/cards/etc. written by syncTeamStatistics.ts for the same
// row (verified against both the real schema's upsert semantics and this
// repo's FakeSupabase test double, which mirrors that column-scoped merge).
export async function syncFixtureStatistics(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger,
  windowHours = 72
): Promise<SyncFixtureStatisticsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_fixture_statistics", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const fixtures = await loadFinishedFixturesInWindow(supabase, windowHours);
  const teamIds = [...new Set(fixtures.flatMap((f) => [f.home_team_id, f.away_team_id]))];
  const teamRefs = await loadExternalRefs(supabase, "teams", teamIds);

  let fixturesSkipped = 0;
  let fixturesFailed = 0;
  let statisticsProcessed = 0;
  let statisticsRejected = 0;
  const errors: string[] = [];
  const touchedTeamSeasons = new Map<string, { teamId: string; seasonId: string }>();

  for (const fixture of fixtures) {
    const fixtureExternalId = fixture.external_ref?.[PROVIDER_KEY];
    if (typeof fixtureExternalId !== "string") {
      fixturesSkipped += 1; // No provider id to call with — not an error.
      continue;
    }

    // Only the fixture's own two participants are candidate matches for the
    // response's team entries — resolved locally per fixture rather than a
    // single flipped-around global map, since a team's external id is only
    // meaningful in relation to a specific team, not something to search
    // for accidentally colliding with an unrelated team.
    const homeExternalId = externalId(teamRefs.get(fixture.home_team_id));
    const awayExternalId = externalId(teamRefs.get(fixture.away_team_id));
    const byExternalId = new Map<string, string>();
    if (homeExternalId) byExternalId.set(homeExternalId, fixture.home_team_id);
    if (awayExternalId) byExternalId.set(awayExternalId, fixture.away_team_id);

    if (byExternalId.size === 0) {
      fixturesSkipped += 1; // Neither participant has a provider id yet.
      continue;
    }

    const result = await provider.getFixtureStatistics(fixtureExternalId);
    if (!result.ok) {
      fixturesFailed += 1;
      errors.push(`fixture ${fixtureExternalId}: ${result.reason} — ${result.message}`);
      logger.warn({ fixtureId: fixture.id, reason: result.reason }, "Failed to fetch fixture statistics");
      continue;
    }

    const sourceTimestamp = new Date().toISOString();
    for (const entry of result.data) {
      const teamId = byExternalId.get(entry.teamExternalId);
      if (!teamId) {
        // Vendor returned a team this fixture doesn't recognize as a
        // participant — a real mismatch worth counting, not silently
        // dropping (would otherwise look identical to a clean success).
        statisticsRejected += 1;
        errors.push(`fixture ${fixtureExternalId}: statistics entry for unrecognized team ${entry.teamExternalId}`);
        continue;
      }

      try {
        const { error } = await supabase.from("fixture_statistics").upsert(
          {
            fixture_id: fixture.id,
            team_id: teamId,
            season_id: fixture.season_id,
            corners: entry.corners,
            source: provider.name,
            source_timestamp: sourceTimestamp,
            is_synthetic: false
          },
          { onConflict: "fixture_id,team_id" }
        );
        if (error) throw new Error(error.message);
        statisticsProcessed += 1;
        touchedTeamSeasons.set(`${teamId}|${fixture.season_id}`, { teamId, seasonId: fixture.season_id });
      } catch (err) {
        statisticsRejected += 1;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`fixture ${fixtureExternalId}/team ${entry.teamExternalId}: ${message}`);
        logger.error({ err, fixtureId: fixture.id, entry }, "Failed to upsert fixture statistics");
      }
    }
  }

  for (const { teamId, seasonId } of touchedTeamSeasons.values()) {
    try {
      await refreshTeamCornersAverage(supabase, teamId, seasonId, provider.name);
    } catch (err) {
      logger.error({ err, teamId, seasonId }, "Failed to refresh team_statistics.corners");
    }
  }

  const status =
    statisticsProcessed === 0 && (fixturesFailed > 0 || statisticsRejected > 0)
      ? "failed"
      : fixturesFailed > 0 || statisticsRejected > 0 || fixturesSkipped > 0
        ? "partial"
        : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: statisticsProcessed,
      records_rejected: statisticsRejected + fixturesFailed + fixturesSkipped,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return {
    runId,
    fixturesConsidered: fixtures.length,
    fixturesSkipped,
    fixturesFailed,
    statisticsProcessed,
    statisticsRejected,
    teamsAggregated: touchedTeamSeasons.size
  };
}

// Exported for direct unit testing. Averages only over rows with a
// non-null corners value — a fixture the vendor didn't return a corners
// figure for shouldn't silently pull the average toward 0.
export async function refreshTeamCornersAverage(
  supabase: SupabaseClient,
  teamId: string,
  seasonId: string,
  provider: string
): Promise<number | null> {
  const { data, error } = await supabase
    .from("fixture_statistics")
    .select("corners")
    .eq("team_id", teamId)
    .eq("season_id", seasonId);
  if (error) throw new Error(`Failed to load fixture_statistics for corners aggregation: ${error.message}`);

  const values = (data ?? []).map((row) => row.corners as number | null).filter((v): v is number => v !== null);
  if (values.length === 0) return null;

  const average = values.reduce((sum, v) => sum + v, 0) / values.length;

  const { error: upsertError } = await supabase.from("team_statistics").upsert(
    {
      team_id: teamId,
      season_id: seasonId,
      scope: "overall",
      corners: average,
      source: provider,
      source_timestamp: new Date().toISOString()
    },
    { onConflict: "team_id,season_id,scope" }
  );
  if (upsertError) throw new Error(`Failed to upsert team_statistics.corners: ${upsertError.message}`);

  return average;
}
