import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider, ProviderLineup } from "../providers/types.js";
import { providerRefKey, upsertPlayer, upsertTeam } from "../services/referenceDataService.js";

export interface SyncLineupsResult {
  runId: string;
  fixturesConsidered: number;
  fixturesSkipped: number;
  fixturesFailed: number;
  fixturesNotYetAvailable: number;
  lineupsProcessed: number;
  lineupsRejected: number;
}

interface FixtureRow {
  id: string;
  external_ref: Record<string, string> | null;
}

// Lineups are only meaningful near kickoff (spec section 6: "refresh closer
// to kickoff") — syncing every fixture ever recorded would waste calls on
// matches with no lineup to fetch yet or long since irrelevant. The window
// is symmetric around now so a periodic run also catches lineups for
// recently finished matches, which stay useful as confirmed team-news
// history.
async function loadFixturesInWindow(supabase: SupabaseClient, windowHours: number): Promise<FixtureRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const to = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id, external_ref")
    .eq("is_synthetic", false)
    .in("status", ["scheduled", "live", "finished"])
    .gte("kickoff_utc", from.toISOString())
    .lte("kickoff_utc", to.toISOString());
  if (error) throw new Error(`Failed to load fixtures for lineups sync: ${error.message}`);
  return (data ?? []) as FixtureRow[];
}

async function upsertLineup(
  supabase: SupabaseClient,
  fixtureId: string,
  lineup: ProviderLineup,
  providerName: string
): Promise<void> {
  const providerKey = providerRefKey(providerName);
  const teamId = await upsertTeam(supabase, providerKey, lineup.teamExternalId, lineup.teamName, null);

  const startingPlayerIds = await Promise.all(
    lineup.startingPlayers.map((p) => upsertPlayer(supabase, providerKey, p.externalId, p.name, teamId))
  );
  const substitutePlayerIds = await Promise.all(
    lineup.substitutePlayers.map((p) => upsertPlayer(supabase, providerKey, p.externalId, p.name, teamId))
  );

  const { error } = await supabase.from("lineups").upsert(
    {
      fixture_id: fixtureId,
      team_id: teamId,
      // api-football's /fixtures/lineups is documented as updating only
      // once lineups are officially released (~30-60 min before kickoff),
      // not a "predicted" lineup feature — so every entry it returns is
      // the real confirmed one, never an "expected" guess. If a future
      // provider mixes confirmed and predicted lineups in one response,
      // that distinction needs to come from ProviderLineup, not be assumed
      // here.
      confirmation_status: "confirmed",
      formation: lineup.formation,
      starting_players: startingPlayerIds,
      substitute_players: substitutePlayerIds,
      source: providerName,
      source_timestamp: new Date().toISOString(),
      is_synthetic: false
    },
    { onConflict: "fixture_id,team_id" }
  );
  if (error) throw new Error(error.message);
}

// Idempotent via a real upsert-on-conflict against lineups(fixture_id,
// team_id) — a genuine plain-column constraint from the initial schema,
// same category as team_statistics/injuries/standings.
export async function syncLineups(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger,
  windowHours = 24
): Promise<SyncLineupsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_lineups", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const providerKey = providerRefKey(provider.name);
  const fixtures = await loadFixturesInWindow(supabase, windowHours);

  let fixturesSkipped = 0;
  let fixturesFailed = 0;
  let fixturesNotYetAvailable = 0;
  let lineupsProcessed = 0;
  let lineupsRejected = 0;
  const errors: string[] = [];

  for (const fixture of fixtures) {
    const fixtureExternalId = fixture.external_ref?.[providerKey];
    if (typeof fixtureExternalId !== "string") {
      fixturesSkipped += 1; // No provider id to call with — not an error.
      continue;
    }

    const result = await provider.getLineup(fixtureExternalId);
    if (!result.ok) {
      fixturesFailed += 1;
      errors.push(`fixture ${fixtureExternalId}: ${result.reason} — ${result.message}`);
      logger.warn({ fixtureId: fixture.id, reason: result.reason }, "Failed to fetch lineup");
      continue;
    }

    if (result.data.length === 0) {
      // A genuinely valid state, not a failure: the vendor returns an
      // empty response until lineups are officially released.
      fixturesNotYetAvailable += 1;
      continue;
    }

    for (const lineup of result.data) {
      try {
        await upsertLineup(supabase, fixture.id, lineup, provider.name);
        lineupsProcessed += 1;
      } catch (err) {
        lineupsRejected += 1;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`fixture ${fixtureExternalId}/team ${lineup.teamExternalId}: ${message}`);
        logger.error({ err, fixtureId: fixture.id, lineup }, "Failed to upsert lineup");
      }
    }
  }

  const status =
    lineupsProcessed === 0 && (fixturesFailed > 0 || lineupsRejected > 0)
      ? "failed"
      : fixturesFailed > 0 || lineupsRejected > 0 || fixturesSkipped > 0
        ? "partial"
        : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: lineupsProcessed,
      records_rejected: lineupsRejected + fixturesFailed + fixturesSkipped,
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
    fixturesNotYetAvailable,
    lineupsProcessed,
    lineupsRejected
  };
}
