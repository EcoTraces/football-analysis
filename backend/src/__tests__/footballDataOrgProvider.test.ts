import { describe, expect, it, vi } from "vitest";
import { FootballDataOrgProvider } from "../providers/FootballDataOrgProvider.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const RAW_MATCH = {
  id: 12345,
  utcDate: "2026-08-27T15:00:00Z",
  status: "SCHEDULED",
  matchday: 3,
  area: { name: "England" },
  competition: { id: 2021, name: "Premier League" },
  season: { startDate: "2026-08-01", endDate: "2027-05-31" },
  homeTeam: { id: 33, name: "Sample United" },
  awayTeam: { id: 34, name: "Sample City" },
  score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } }
};

const RAW_STANDINGS = {
  standings: [
    {
      stage: "REGULAR_SEASON",
      type: "TOTAL",
      table: [
        {
          position: 1,
          team: { id: 33, name: "Sample United" },
          playedGames: 10,
          won: 7,
          draw: 2,
          lost: 1,
          points: 23,
          goalsFor: 20,
          goalsAgainst: 8,
          form: "WWDWL"
        }
      ]
    }
  ]
};

describe("FootballDataOrgProvider", () => {
  it("maps a successful matches response into ProviderFixture[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [RAW_MATCH] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-29T23:59:59Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      externalId: "12345",
      competitionExternalId: "2021",
      competitionName: "Premier League",
      countryName: "England",
      seasonExternalId: "2026",
      seasonLabel: "2026/2027",
      homeTeamExternalId: "33",
      awayTeamExternalId: "34",
      status: "scheduled",
      round: "3"
    });
  });

  it("passes the competition's raw type through for referenceDataService.normalizeCompetitionType() to classify", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ matches: [{ ...RAW_MATCH, competition: { id: 2021, name: "FA Cup", type: "CUP" } }] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.competitionType).toBe("CUP");
  });

  it("leaves competitionType undefined when the vendor doesn't send one, rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [RAW_MATCH] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.competitionType).toBeUndefined();
  });

  it("supports a genuine multi-day dateFrom/dateTo range in one call, unlike ApiFootballProvider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-29T23:59:59Z");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get("dateFrom")).toBe("2026-08-27");
    expect(requestedUrl.searchParams.get("dateTo")).toBe("2026-08-29");
  });

  it("skips a match missing season start/end dates rather than fabricating a season label", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [{ ...RAW_MATCH, season: {} }] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("maps a finished match's full-time and half-time scores", async () => {
    const finished = { ...RAW_MATCH, status: "FINISHED", score: { fullTime: { home: 3, away: 1 }, halfTime: { home: 2, away: 0 } } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [finished] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ status: "finished", homeScore: 3, awayScore: 1, homeScoreHt: 2, awayScoreHt: 0 });
  });

  it.each([
    ["SCHEDULED", "scheduled"],
    ["TIMED", "scheduled"],
    ["IN_PLAY", "live"],
    ["PAUSED", "live"],
    ["EXTRA_TIME", "live"],
    ["PENALTY_SHOOTOUT", "live"],
    ["FINISHED", "finished"],
    ["AWARDED", "finished"],
    ["POSTPONED", "postponed"],
    ["CANCELLED", "cancelled"],
    ["SUSPENDED", "abandoned"],
    ["SOME_FUTURE_STATUS", "scheduled"]
  ])("maps vendor status %s to %s", async (vendorStatus, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [{ ...RAW_MATCH, status: vendorStatus }] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]?.status).toBe(expected);
  });

  it("sends the API key as an X-Auth-Token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
    const provider = new FootballDataOrgProvider("secret-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((options.headers as Record<string, string>)["X-Auth-Token"]).toBe("secret-key");
  });

  it("getResultsSince delegates to a dateFrom..now range", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getResultsSince("2026-08-20T00:00:00Z");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get("dateFrom")).toBe("2026-08-20");
    expect(requestedUrl.searchParams.get("dateTo")).toBe(new Date().toISOString().slice(0, 10));
  });

  it("maps HTTP 403 (missing/invalid token, per this vendor's documented error set) to reason=unauthorized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid token" }, 403));
    const provider = new FootballDataOrgProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unauthorized");
    expect(result.message).toContain("invalid token");
  });

  it("maps HTTP 429 to reason=rate_limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "too many requests" }, 429));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 0);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rate_limited");
  });

  it("retries a transient HTTP 500 up to maxRetries times, then returns upstream_error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream_error");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleepMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry an HTTP 403 — a bad token will never succeed on a retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new FootballDataOrgProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("tracks x-requests-available-minute via getRateLimitStatus(), with limit always null (the vendor never reports it)", async () => {
    // The vendor's own docs name this header "X-RequestsAvailable", but a
    // live response (verified 2026-09-03) actually sends
    // "x-requests-available-minute" — this test locks in the real header.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ matches: [] }, 200, { "x-requests-available-minute": "7" }));
    const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    expect(provider.getRateLimitStatus()).toBeNull();
    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(provider.getRateLimitStatus()).toMatchObject({ limit: null, remaining: 7 });
  });

  it("tracks the outcome of the most recent completed request via getLastRequestStatus()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    const provider = new FootballDataOrgProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 0);

    expect(provider.getLastRequestStatus()).toBeNull();
    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(provider.getLastRequestStatus()).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  describe("getStandings", () => {
    it("maps a standings response, flattening every group into one list", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(RAW_STANDINGS));
      const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

      const result = await provider.getStandings("2021", "2026");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([
        {
          teamExternalId: "33",
          teamName: "Sample United",
          position: 1,
          played: 10,
          wins: 7,
          draws: 2,
          losses: 1,
          goalsFor: 20,
          goalsAgainst: 8,
          points: 23,
          form: "WWDWL"
        }
      ]);
    });

    it("forwards the season external id as-is (the season's own start year) to the season query param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ standings: [] }));
      const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

      await provider.getStandings("2021", "2026");

      const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(requestedUrl.pathname).toBe("/competitions/2021/standings");
      expect(requestedUrl.searchParams.get("season")).toBe("2026");
    });
  });

  describe("capabilities not on the free tier", () => {
    it("returns not_configured for getTeamStatistics without making a request", async () => {
      const fetchMock = vi.fn();
      const provider = new FootballDataOrgProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

      const result = await provider.getTeamStatistics("33", "2021", "2026");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not_configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns not_configured for getPlayerStatistics, getInjuries, getLineup, getOdds, and getFixtureStatistics", async () => {
      const provider = new FootballDataOrgProvider("test-key", "https://example.test", vi.fn() as unknown as typeof fetch);

      const results = await Promise.all([
        provider.getPlayerStatistics("33", "2021", "2026"),
        provider.getInjuries("33", "2026"),
        provider.getLineup("12345"),
        provider.getOdds("12345"),
        provider.getFixtureStatistics("12345")
      ]);

      for (const result of results) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("not_configured");
      }
    });
  });
});
