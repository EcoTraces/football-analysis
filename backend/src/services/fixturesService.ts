import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyFreshness, type Freshness } from "../lib/freshness.js";

export interface FixtureFilters {
  from?: string;
  to?: string;
  competitionId?: string;
  countryId?: string;
  teamId?: string;
  status?: string;
}

export interface FixtureSummary {
  id: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  freshness: Freshness;
  source: string;
  sourceTimestamp: string;
}

// Reads exclude synthetic dev-seed rows by default so a misconfigured
// production deployment can never surface fabricated fixtures to real users.
export async function listFixtures(
  supabase: SupabaseClient,
  filters: FixtureFilters,
  includeSynthetic = false
): Promise<FixtureSummary[]> {
  let query = supabase
    .from("fixtures")
    .select(
      "id, competition_id, home_team_id, away_team_id, kickoff_utc, status, home_score, away_score, source, source_timestamp, is_synthetic"
    )
    .order("kickoff_utc", { ascending: true });

  if (!includeSynthetic) {
    query = query.eq("is_synthetic", false);
  }
  if (filters.from) query = query.gte("kickoff_utc", filters.from);
  if (filters.to) query = query.lte("kickoff_utc", filters.to);
  if (filters.competitionId) query = query.eq("competition_id", filters.competitionId);
  if (filters.teamId) query = query.or(`home_team_id.eq.${filters.teamId},away_team_id.eq.${filters.teamId}`);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load fixtures: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    competitionId: row.competition_id as string,
    homeTeamId: row.home_team_id as string,
    awayTeamId: row.away_team_id as string,
    kickoffUtc: row.kickoff_utc as string,
    status: row.status as string,
    homeScore: row.home_score as number | null,
    awayScore: row.away_score as number | null,
    freshness: classifyFreshness(row.source_timestamp as string, "fixtures"),
    source: row.source as string,
    sourceTimestamp: row.source_timestamp as string
  }));
}

export function todayRangeUtc(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}
