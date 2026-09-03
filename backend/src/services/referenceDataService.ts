import type { SupabaseClient } from "@supabase/supabase-js";

// The canonical external_ref jsonb key for api-football — matches the
// literal string baked into 0002/0003's partial unique indexes
// (external_ref->>'api_football'), so this constant must never change.
export const PROVIDER_KEY = "api_football";

// Every provider gets its own external_ref jsonb key, derived from its
// FootballDataProvider.name (e.g. "api-football" -> "api_football",
// "football-data-org" -> "football_data_org") so two providers' entity ids
// for the same real-world team/competition never collide or overwrite each
// other — each provider's sync jobs only ever look up/write their own key.
// This is why football-data.org is a SWAPPABLE alternative, not a second
// simultaneous source for the same rows (see Data_Sources.md): nothing
// resolves "api-football's team 33" and "football-data-org's team 66" as
// the same real Manchester United, so switching the active provider starts
// fresh entity rows rather than merging into the existing ones.
export function providerRefKey(providerName: string): string {
  return providerName.replace(/-/g, "_");
}

export interface RefRow {
  id: string;
  external_ref: Record<string, string> | null;
}

// Reads a row's external id for one specific provider, or null if it
// doesn't have one yet (e.g. created by a different provider, or before
// external_ref existed).
export function externalId(row: RefRow | undefined, providerKey: string): string | null {
  const value = row?.external_ref?.[providerKey];
  return typeof value === "string" ? value : null;
}

// Batches an external-id lookup for a set of internal ids in one query
// instead of one row at a time — used by every sync job that needs to turn
// internal UUIDs back into the provider's own ids before calling it. Not
// provider-scoped itself (returns the whole external_ref object) — callers
// extract their own provider's id via externalId(row, providerKey).
export async function loadExternalRefs(supabase: SupabaseClient, table: string, ids: string[]): Promise<Map<string, RefRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from(table).select("id, external_ref").in("id", ids);
  if (error) throw new Error(`Failed to load ${table} external refs: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.id as string, row as RefRow]));
}

// Find-then-insert rather than a Postgres upsert-on-conflict: the uniqueness
// constraints here are partial unique indexes over a jsonb expression
// (external_ref->>'<provider_key>'), and PostgREST's on_conflict parameter is
// documented for plain column lists — relying on it matching an expression
// index isn't something this repo can verify without a live database, so
// this takes the safer, portable two-round-trip route. Known trade-off: a
// race between two concurrent sync runs could both insert the same
// external id. Fine for a single periodic job; revisit if ingestion is ever
// parallelized (see Task.md).
async function findOrCreateByExternalRef(
  supabase: SupabaseClient,
  table: string,
  providerKey: string,
  externalId: string,
  insertPayload: Record<string, unknown>
): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from(table)
    .select("id")
    .eq(`external_ref->>${providerKey}`, externalId)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up ${table} by external ref ${externalId}: ${findError.message}`);
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from(table)
    .insert({ ...insertPayload, external_ref: { [providerKey]: externalId } })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to create ${table} for external ref ${externalId}: ${insertError.message}`);
  return created.id as string;
}

// Countries have no stable external id from the fixtures endpoint (it only
// gives a name, e.g. "England" or "World" for continental competitions) —
// matched/created by name, not external_ref, for every provider alike. See
// migration 0002's comment on uq_countries_external_api_football for the
// future dedicated sync.
export async function upsertCountryByName(supabase: SupabaseClient, name: string): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from("countries")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up country "${name}": ${findError.message}`);
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from("countries")
    .insert({ name })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to create country "${name}": ${insertError.message}`);
  return created.id as string;
}

export async function upsertCompetition(
  supabase: SupabaseClient,
  providerKey: string,
  externalId: string,
  name: string,
  countryId: string | null
): Promise<string> {
  return findOrCreateByExternalRef(supabase, "competitions", providerKey, externalId, {
    name,
    country_id: countryId,
    competition_type: "league" // API-Football distinguishes league/cup via a separate field this MVP doesn't map yet — see Task.md
  });
}

export async function upsertSeason(
  supabase: SupabaseClient,
  providerKey: string,
  competitionId: string,
  externalId: string,
  label: string
): Promise<string> {
  // Scoped by competition_id — see migration 0002's comment: a season's
  // provider id ("2026") repeats across every competition.
  const { data: existing, error: findError } = await supabase
    .from("seasons")
    .select("id")
    .eq("competition_id", competitionId)
    .eq(`external_ref->>${providerKey}`, externalId)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up season ${externalId} for competition ${competitionId}: ${findError.message}`);
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from("seasons")
    .insert({ competition_id: competitionId, label, external_ref: { [providerKey]: externalId } })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to create season ${externalId} for competition ${competitionId}: ${insertError.message}`);
  return created.id as string;
}

export async function upsertTeam(
  supabase: SupabaseClient,
  providerKey: string,
  externalId: string,
  name: string,
  countryId: string | null
): Promise<string> {
  return findOrCreateByExternalRef(supabase, "teams", providerKey, externalId, { name, country_id: countryId });
}

export async function upsertPlayer(
  supabase: SupabaseClient,
  providerKey: string,
  externalId: string,
  name: string,
  teamId: string | null
): Promise<string> {
  return findOrCreateByExternalRef(supabase, "players", providerKey, externalId, { name, team_id: teamId });
}
