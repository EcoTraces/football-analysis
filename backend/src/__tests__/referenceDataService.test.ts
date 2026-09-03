import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { PROVIDER_KEY, providerRefKey, upsertCompetition, upsertCountryByName, upsertSeason, upsertTeam } from "../services/referenceDataService.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("providerRefKey", () => {
  it("normalizes a provider's hyphenated name into its jsonb-safe key", () => {
    expect(providerRefKey("api-football")).toBe("api_football");
    expect(providerRefKey("football-data-org")).toBe("football_data_org");
  });
});

describe("upsertCountryByName", () => {
  it("creates a country on first call and reuses it on the next", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const firstId = await upsertCountryByName(client, "England");
    const secondId = await upsertCountryByName(client, "England");

    expect(firstId).toBe(secondId);
    expect(fake.rows("countries")).toHaveLength(1);
  });

  it("treats different names as different countries", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const englandId = await upsertCountryByName(client, "England");
    const spainId = await upsertCountryByName(client, "Spain");

    expect(englandId).not.toBe(spainId);
  });
});

describe("upsertCompetition", () => {
  it("is idempotent by external id, even if the name changes", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const firstId = await upsertCompetition(client, PROVIDER_KEY, "39", "Premier League", null);
    const secondId = await upsertCompetition(client, PROVIDER_KEY, "39", "Premier League (renamed)", null);

    expect(firstId).toBe(secondId);
    expect(fake.rows("competitions")).toHaveLength(1);
  });

  it("creates separate rows for different external ids", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, PROVIDER_KEY, "39", "Premier League", null);
    const laLigaId = await upsertCompetition(client, PROVIDER_KEY, "140", "La Liga", null);

    expect(plId).not.toBe(laLigaId);
  });

  it("treats the same external id under two different provider keys as two different competitions", async () => {
    // The whole point of threading a providerKey through: api-football's
    // "39" and football-data-org's "39" are unrelated numbers that happen
    // to collide — they must never resolve to the same row.
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const apiFootballId = await upsertCompetition(client, "api_football", "39", "Premier League", null);
    const footballDataOrgId = await upsertCompetition(client, "football_data_org", "39", "Premier League", null);

    expect(apiFootballId).not.toBe(footballDataOrgId);
    expect(fake.rows("competitions")).toHaveLength(2);
  });
});

describe("upsertSeason", () => {
  it("scopes uniqueness by competition, not just the provider's season id", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, PROVIDER_KEY, "39", "Premier League", null);
    const laLigaId = await upsertCompetition(client, PROVIDER_KEY, "140", "La Liga", null);

    // Both leagues have a season externally identified as "2026" — these
    // must NOT collide into the same season row.
    const plSeasonId = await upsertSeason(client, PROVIDER_KEY, plId, "2026", "2026/2027");
    const laLigaSeasonId = await upsertSeason(client, PROVIDER_KEY, laLigaId, "2026", "2026/2027");

    expect(plSeasonId).not.toBe(laLigaSeasonId);
  });

  it("is idempotent within the same competition", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, PROVIDER_KEY, "39", "Premier League", null);
    const firstId = await upsertSeason(client, PROVIDER_KEY, plId, "2026", "2026/2027");
    const secondId = await upsertSeason(client, PROVIDER_KEY, plId, "2026", "2026/2027");

    expect(firstId).toBe(secondId);
  });
});

describe("upsertTeam", () => {
  it("is idempotent by external id", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const firstId = await upsertTeam(client, PROVIDER_KEY, "33", "Sample United", null);
    const secondId = await upsertTeam(client, PROVIDER_KEY, "33", "Sample United", null);

    expect(firstId).toBe(secondId);
    expect(fake.rows("teams")).toHaveLength(1);
  });

  it("treats the same external id under two different provider keys as two different teams", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const apiFootballId = await upsertTeam(client, "api_football", "33", "Sample United", null);
    const footballDataOrgId = await upsertTeam(client, "football_data_org", "33", "Sample United", null);

    expect(apiFootballId).not.toBe(footballDataOrgId);
    expect(fake.rows("teams")).toHaveLength(2);
  });
});
