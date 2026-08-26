import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { PROVIDER_KEY } from "../services/referenceDataService.js";

export interface SyncOddsResult {
  runId: string;
  fixturesConsidered: number;
  fixturesSkipped: number;
  fixturesFailed: number;
  fixturesNotYetAvailable: number;
  snapshotsProcessed: number;
  snapshotsRejected: number;
}

interface FixtureRow {
  id: string;
  external_ref: Record<string, string> | null;
}

// Odds are only meaningful for matches that haven't been decided yet —
// unlike lineups.ts, which also windows around recently finished fixtures
// for their team-news value, there's no "closing odds" use case built on
// top of this schema yet, so 'finished' fixtures are excluded here.
async function loadFixturesInWindow(supabase: SupabaseClient, windowHours: number): Promise<FixtureRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const to = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("fixtures")
    .select("id, external_ref")
    .eq("is_synthetic", false)
    .in("status", ["scheduled", "live"])
    .gte("kickoff_utc", from.toISOString())
    .lte("kickoff_utc", to.toISOString());
  if (error) throw new Error(`Failed to load fixtures for odds sync: ${error.message}`);
  return (data ?? []) as FixtureRow[];
}

// NOT idempotent-by-upsert like the other jobs, deliberately: odds_snapshots
// is a genuine time series (the name says so) — the whole point of spec
// section 25's value analysis is comparing a model probability against the
// market's price at a point in time, and tracking how that price moves.
// Overwriting a "current odds" row the way syncStandings.ts overwrites a
// table position would destroy the history this table exists to keep.
// Every successful run therefore inserts new rows rather than upserting;
// running this job on a tight schedule with unchanged prices does grow the
// table with duplicate-valued snapshots — a real cost, and a candidate for
// a future "skip if identical to the immediately preceding snapshot"
// optimization (see Task.md), not solved here to keep this job's first
// version simple and unambiguously correct.
export async function syncOdds(
  supabase: SupabaseClient,
  provider: FootballDataProvider,
  logger: Logger,
  windowHours = 24
): Promise<SyncOddsResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "sync_odds", provider: provider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const fixtures = await loadFixturesInWindow(supabase, windowHours);

  let fixturesSkipped = 0;
  let fixturesFailed = 0;
  let fixturesNotYetAvailable = 0;
  let snapshotsProcessed = 0;
  let snapshotsRejected = 0;
  const errors: string[] = [];

  for (const fixture of fixtures) {
    const fixtureExternalId = fixture.external_ref?.[PROVIDER_KEY];
    if (typeof fixtureExternalId !== "string") {
      fixturesSkipped += 1; // No provider id to call with — not an error.
      continue;
    }

    const result = await provider.getOdds(fixtureExternalId);
    if (!result.ok) {
      fixturesFailed += 1;
      errors.push(`fixture ${fixtureExternalId}: ${result.reason} — ${result.message}`);
      logger.warn({ fixtureId: fixture.id, reason: result.reason }, "Failed to fetch odds");
      continue;
    }

    if (result.data.length === 0) {
      // A genuinely valid state: no bookmaker has posted a price yet (or
      // none in a market this platform covers) — not a failure.
      fixturesNotYetAvailable += 1;
      continue;
    }

    const capturedAt = new Date().toISOString();
    for (const bookmakerOdds of result.data) {
      for (const selection of bookmakerOdds.selections) {
        try {
          const { error } = await supabase.from("odds_snapshots").insert({
            fixture_id: fixture.id,
            bookmaker: bookmakerOdds.bookmaker,
            market: selection.market,
            selection: selection.selection,
            decimal_odds: selection.decimalOdds,
            captured_at: capturedAt,
            source: provider.name,
            is_synthetic: false
          });
          if (error) throw new Error(error.message);
          snapshotsProcessed += 1;
        } catch (err) {
          snapshotsRejected += 1;
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`fixture ${fixtureExternalId}/${bookmakerOdds.bookmaker}/${selection.market}: ${message}`);
          logger.error({ err, fixtureId: fixture.id, bookmaker: bookmakerOdds.bookmaker, selection }, "Failed to insert odds snapshot");
        }
      }
    }
  }

  const status =
    snapshotsProcessed === 0 && (fixturesFailed > 0 || snapshotsRejected > 0)
      ? "failed"
      : fixturesFailed > 0 || snapshotsRejected > 0 || fixturesSkipped > 0
        ? "partial"
        : "succeeded";

  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: snapshotsProcessed,
      records_rejected: snapshotsRejected + fixturesFailed + fixturesSkipped,
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
    snapshotsProcessed,
    snapshotsRejected
  };
}
