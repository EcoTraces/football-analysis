import type { SupabaseClient } from "@supabase/supabase-js";

export const PROVIDER_KEY = "api_football";

// Find-then-insert rather than a Postgres upsert-on-conflict: the uniqueness
// constraints here are partial unique indexes over a jsonb expression
// (external_ref->>'api_football'), and PostgREST's on_conflict parameter is
// documented for plain column lists — relying on it matching an expression
// index isn't something this repo can verify without a live database, so
// this takes the safer, portable two-round-trip route. Known trade-off: a
// race between two concurrent sync runs could both insert the same
// external id. Fine for a single periodic job; revisit if ingestion is ever
// parallelized (see Task.md).
async function findOrCreateByExternalRef(
  supabase: SupabaseClient,
  table: string,
  externalId: string,
  insertPayload: Record<string, unknown>
): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from(table)
    .select("id")
    .eq(`external_ref->>${PROVIDER_KEY}`, externalId)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up ${table} by external ref ${externalId}: ${findError.message}`);
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from(table)
    .insert({ ...insertPayload, external_ref: { [PROVIDER_KEY]: externalId } })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to create ${table} for external ref ${externalId}: ${insertError.message}`);
  return created.id as string;
}

// Countries have no stable external id from the fixtures endpoint (it only
// gives a name, e.g. "England" or "World" for continental competitions) —
// matched/created by name, not external_ref. See migration 0002's comment
// on uq_countries_external_api_football for the future dedicated sync.
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
  externalId: string,
  name: string,
  countryId: string | null
): Promise<string> {
  return findOrCreateByExternalRef(supabase, "competitions", externalId, {
    name,
    country_id: countryId,
    competition_type: "league" // API-Football distinguishes league/cup via a separate field this MVP doesn't map yet — see Task.md
  });
}

export async function upsertSeason(
  supabase: SupabaseClient,
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
    .eq(`external_ref->>${PROVIDER_KEY}`, externalId)
    .maybeSingle();
  if (findError) throw new Error(`Failed to look up season ${externalId} for competition ${competitionId}: ${findError.message}`);
  if (existing) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from("seasons")
    .insert({ competition_id: competitionId, label, external_ref: { [PROVIDER_KEY]: externalId } })
    .select("id")
    .single();
  if (insertError) throw new Error(`Failed to create season ${externalId} for competition ${competitionId}: ${insertError.message}`);
  return created.id as string;
}

export async function upsertTeam(
  supabase: SupabaseClient,
  externalId: string,
  name: string,
  countryId: string | null
): Promise<string> {
  return findOrCreateByExternalRef(supabase, "teams", externalId, { name, country_id: countryId });
}
