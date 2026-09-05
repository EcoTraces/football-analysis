import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  PROVIDER_KEY,
  loadExternalRefs,
  normalizeCompetitionType,
  providerRefKey,
  upsertCompetition,
  upsertCountryByName,
  upsertPlayer,
  upsertSeason,
  upsertTeam
} from "../services/referenceDataService.js";

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

  it("stores 'cup' when the provider reports it, 'league' when it's absent or unrecognized", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    await upsertCompetition(client, PROVIDER_KEY, "1", "FA Cup", null, "CUP");
    await upsertCompetition(client, PROVIDER_KEY, "2", "Premier League", null, "LEAGUE");
    await upsertCompetition(client, PROVIDER_KEY, "3", "Some Other Competition", null, undefined);

    const rows = fake.rows("competitions");
    expect(rows.find((r) => r.name === "FA Cup")?.competition_type).toBe("cup");
    expect(rows.find((r) => r.name === "Premier League")?.competition_type).toBe("league");
    expect(rows.find((r) => r.name === "Some Other Competition")?.competition_type).toBe("league");
  });
});

describe("normalizeCompetitionType", () => {
  it("recognizes 'cup' case-insensitively", () => {
    expect(normalizeCompetitionType("cup")).toBe("cup");
    expect(normalizeCompetitionType("CUP")).toBe("cup");
    expect(normalizeCompetitionType("Cup")).toBe("cup");
  });

  it("falls back to 'league' for anything else, including undefined (api-football's fixtures never send this field)", () => {
    expect(normalizeCompetitionType("LEAGUE")).toBe("league");
    expect(normalizeCompetitionType("continental")).toBe("league");
    expect(normalizeCompetitionType(undefined)).toBe("league");
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

describe("loadExternalRefs", () => {
  it("returns every row's external_ref keyed by id, even across many ids", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);
    const ids = Array.from({ length: 250 }, (_, i) => `team-${i}`);
    fake.seed(
      "teams",
      ids.map((id) => ({ id, external_ref: { api_football: id } }))
    );

    const refs = await loadExternalRefs(client, "teams", ids);

    expect(refs.size).toBe(250);
    expect(refs.get("team-0")?.external_ref?.api_football).toBe("team-0");
    expect(refs.get("team-249")?.external_ref?.api_football).toBe("team-249");
  });

  it("splits a large id list into multiple requests rather than one unbounded .in() call", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);
    const ids = Array.from({ length: 250 }, (_, i) => `team-${i}`);
    fake.seed(
      "teams",
      ids.map((id) => ({ id, external_ref: null }))
    );
    const fromSpy = vi.spyOn(fake, "from");

    await loadExternalRefs(client, "teams", ids);

    // 250 ids at 100 per request is 3 requests, never one request carrying
    // all 250 — the behavior that protects against a PostgREST/proxy
    // request-length limit on the .in() filter's id list.
    expect(fromSpy).toHaveBeenCalledTimes(3);
  });

  it("returns an empty map without querying at all for an empty id list", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);
    const fromSpy = vi.spyOn(fake, "from");

    const refs = await loadExternalRefs(client, "teams", []);

    expect(refs.size).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

describe("upsertPlayer", () => {
  it("creates a player on first call and reuses it on the next", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const firstId = await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-a");
    const secondId = await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-a");

    expect(firstId).toBe(secondId);
    expect(fake.rows("players")).toHaveLength(1);
  });

  it("updates an existing player's team_id when a later sync reports a transfer", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);

    const id = await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-a");
    const idAfterTransfer = await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-b");

    expect(idAfterTransfer).toBe(id); // Same row — updated, not duplicated.
    expect(fake.rows("players")).toHaveLength(1);
    expect(fake.rows("players")[0]?.team_id).toBe("team-b");
  });

  it("does not issue an update when the team is unchanged", async () => {
    const fake = new FakeSupabase();
    const client = fakeClient(fake);
    await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-a");
    const fromSpy = vi.spyOn(fake, "from");

    await upsertPlayer(client, PROVIDER_KEY, "player-1", "Alex Player", "team-a");

    // Only the lookup .from("players") call — no update() call on top of it.
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });
});
