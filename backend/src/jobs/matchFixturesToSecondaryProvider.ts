import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { FootballDataProvider } from "../providers/types.js";
import { externalId, loadTeamNames, providerRefKey } from "../services/referenceDataService.js";
import { candidatesMatching, findFixtureMatch, teamNamesMatch } from "../lib/teamNameMatch.js";

export interface MatchFixturesToSecondaryProviderResult {
  runId: string;
  fixturesConsidered: number;
  alreadyLinked: number;
  matched: number;
  ambiguous: number;
  noCandidate: number;
}

interface FixtureRow {
  id: string;
  external_ref: Record<string, string> | null;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
}

async function loadUpcomingFixtures(supabase: SupabaseClient, windowDays: number): Promise<FixtureRow[]> {
  const now = new Date();
  const to = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("fixtures")
    .select("id, external_ref, home_team_id, away_team_id, kickoff_utc")
    .eq("is_synthetic", false)
    .in("status", ["scheduled", "live"])
    .gte("kickoff_utc", now.toISOString())
    .lte("kickoff_utc", to.toISOString());
  if (error) throw new Error(`Failed to load fixtures for secondary-provider matching: ${error.message}`);
  return (data ?? []) as FixtureRow[];
}

const MATCH_WINDOW_DAYS = 7; // Comfortably ahead of the ±24h window syncOdds/syncInjuries/syncLineups actually need matched fixtures for.
const MATCH_TOLERANCE_MINUTES = 15;

// Links each upcoming fixture (however it was originally sourced) to its
// counterpart in secondaryProvider by adding a second external_ref key —
// never a second fixture row, never an overwrite of the primary provider's
// own key. This is what lets syncOdds.ts/syncInjuries.ts/syncLineups.ts
// (pointed at secondaryProvider — see scheduler.ts) find the right
// upstream fixture to call, when the fixture itself was created from a
// DIFFERENT provider's sync.
//
// Deliberately conservative (see teamNameMatch.ts's own comment): a link
// is only ever written when findFixtureMatch finds exactly one qualifying
// candidate. Zero or multiple candidates are both left unlinked — counted
// separately (noCandidate vs. ambiguous) for observability, never guessed.
//
// If secondaryProvider happens to be the SAME provider that created these
// fixtures (e.g. a deployment that hasn't configured a distinct secondary
// key), every fixture already carries that provider's own external_ref key
// from its own sync — alreadyLinked covers all of them and this job is a
// fast no-op, without needing a special case for that.
export async function matchFixturesToSecondaryProvider(
  supabase: SupabaseClient,
  secondaryProvider: FootballDataProvider,
  logger: Logger,
  windowDays = MATCH_WINDOW_DAYS
): Promise<MatchFixturesToSecondaryProviderResult> {
  const { data: run, error: runError } = await supabase
    .from("ingestion_runs")
    .insert({ job_name: "match_fixtures_secondary_provider", provider: secondaryProvider.name, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(`Failed to create ingestion_runs row: ${runError.message}`);
  const runId = run.id as string;

  const secondaryKey = providerRefKey(secondaryProvider.name);
  const fixtures = await loadUpcomingFixtures(supabase, windowDays);
  const unlinked = fixtures.filter((f) => externalId(f, secondaryKey) === null);
  const alreadyLinked = fixtures.length - unlinked.length;

  let matched = 0;
  let ambiguous = 0;
  let noCandidate = 0;
  const errors: string[] = [];

  if (unlinked.length > 0) {
    const now = new Date();
    const to = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const candidatesResult = await secondaryProvider.getFixturesForDateRange(now.toISOString(), to.toISOString());

    if (!candidatesResult.ok) {
      errors.push(`secondary provider fixtures fetch: ${candidatesResult.reason} — ${candidatesResult.message}`);
      logger.warn({ reason: candidatesResult.reason }, "Failed to fetch secondary-provider fixtures for matching");
      noCandidate += unlinked.length;
    } else {
      const teamIds = Array.from(new Set(unlinked.flatMap((f) => [f.home_team_id, f.away_team_id])));
      const teamNames = await loadTeamNames(supabase, teamIds);
      const candidates = candidatesResult.data;

      for (const fixture of unlinked) {
        const homeTeamName = teamNames.get(fixture.home_team_id);
        const awayTeamName = teamNames.get(fixture.away_team_id);
        if (!homeTeamName || !awayTeamName) {
          noCandidate += 1; // No team name on our own side — can't even attempt a comparison.
          continue;
        }

        const target = { externalId: fixture.id, homeTeamName, awayTeamName, kickoffUtc: fixture.kickoff_utc };
        const match = findFixtureMatch(target, candidates, MATCH_TOLERANCE_MINUTES);

        if (!match) {
          const qualifying = candidatesMatching(target, candidates, MATCH_TOLERANCE_MINUTES);
          if (qualifying.length > 1) ambiguous += 1;
          else if (teamNamesMatch(target, candidates)) ambiguous += 1; // Names match somewhere, but not within the kickoff tolerance — still a signal worth distinguishing from "no idea".
          else noCandidate += 1;
          continue;
        }

        try {
          const mergedRef = { ...(fixture.external_ref ?? {}), [secondaryKey]: match.externalId };
          const { error } = await supabase.from("fixtures").update({ external_ref: mergedRef }).eq("id", fixture.id);
          if (error) throw new Error(error.message);
          matched += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`fixture ${fixture.id}: ${message}`);
          logger.error({ err, fixtureId: fixture.id }, "Failed to link secondary-provider external_ref");
        }
      }
    }
  }

  const status = errors.length > 0 ? "partial" : "succeeded";
  const { error: finishError } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      records_processed: matched,
      records_rejected: ambiguous + noCandidate,
      error_summary: errors.length > 0 ? errors.slice(0, 20).join("; ") : null,
      finished_at: new Date().toISOString()
    })
    .eq("id", runId);
  if (finishError) logger.error({ err: finishError, runId }, "Failed to finalize ingestion_runs row");

  return { runId, fixturesConsidered: fixtures.length, alreadyLinked, matched, ambiguous, noCandidate };
}
