import type { SupabaseClient } from "@supabase/supabase-js";

// Small, single-purpose lookup so fixture/match reads can enrich raw
// home_team_id/away_team_id with a real name instead of showing a UUID in
// the UI. Batched via .in() rather than one request per team.
export async function getTeamNamesById(supabase: SupabaseClient, teamIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase.from("teams").select("id, name").in("id", unique);
  if (error) throw new Error(`Failed to load team names: ${error.message}`);

  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}
