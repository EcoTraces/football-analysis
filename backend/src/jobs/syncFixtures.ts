import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderFixture } from "../providers/types.js";
import {
  PROVIDER_KEY,
  upsertCompetition,
  upsertCountryByName,
  upsertSeason,
  upsertTeam
} from "../services/referenceDataService.js";

export interface SyncFixturesResult {
  runId: string;
  daysAttempted: number;
  daysFailed: number;
  fixturesProcessed: number;
  fixturesRejected: number;
}

function* utcDaysInRange(fromIso: string, toIso: string): Generator<string> {
  const cursor = new Date(fromIso.slice(0, 10) + "T00:00:00.000Z");
  const end = new Date(toIso.slice(0, 10) + "T00:00:00.000Z");
  while (cursor.getTime() <= end.getTime()) {
    yield cursor.toISOString();
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

async function upsertFixture(supabase: SupabaseClient, fixture: ProviderFixture, provider: string): Promise<void> {
  // Teams' own nationality isn't in this payload (only the competition's
  // country is) — inferring it from the competition would be actively
  // wrong for continental competitions (a Champions League entrant isn't
  // from "Europe") and only coincidentally right for domestic ones, so
  // team.country_id is intentionally left unset here pending a dedicated
  // team-info sync (see Task.md).
  const countryId = fixture.countryName ? await upsertCountryByName(supabase, fixture.countryName) : null;
  const competitionId = await upsertCompetition(supabase, fixture.competitionExternalId, fixture.competitionName, countryId);
  const seasonId = await upsertSeason(supabase, competitionId, fixture.seasonExternalId, fixture.seasonLabel);
  const homeTeamId = await upsertTeam(supabase, fixture.homeTeamExternalId, fixture.homeTeamName, null);
  const awayTeamId = await upsertTeam(supabase, fixture.awayTeamExternalId, fixture.awayTeamName, null);

  const sourceTimestamp = new Date().toISOString();
  const row = {
    season_id: seasonId,
    competition_id: competitionId,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    round: fixture.round,
    kickoff_utc: fixture.kickoffUtc,
    status: fixture.status,
    home_score: fixture.homeScore,
    away_score: fixture.awayScore,
    source: provider,
    source_timestamp: sourceTimestamp,
    is_synthetic: false
  };

  const { data: existing, error: findError } = await supabase
    .from("fixtures")
    .select("id")
    .eq(`external_ref->>${PROVIDER_KEY}`, fixture.externalId)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up fixture ${fixture.externalId}: ${findError.message}`);

  if (existing) {
    const { error: updateError } = await supabase.from("fixtures").update(row).eq("id", existing.id);
    if (updateError) throw new Error(`Failed to update fixture ${fixture.externalId}: ${updateError.message}`);
    return;
  }

  const { error: insertError } = await supabase
    .from("fixtures")
    .insert({ ...row, external_ref: { [PROVIDER_KEY]: fixture.externalId } });
  if (insertError) throw new Error(`Failed to insert fixture ${fixture.externalId}: ${insertError.message}`);
}

// Idempotent: re-running over the same date range updates existing rows
// (matched by the provider's own fixture id, not just team+kickoff, so a
// postponed-and-rescheduled fixture still resolves to the same row) rather
// than duplicating them. Each fixture is processed independently — one
// fixture failing reference-data resolution doesn't abort the rest of the
// day or the run (spec section 38: jobs must isolate per-item failures).
export async function syncFixturesForDateRange(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  fromIso: string,
  toIso: string,
  logger: Logger
): Promise<SyncFixturesResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_fixtures", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  let daysAttempted = 0;
  let daysFailed = 0;
  let fixturesProcessed = 0;
  let fixturesRejected = 0;
  const errors: string[] = [];

  for (const dayIso of utcDaysInRange(fromIso, toIso)) {
    daysAttempted += 1;
    const result = await provider.getFixturesForDateRange(dayIso, dayIso);

    if (!result.ok) {
      daysFailed += 1;
      errors.push(`${dayIso.slice(0, 10)}: ${result.reason} — ${result.message}`);
      logger.warn({ day: dayIso, reason: result.reason }, "Failed to fetch fixtures for day");
      continue;
    }

    for (const fixture of result.data) {
      try {
        await upsertFixture(supabase, fixture, provider.name);
        fixturesProcessed += 1;
      } catch (err) {
        fixturesRejected += 1;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`fixture ${fixture.externalId}: ${message}`);
        logger.error({ err, externalId: fixture.externalId }, "Failed to upsert fixture");
      }
    }
  }

  const status = fixturesProcessed === 0 && (daysFailed > 0 || fixturesRejected > 0) ? "failed" : daysFailed > 0 || fixturesRejected > 0 ? "partial" : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: fixturesProcessed,
      records_rejected: fixturesRejected,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, daysAttempted, daysFailed, fixturesProcessed, fixturesRejected };
}
