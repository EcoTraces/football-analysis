import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FootballDataProvider, ProviderFixture, ProviderResponse } from "../providers/types.js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { matchFixturesToSecondaryProvider } from "../jobs/matchFixturesToSecondaryProvider.js";

const silentLogger = pino({ level: "silent" });

// Relative to "now" (not a fixed calendar date) so this suite never becomes
// a time bomb — matchFixturesToSecondaryProvider only considers fixtures
// within its forward-looking match window, same reasoning as this
// codebase's other windowed-job tests (e.g. syncOdds.test.ts).
const DEFAULT_KICKOFF = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days out

function makeCandidate(overrides: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    externalId: "9001",
    competitionExternalId: "39",
    competitionName: "Premier League",
    countryName: "England",
    seasonExternalId: "2026",
    seasonLabel: "2026/2027",
    homeTeamExternalId: "33",
    homeTeamName: "Arsenal",
    awayTeamExternalId: "34",
    awayTeamName: "Chelsea",
    venueName: null,
    round: null,
    kickoffUtc: DEFAULT_KICKOFF,
    status: "scheduled",
    homeScore: null,
    awayScore: null,
    homeScoreHt: null,
    awayScoreHt: null,
    ...overrides
  };
}

class FakeSecondaryProvider implements FootballDataProvider {
  readonly name = "api-football";
  constructor(private readonly candidates: ProviderFixture[] = [], private readonly fetchResult?: ProviderResponse<ProviderFixture[]>) {}

  async getFixturesForDateRange(): Promise<ProviderResponse<ProviderFixture[]>> {
    if (this.fetchResult) return this.fetchResult;
    return { ok: true, data: this.candidates, sourceTimestamp: new Date().toISOString(), provider: this.name };
  }
  async getResultsSince() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getTeamStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getInjuries() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getLineup() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getStandings() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getOdds() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getFixtureStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
  async getPlayerStatistics() {
    return { ok: false as const, reason: "not_configured" as const, message: "unused", provider: this.name };
  }
}

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function seedFixture(fake: FakeSupabase, overrides: Record<string, unknown> = {}) {
  fake.seed("teams", [
    { id: "team-home", name: "Arsenal" },
    { id: "team-away", name: "Chelsea" }
  ]);
  fake.seed("fixtures", [
    {
      id: "fx-1",
      home_team_id: "team-home",
      away_team_id: "team-away",
      external_ref: {},
      is_synthetic: false,
      status: "scheduled",
      kickoff_utc: DEFAULT_KICKOFF,
      ...overrides
    }
  ]);
}

describe("matchFixturesToSecondaryProvider", () => {
  it("links a fixture to its unique matching secondary-provider counterpart", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const secondary = new FakeSecondaryProvider([makeCandidate({ externalId: "9001" })]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.matched).toBe(1);
    expect(result.ambiguous).toBe(0);
    expect(result.noCandidate).toBe(0);
    expect(fake.rows("fixtures")[0]?.external_ref).toEqual({ api_football: "9001" });
  });

  it("does not re-fetch or re-link a fixture already carrying the secondary provider's key", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { external_ref: { api_football: "already-linked" } });
    const secondary = new FakeSecondaryProvider([makeCandidate({ externalId: "9001" })]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.alreadyLinked).toBe(1);
    expect(result.matched).toBe(0);
    // Untouched — still whatever it already was, not overwritten with a fresh match.
    expect(fake.rows("fixtures")[0]?.external_ref).toEqual({ api_football: "already-linked" });
  });

  it("leaves a fixture unmatched (never guesses) when more than one candidate qualifies", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const secondary = new FakeSecondaryProvider([
      makeCandidate({ externalId: "9001" }),
      makeCandidate({ externalId: "9002" })
    ]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(fake.rows("fixtures")[0]?.external_ref).toEqual({});
  });

  it("leaves a fixture unmatched when no candidate's team names correspond at all", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const secondary = new FakeSecondaryProvider([makeCandidate({ homeTeamName: "Liverpool", awayTeamName: "Everton" })]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.matched).toBe(0);
    expect(result.noCandidate).toBe(1);
  });

  it("distinguishes a kickoff-time mismatch (ambiguous — names matched somewhere) from no name match at all", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const secondary = new FakeSecondaryProvider([makeCandidate({ kickoffUtc: new Date(Date.parse(DEFAULT_KICKOFF) + 24 * 3600_000).toISOString() })]); // same names, 24h off

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(result.noCandidate).toBe(0);
  });

  it("preserves the primary provider's own external_ref key when adding the secondary's", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { external_ref: { football_data_org: "primary-123" } });
    const secondary = new FakeSecondaryProvider([makeCandidate({ externalId: "9001" })]);

    await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(fake.rows("fixtures")[0]?.external_ref).toEqual({ football_data_org: "primary-123", api_football: "9001" });
  });

  it("records the run as partial and skips linking (rather than crashing) when the secondary provider's fixtures fetch fails", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake);
    const secondary = new FakeSecondaryProvider([], { ok: false, reason: "upstream_error", message: "boom", provider: "api-football" });

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.matched).toBe(0);
    expect(fake.rows("ingestion_runs")[0]?.status).toBe("partial");
    expect(fake.rows("ingestion_runs")[0]?.error_summary).toContain("boom");
  });

  it("is a fast no-op recording zero matched/ambiguous/noCandidate when every fixture is already linked", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { external_ref: { api_football: "already-linked" } });
    let fetchCalled = false;
    class TrackingProvider extends FakeSecondaryProvider {
      async getFixturesForDateRange(): Promise<ProviderResponse<ProviderFixture[]>> {
        fetchCalled = true;
        return super.getFixturesForDateRange();
      }
    }
    const secondary = new TrackingProvider([makeCandidate({ externalId: "9001" })]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(fetchCalled).toBe(false); // Never even asked the secondary provider for its fixture list.
    expect(result.alreadyLinked).toBe(1);
    expect(result.fixturesConsidered).toBe(1);
  });

  it("ignores a fixture outside the match window", async () => {
    const fake = new FakeSupabase();
    seedFixture(fake, { kickoff_utc: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }); // 30 days out
    const secondary = new FakeSecondaryProvider([makeCandidate()]);

    const result = await matchFixturesToSecondaryProvider(fakeClient(fake), secondary, silentLogger);

    expect(result.fixturesConsidered).toBe(0);
  });
});
