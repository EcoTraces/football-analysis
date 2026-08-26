import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { upsertCompetition, upsertCountryByName, upsertSeason, upsertTeam } from "../services/referenceDataService.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

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

    const firstId = await upsertCompetition(client, "39", "Premier League", null);
    const secondId = await upsertCompetition(client, "39", "Premier League (renamed)", null);

    expect(firstId).toBe(secondId);
    expect(fake.rows("competitions")).toHaveLength(1);
  });

  it("creates separate rows for different external ids", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, "39", "Premier League", null);
    const laLigaId = await upsertCompetition(client, "140", "La Liga", null);

    expect(plId).not.toBe(laLigaId);
  });
});

describe("upsertSeason", () => {
  it("scopes uniqueness by competition, not just the provider's season id", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, "39", "Premier League", null);
    const laLigaId = await upsertCompetition(client, "140", "La Liga", null);

    // Both leagues have a season externally identified as "2026" — these
    // must NOT collide into the same season row.
    const plSeasonId = await upsertSeason(client, plId, "2026", "2026/2027");
    const laLigaSeasonId = await upsertSeason(client, laLigaId, "2026", "2026/2027");

    expect(plSeasonId).not.toBe(laLigaSeasonId);
  });

  it("is idempotent within the same competition", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const plId = await upsertCompetition(client, "39", "Premier League", null);
    const firstId = await upsertSeason(client, plId, "2026", "2026/2027");
    const secondId = await upsertSeason(client, plId, "2026", "2026/2027");

    expect(firstId).toBe(secondId);
  });
});

describe("upsertTeam", () => {
  it("is idempotent by external id", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const firstId = await upsertTeam(client, "33", "Sample United", null);
    const secondId = await upsertTeam(client, "33", "Sample United", null);

    expect(firstId).toBe(secondId);
    expect(fake.rows("teams")).toHaveLength(1);
  });
});
