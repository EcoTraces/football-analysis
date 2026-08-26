import { describe, expect, it, vi } from "vitest";
import { ApiFootballProvider } from "../providers/ApiFootballProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
  failed_to_score: { total: 3 }
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
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

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
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch, 5);

    const result = await provider.getFixturesForDateRange("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
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
      failedToScore: 3
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
});
