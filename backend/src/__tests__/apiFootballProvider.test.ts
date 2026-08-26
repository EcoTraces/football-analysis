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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: {} }));
    const provider = new ApiFootballProvider("test-key", "https://example.test", fetchMock as unknown as typeof fetch);

    await provider.getTeamStatistics("33", "39", "2026");

    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.pathname).toBe("/teams/statistics");
    expect(requestedUrl.searchParams.get("team")).toBe("33");
    expect(requestedUrl.searchParams.get("league")).toBe("39");
    expect(requestedUrl.searchParams.get("season")).toBe("2026");
  });
});
