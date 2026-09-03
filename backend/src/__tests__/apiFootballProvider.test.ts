import { describe, expect, it, vi } from "vitest";
import { ApiFootballProvider } from "../providers/ApiFootballProvider.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const RAW_FIXTURE = {
  fixture: { id: 12345, date: "2026-08-27T15:00:00+00:00", venue: { name: "Sample Park" }, status: { short: "NS" } },
  league: { id: 39, name: "Premier League", country: "England", season: 2026, round: "Regular Season - 1" },
  teams: { home: { id: 33, name: "Sample United" }, away: { id: 34, name: "Sample City" } },
  goals: { home: null, away: null }
};

const RAW_TEAM_STATS = {
  fixtures: { played: { home: 10, away: 10, total: 20 } },
  goals: {
    for: { total: { home: 20, away: 15, total: 35 } },
    against: { total: { home: 8, away: 10, total: 18 } }
  },
  clean_sheet: { total: 7 },
  failed_to_score: { total: 3 },
  cards: {
    yellow: { "0-15": { total: 5 }, "16-30": { total: 8 }, "76-90": { total: 12 } },
    red: { "0-15": { total: 0 }, "76-90": { total: 2 } }
  }
};

describe("ApiFootballProvider", () => {
  it("maps a successful fixtures response into ProviderFixture[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [RAW_FIXTURE], results: 1 }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T23:59:59Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      externalId: "12345",
      competitionExternalId: "39",
      homeTeamExternalId: "33",
      awayTeamExternalId: "34",
      status: "scheduled"
    });

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get("date")).toBe("2026-08-27");
  });

  it("maps a finished fixture's half-time score, and null when the response has none", async () => {
    const finishedFixture = {
      ...RAW_FIXTURE,
      goals: { home: 3, away: 1 },
      score: { halftime: { home: 2, away: 0 } }
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [finishedFixture, RAW_FIXTURE], results: 2 }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T23:59:59Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ homeScoreHt: 2, awayScoreHt: 0 });
    // RAW_FIXTURE has no `score` field at all — should be null, not a crash.
    expect(result.data[1]).toMatchObject({ homeScoreHt: null, awayScoreHt: null });
  });

  it("sends the API key as an x-apisports-key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("secret-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((options.headers as Record<string, string>)["x-apisports-key"]).toBe("secret-key");
  });

  it("rejects a multi-day range rather than silently returning one day's data", async () => {
    const fetchMock = vi.fn();
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-29T00:00:00Z");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps HTTP 401 to reason=unauthorized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const provider = new ApiFootballProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unauthorized");
  });

  it("maps HTTP 429 to reason=rate_limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    // maxRetries: 0 — this test is about status mapping, not retry behavior
    // (429 is retryable by default; see the dedicated retry tests below).
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 0);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rate_limited");
  });

  it("maps a 200 response carrying an `errors.token` body to reason=unauthorized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [], errors: { token: "Invalid API key" } }));
    const provider = new ApiFootballProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unauthorized");
    expect(result.message).toContain("Invalid API key");
  });

  it("maps a fetch abort to reason=timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    // maxRetries: 0 — this test is about status mapping, not retry behavior
    // (timeouts are retryable by default; see the dedicated retry tests below).
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 5, undefined, 0);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
  });

  it("retries a transient HTTP 500 up to maxRetries times, then returns upstream_error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream_error");
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(sleepMock).toHaveBeenCalledTimes(3);
  });

  it("recovers if a transient failure is followed by a successful attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ response: [RAW_FIXTURE], results: 1 }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an HTTP 401 — a bad key will never succeed on a retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new ApiFootballProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("does NOT retry a body-level vendor error (e.g. an invalid league id)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [], errors: { league: "Invalid league id" } }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a 429 response's Retry-After header instead of the default backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "7" }))
      .mockResolvedValueOnce(jsonResponse({ response: [], results: 0 }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 3, sleepMock);

    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(sleepMock).toHaveBeenCalledWith(7000);
  });

  it("tracks the last-seen rate-limit headers via getRateLimitStatus()", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ response: [], results: 0 }, 200, { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "42" }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    expect(provider.getRateLimitStatus()).toBeNull();
    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(provider.getRateLimitStatus()).toMatchObject({ limit: 100, remaining: 42 });
  });

  it("tracks the outcome of the most recent completed request via getLastRequestStatus()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const provider = new ApiFootballProvider("bad-key", "https://example.test", fetchMock as unknown as typeof fetch, 10_000, undefined, 0);

    expect(provider.getLastRequestStatus()).toBeNull();
    await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(provider.getLastRequestStatus()).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("maps a non-JSON body to reason=upstream_error instead of throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream_error");
  });

  it("passes team/league/season params through for team statistics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: RAW_TEAM_STATS }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getTeamStatistics("33", "39", "2026");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/teams/statistics");
    expect(requestedUrl.searchParams.get("team")).toBe("33");
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2026");
  });

  it("maps a well-formed team statistics response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: RAW_TEAM_STATS }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getTeamStatistics("33", "39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      matchesPlayed: 20,
      matchesPlayedHome: 10,
      matchesPlayedAway: 10,
      goalsFor: 35,
      goalsForHome: 20,
      goalsForAway: 15,
      goalsAgainst: 18,
      goalsAgainstHome: 8,
      goalsAgainstAway: 10,
      cleanSheets: 7,
      failedToScore: 3,
      yellowCards: 25,
      redCards: 2
    });
  });

  it("treats a team statistics response missing the required fields as upstream_error, not zeros", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: {} }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getTeamStatistics("33", "39", "2026");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream_error");
  });

  it("treats a team statistics response missing cards as yellowCards/redCards: null, not a failure of the whole response", async () => {
    const withoutCards: Record<string, unknown> = { ...RAW_TEAM_STATS };
    delete withoutCards.cards;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: withoutCards }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getTeamStatistics("33", "39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.yellowCards).toBeNull();
    expect(result.data.redCards).toBeNull();
  });

  it("maps a well-formed player statistics response, picking the stint matching the requested competition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            player: { id: 276, name: "Sample Striker" },
            statistics: [
              // Same team, two different competitions — the mapping must
              // pick the one matching the requested league id (39), not
              // just statistics[0].
              { team: { id: 33 }, league: { id: 2 }, games: { appearences: 6, minutes: 400 }, goals: { total: 3 } },
              { team: { id: 33 }, league: { id: 39 }, games: { appearences: 18, minutes: 1500 }, goals: { total: 12 } }
            ]
          },
          {
            player: { id: 277, name: "Bench Player" },
            statistics: [{ team: { id: 33 }, league: { id: 39 }, games: { appearences: 2, minutes: 45 }, goals: { total: 0 } }]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getPlayerStatistics("33", "39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { playerExternalId: "276", playerName: "Sample Striker", matchesPlayed: 18, goalsScored: 12, minutesPlayed: 1500 },
      { playerExternalId: "277", playerName: "Bench Player", matchesPlayed: 2, goalsScored: 0, minutesPlayed: 45 }
    ]);
  });

  it("falls back to the first stint when none matches the requested competition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            player: { id: 276, name: "Sample Striker" },
            statistics: [{ team: { id: 33 }, league: { id: 2 }, games: { appearences: 6, minutes: 400 }, goals: { total: 3 } }]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getPlayerStatistics("33", "39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { playerExternalId: "276", playerName: "Sample Striker", matchesPlayed: 6, goalsScored: 3, minutesPlayed: 400 }
    ]);
  });

  it("skips a player entry missing an id/name, or with no statistics at all, rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          { statistics: [{ team: { id: 33 }, league: { id: 39 }, games: { appearences: 1 }, goals: { total: 0 } }] }, // no player
          { player: { id: 278, name: "No Stats Player" }, statistics: [] }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getPlayerStatistics("33", "39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("passes team/league/season params through for player statistics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getPlayerStatistics("33", "39", "2026");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/players");
    expect(requestedUrl.searchParams.get("team")).toBe("33");
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2026");
  });

  it("maps a well-formed injuries response, classifying status from free-text fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            player: { id: 501, name: "Sample Striker", type: "Missing Fixture", reason: "Knee Injury" },
            fixture: { date: "2026-08-20T15:00:00+00:00" }
          },
          {
            player: { id: 502, name: "Sample Midfielder", type: "Suspended", reason: "Red Card" },
            fixture: { date: "2026-08-21T15:00:00+00:00" }
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getInjuries("33", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        playerExternalId: "501",
        playerName: "Sample Striker",
        status: "injured",
        description: "Knee Injury",
        reportedForFixtureUtc: "2026-08-20T15:00:00.000Z"
      },
      {
        playerExternalId: "502",
        playerName: "Sample Midfielder",
        status: "suspended",
        description: "Red Card",
        reportedForFixtureUtc: "2026-08-21T15:00:00.000Z"
      }
    ]);
  });

  it("skips an injury entry missing a player id, name, or fixture date rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          { player: { id: 501, name: "Sample Striker" }, fixture: {} }, // no fixture date
          { player: { name: "No Id Player" }, fixture: { date: "2026-08-20T15:00:00+00:00" } } // no player id
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getInjuries("33", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("passes team/season params through for injuries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getInjuries("33", "2026");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/injuries");
    expect(requestedUrl.searchParams.get("team")).toBe("33");
    expect(requestedUrl.searchParams.get("season")).toBe("2026");
  });

  it("maps a well-formed standings response, flattening a single group", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            league: {
              standings: [
                [
                  {
                    rank: 1,
                    team: { id: 33, name: "Sample United" },
                    points: 45,
                    form: "WWDLW",
                    all: { played: 20, win: 14, draw: 3, lose: 3, goals: { for: 40, against: 20 } }
                  },
                  {
                    rank: 2,
                    team: { id: 34, name: "Sample City" },
                    points: 40,
                    form: "WDWWL",
                    all: { played: 20, win: 12, draw: 4, lose: 4, goals: { for: 38, against: 22 } }
                  }
                ]
              ]
            }
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getStandings("39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        teamExternalId: "33",
        teamName: "Sample United",
        position: 1,
        played: 20,
        wins: 14,
        draws: 3,
        losses: 3,
        goalsFor: 40,
        goalsAgainst: 20,
        points: 45,
        form: "WWDLW"
      },
      {
        teamExternalId: "34",
        teamName: "Sample City",
        position: 2,
        played: 20,
        wins: 12,
        draws: 4,
        losses: 4,
        goalsFor: 38,
        goalsAgainst: 22,
        points: 40,
        form: "WDWWL"
      }
    ]);
  });

  it("flattens multiple standings groups (e.g. group-stage tables) into one list", async () => {
    const row = (rank: number, teamId: number) => ({
      rank,
      team: { id: teamId, name: `Team ${teamId}` },
      points: 10,
      form: null,
      all: { played: 5, win: 3, draw: 1, lose: 1, goals: { for: 10, against: 5 } }
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [{ league: { standings: [[row(1, 1)], [row(1, 2)]] } }]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getStandings("2", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.map((r) => r.teamExternalId)).toEqual(["1", "2"]);
  });

  it("skips a standings row missing required fields rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            league: {
              standings: [
                [
                  { rank: 1, team: { id: 33, name: "Sample United" } } // no points/all
                ]
              ]
            }
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getStandings("39", "2026");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("passes league/season params through for standings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getStandings("39", "2026");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/standings");
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2026");
  });

  it("maps a well-formed lineups response with both teams", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            team: { id: 33, name: "Sample United" },
            formation: "4-3-3",
            startXI: [{ player: { id: 1, name: "Keeper One" } }, { player: { id: 2, name: "Defender One" } }],
            substitutes: [{ player: { id: 12, name: "Sub One" } }]
          },
          {
            team: { id: 34, name: "Sample City" },
            formation: "4-4-2",
            startXI: [{ player: { id: 501, name: "Keeper Two" } }],
            substitutes: []
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getLineup("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        teamExternalId: "33",
        teamName: "Sample United",
        formation: "4-3-3",
        startingPlayers: [
          { externalId: "1", name: "Keeper One" },
          { externalId: "2", name: "Defender One" }
        ],
        substitutePlayers: [{ externalId: "12", name: "Sub One" }]
      },
      {
        teamExternalId: "34",
        teamName: "Sample City",
        formation: "4-4-2",
        startingPlayers: [{ externalId: "501", name: "Keeper Two" }],
        substitutePlayers: []
      }
    ]);
  });

  it("treats an empty lineups response as valid (not yet released), not an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getLineup("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("skips a lineup entry missing team id/name, and skips individual malformed player entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          { formation: "4-3-3", startXI: [], substitutes: [] }, // no team
          {
            team: { id: 34, name: "Sample City" },
            formation: "4-4-2",
            startXI: [{ player: { id: 501, name: "Keeper Two" } }, { player: { name: "No Id Player" } }],
            substitutes: null
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getLineup("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        teamExternalId: "34",
        teamName: "Sample City",
        formation: "4-4-2",
        startingPlayers: [{ externalId: "501", name: "Keeper Two" }],
        substitutePlayers: []
      }
    ]);
  });

  it("passes the fixture param through for lineups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getLineup("12345");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/fixtures/lineups");
    expect(requestedUrl.searchParams.get("fixture")).toBe("12345");
  });

  it("maps a well-formed fixture statistics response, extracting only corner kicks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            team: { id: 33, name: "Sample United" },
            statistics: [
              { type: "Shots on Goal", value: 5 },
              { type: "Corner Kicks", value: 7 },
              { type: "Ball Possession", value: "55%" }
            ]
          },
          {
            team: { id: 34, name: "Sample City" },
            statistics: [{ type: "Corner Kicks", value: 3 }]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixtureStatistics("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { teamExternalId: "33", corners: 7 },
      { teamExternalId: "34", corners: 3 }
    ]);
  });

  it("maps a missing or non-numeric corners value to null rather than 0 or a crash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          { team: { id: 33 }, statistics: [{ type: "Shots on Goal", value: 5 }] }, // no Corner Kicks entry at all
          { team: { id: 34 }, statistics: [{ type: "Corner Kicks", value: null }] }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixtureStatistics("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { teamExternalId: "33", corners: null },
      { teamExternalId: "34", corners: null }
    ]);
  });

  it("skips a fixture statistics entry missing a team id rather than guessing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ response: [{ statistics: [{ type: "Corner Kicks", value: 7 }] }] })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getFixtureStatistics("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("passes the fixture param through for fixture statistics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getFixtureStatistics("12345");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/fixtures/statistics");
    expect(requestedUrl.searchParams.get("fixture")).toBe("12345");
  });

  it("maps a well-formed odds response, extracting only the covered markets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            bookmakers: [
              {
                name: "Bet365",
                bets: [
                  {
                    name: "Match Winner",
                    values: [
                      { value: "Home", odd: "1.85" },
                      { value: "Draw", odd: "3.60" },
                      { value: "Away", odd: "4.20" }
                    ]
                  },
                  {
                    name: "Both Teams Score",
                    values: [
                      { value: "Yes", odd: "1.75" },
                      { value: "No", odd: "2.05" }
                    ]
                  },
                  {
                    name: "Goals Over/Under",
                    values: [
                      { value: "Over 1.5", odd: "1.20" },
                      { value: "Over 2.5", odd: "1.90" },
                      { value: "Under 2.5", odd: "1.90" }
                    ]
                  },
                  {
                    name: "Asian Handicap",
                    values: [{ value: "Home -1", odd: "2.10" }]
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getOdds("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        bookmaker: "Bet365",
        selections: [
          { market: "1x2", selection: "home", decimalOdds: 1.85 },
          { market: "1x2", selection: "draw", decimalOdds: 3.6 },
          { market: "1x2", selection: "away", decimalOdds: 4.2 },
          { market: "btts", selection: "yes", decimalOdds: 1.75 },
          { market: "btts", selection: "no", decimalOdds: 2.05 },
          { market: "over_under_2_5", selection: "over", decimalOdds: 1.9 },
          { market: "over_under_2_5", selection: "under", decimalOdds: 1.9 }
        ]
      }
    ]);
    // The 1.5 line and the Asian Handicap market are read but not stored —
    // only 1x2/btts/over_under_2.5 (the markets the prediction engine covers).
  });

  it("drops a bookmaker with no odds in a covered market rather than storing an empty entry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            bookmakers: [
              { name: "Only Exotic Markets", bets: [{ name: "Asian Handicap", values: [{ value: "Home -1", odd: "2.10" }] }] }
            ]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getOdds("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("drops an odds value that isn't a valid decimal price (>1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: [
          {
            bookmakers: [
              {
                name: "Bet365",
                bets: [
                  {
                    name: "Match Winner",
                    values: [
                      { value: "Home", odd: "not-a-number" },
                      { value: "Draw", odd: "0.5" }, // invalid: must be > 1
                      { value: "Away", odd: "4.20" }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    const result = await provider.getOdds("12345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { bookmaker: "Bet365", selections: [{ market: "1x2", selection: "away", decimalOdds: 4.2 }] }
    ]);
  });

  it("passes the fixture param through for odds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [] }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getOdds("12345");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/odds");
    expect(requestedUrl.searchParams.get("fixture")).toBe("12345");
  });

  describe("RapidAPI backup channel", () => {
    // Every test here configures a distinct rapidApiBaseUrl
    // ("https://backup.example.test") so assertions on which URL was
    // actually hit are unambiguous versus the primary's
    // "https://example.test".

    it("never touches the backup route when the primary succeeds, even if a backup key is configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: [RAW_FIXTURE], results: 1 }));
      const provider = new ApiFootballProvider(
        "primary-key",
        "https://example.test",
        fetchMock as unknown as typeof fetch,
        10_000,
        undefined,
        0,
        undefined,
        "rapidapi-key",
        "https://backup.example.test"
      );

      const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new URL(fetchMock.mock.calls[0]![0] as string).origin).toBe("https://example.test");
    });

    it("falls back to the RapidAPI backup, with its own headers, after the primary is rejected (401)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({ response: [RAW_FIXTURE], results: 1 }));
      const provider = new ApiFootballProvider(
        "bad-primary-key",
        "https://example.test",
        fetchMock as unknown as typeof fetch,
        10_000,
        undefined,
        0,
        undefined,
        "good-rapidapi-key",
        "https://backup.example.test",
        "api-football-v1.p.rapidapi.com"
      );

      const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const primaryCallUrl = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(primaryCallUrl.origin).toBe("https://example.test");
      const primaryHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(primaryHeaders["x-apisports-key"]).toBe("bad-primary-key");

      const backupCallUrl = new URL(fetchMock.mock.calls[1]![0] as string);
      expect(backupCallUrl.origin).toBe("https://backup.example.test");
      const backupHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
      expect(backupHeaders["x-rapidapi-key"]).toBe("good-rapidapi-key");
      expect(backupHeaders["x-rapidapi-host"]).toBe("api-football-v1.p.rapidapi.com");

      expect(provider.getLastRequestStatus()).toMatchObject({ ok: true, route: "backup" });
    });

    it("falls back to the backup after the primary's own retries are exhausted on a transient failure (HTTP 500)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({ response: [], results: 0 }));
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const provider = new ApiFootballProvider(
        "primary-key",
        "https://example.test",
        fetchMock as unknown as typeof fetch,
        10_000,
        undefined,
        0, // maxRetries=0 on the primary route — it fails after exactly 1 attempt, then falls over
        sleepMock,
        "rapidapi-key",
        "https://backup.example.test"
      );

      const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(fetchMock.mock.calls[1]![0] as string).origin).toBe("https://backup.example.test");
    });

    it("returns the backup's own failure reason when both routes fail", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 429));
      const provider = new ApiFootballProvider(
        "primary-key",
        "https://example.test",
        fetchMock as unknown as typeof fetch,
        10_000,
        undefined,
        0,
        undefined,
        "rapidapi-key",
        "https://backup.example.test"
      );

      const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("rate_limited");
      expect(fetchMock).toHaveBeenCalledTimes(2); // 1 primary attempt + 1 backup attempt
      expect(provider.getLastRequestStatus()).toMatchObject({ ok: false, reason: "rate_limited", route: "backup" });
    });

    it("tags getRateLimitStatus() with which route the observation came from", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(
          jsonResponse({ response: [], results: 0 }, 200, { "x-ratelimit-requests-limit": "50", "x-ratelimit-requests-remaining": "10" })
        );
      const provider = new ApiFootballProvider(
        "bad-primary-key",
        "https://example.test",
        fetchMock as unknown as typeof fetch,
        10_000,
        undefined,
        0,
        undefined,
        "rapidapi-key",
        "https://backup.example.test"
      );

      await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

      expect(provider.getRateLimitStatus()).toMatchObject({ limit: 50, remaining: 10, route: "backup" });
    });
  });
});
