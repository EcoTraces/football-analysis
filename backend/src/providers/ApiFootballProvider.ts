import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderResponse,
  ProviderUnavailable
} from "./types.js";

// Real provider against api-sports.io's "API-Football" v3 REST API
// (https://www.api-football.com/documentation-v3). Chosen for its broad
// coverage outside Europe's top five leagues, which the platform's stated
// scope (Asia, South America, etc. — see PRD.md) needs eventually.
//
// IMPORTANT: this class has not been exercised against a live API key in
// this environment (none was available) — every request-shape and
// response-mapping decision below follows the vendor's published v3
// documentation as of this writing, not a verified live response. Treat it
// as implemented-but-unverified until it's run against a real key, and
// expect to adjust field mappings if the vendor's actual response differs
// from the documented contract. Unit tests cover the mapping and error
// handling using injected fake HTTP responses, not live calls.
//
// Auth: a single `x-apisports-key` header (the direct api-sports.io auth
// scheme). If routing through RapidAPI instead, swap the header for
// `x-rapidapi-key`/`x-rapidapi-host` — see api-football.com's docs for both
// options.

const DEFAULT_BASE_URL = "https://v3.football.api-sports.io";

interface ApiFootballEnvelope<T> {
  response: T;
  errors?: Record<string, string> | unknown[];
  results?: number;
}

type FetchFn = typeof fetch;

export class ApiFootballProvider implements FootballDataProvider {
  readonly name = "api-football";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly timeoutMs: number = 10_000
  ) {}

  private async request<T>(path: string, params: Record<string, string>): Promise<ProviderResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const sourceTimestamp = new Date().toISOString();

    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: { "x-apisports-key": this.apiKey },
        signal: controller.signal
      });

      if (res.status === 401 || res.status === 403) {
        return this.unavailable("unauthorized", `API-Football rejected the request (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        return this.unavailable("rate_limited", "API-Football rate limit exceeded");
      }
      if (!res.ok) {
        return this.unavailable("upstream_error", `API-Football returned HTTP ${res.status}`);
      }

      let body: ApiFootballEnvelope<T>;
      try {
        body = (await res.json()) as ApiFootballEnvelope<T>;
      } catch {
        return this.unavailable("upstream_error", "API-Football returned a non-JSON response");
      }

      // API-Football returns HTTP 200 even for an invalid key or bad
      // params, reporting the problem in `errors` instead.
      if (body.errors && !Array.isArray(body.errors) && Object.keys(body.errors).length > 0) {
        const message = Object.values(body.errors).join("; ");
        const reason = /token|key|plan/i.test(message) ? "unauthorized" : "upstream_error";
        return this.unavailable(reason, `API-Football error: ${message}`);
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        return this.unavailable("upstream_error", `API-Football error: ${JSON.stringify(body.errors)}`);
      }

      return { ok: true, data: body.response, sourceTimestamp, provider: this.name };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return this.unavailable("timeout", `API-Football request timed out after ${this.timeoutMs}ms`);
      }
      return this.unavailable("upstream_error", err instanceof Error ? err.message : "Unknown network error");
    } finally {
      clearTimeout(timeout);
    }
  }

  private unavailable(reason: ProviderUnavailable["reason"], message: string): ProviderUnavailable {
    return { ok: false, reason, message, provider: this.name };
  }

  private mapFixture(raw: RawFixture): ProviderFixture {
    return {
      externalId: String(raw.fixture.id),
      competitionExternalId: String(raw.league.id),
      competitionName: raw.league.name,
      countryName: raw.league.country ?? null,
      seasonExternalId: String(raw.league.season),
      seasonLabel: String(raw.league.season),
      homeTeamExternalId: String(raw.teams.home.id),
      homeTeamName: raw.teams.home.name,
      awayTeamExternalId: String(raw.teams.away.id),
      awayTeamName: raw.teams.away.name,
      venueName: raw.fixture.venue?.name ?? null,
      round: raw.league.round ?? null,
      kickoffUtc: new Date(raw.fixture.date).toISOString(),
      status: mapStatus(raw.fixture.status?.short),
      homeScore: raw.goals?.home ?? null,
      awayScore: raw.goals?.away ?? null
    };
  }

  async getFixturesForDateRange(fromIso: string, toIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    // API-Football's /fixtures endpoint takes a single `date`, not a range —
    // callers wanting a range (e.g. "today") should pass a one-day window;
    // multi-day ranges are the caller's job to split (see syncFixtures.ts).
    const date = fromIso.slice(0, 10);
    if (date !== toIso.slice(0, 10)) {
      return this.unavailable(
        "upstream_error",
        "ApiFootballProvider.getFixturesForDateRange only supports a single UTC day per call; " +
          "the caller must loop over multi-day ranges (see syncFixtures.ts)."
      );
    }

    const result = await this.request<RawFixture[]>("/fixtures", { date, timezone: "UTC" });
    if (!result.ok) return result;
    return { ...result, data: result.data.map((f) => this.mapFixture(f)) };
  }

  async getResultsSince(sinceIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    // Same single-day constraint as above; "since" here means "that day's
    // finished fixtures," left to the caller to iterate across days.
    return this.getFixturesForDateRange(sinceIso, sinceIso);
  }

  async getTeamStatistics(
    teamExternalId: string,
    competitionExternalId: string,
    seasonExternalId: string
  ): Promise<ProviderResponse<unknown>> {
    return this.request("/teams/statistics", {
      team: teamExternalId,
      league: competitionExternalId,
      season: seasonExternalId
    });
  }

  async getInjuries(teamExternalId: string, seasonExternalId: string): Promise<ProviderResponse<unknown[]>> {
    return this.request<unknown[]>("/injuries", { team: teamExternalId, season: seasonExternalId });
  }

  async getLineup(fixtureExternalId: string): Promise<ProviderResponse<unknown>> {
    return this.request("/fixtures/lineups", { fixture: fixtureExternalId });
  }

  async getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<unknown[]>> {
    return this.request<unknown[]>("/standings", { league: competitionExternalId, season: seasonExternalId });
  }
}

function mapStatus(short: string | undefined): ProviderFixture["status"] {
  switch (short) {
    case "NS":
    case "TBD":
      return "scheduled";
    case "1H":
    case "2H":
    case "HT":
    case "ET":
    case "P":
    case "LIVE":
    case "BT":
      return "live";
    case "FT":
    case "AET":
    case "PEN":
      return "finished";
    case "PST":
      return "postponed";
    case "CANC":
    case "WO":
      return "cancelled";
    case "ABD":
    case "AWD":
      return "abandoned";
    default:
      // Unknown status codes are treated as scheduled rather than guessed
      // into a more specific bucket — see data_quality_flags for tracking
      // unmapped statuses in production once ingestion is live.
      return "scheduled";
  }
}

interface RawFixture {
  fixture: {
    id: number;
    date: string;
    venue?: { name?: string | null } | null;
    status?: { short?: string };
  };
  league: {
    id: number;
    name: string;
    country?: string | null;
    season: number;
    round?: string | null;
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals?: { home: number | null; away: number | null };
}
