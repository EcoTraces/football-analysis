import type { Logger } from "pino";
import type {
  FootballDataProvider,
  ObservableHttpProvider,
  ProviderFixture,
  ProviderFixtureStatistics,
  ProviderInjury,
  ProviderLineup,
  ProviderOdds,
  ProviderPlayerStatistics,
  ProviderResponse,
  ProviderStanding,
  ProviderTeamStatistics,
  ProviderUnavailable
} from "./types.js";

// Real provider against football-data.org's v4 REST API
// (https://docs.football-data.org/general/v4/index.html) — a SWAPPABLE
// ALTERNATIVE to ApiFootballProvider, not a second simultaneous source (see
// Data_Sources.md's "Two providers, never blended" section for why: the two
// vendors use unrelated external-id namespaces for the same real teams and
// competitions, so this platform's architecture treats exactly one
// FootballDataProvider as active at a time via FOOTBALL_DATA_PROVIDER).
//
// Chosen as the alternative because its free tier is a genuinely different
// shape of tradeoff from api-football's: no daily request cap (10/minute
// instead), and real, curated (non-crowd-sourced) data for 12 major
// competitions — but only fixtures/results/standings. There is no free-tier
// endpoint for team statistics, player statistics, injuries, lineups, odds,
// or per-fixture box-score stats (corners) — every method below for those
// capabilities returns an honest "not_configured"-style unavailable
// response, the same "never fabricate, no data no market" contract
// NullProvider already establishes, rather than a provider that silently
// can't do half of what FootballDataProvider promises.
//
// IMPORTANT: like ApiFootballProvider, this class has not been exercised
// against a live API key in this environment — every request shape and
// response mapping follows the vendor's published v4 documentation as of
// this writing (https://docs.football-data.org/general/v4/), not a
// verified live response. Treat it as implemented-but-unverified until run
// against a real key.

const DEFAULT_BASE_URL = "https://api.football-data.org/v4";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

// football-data.org's own error envelope is a flat { error: string } (or,
// per its docs, sometimes { message: string }) — a different shape from
// api-football's { response, errors } envelope, so this is a separate type,
// not a reused one.
interface FootballDataOrgErrorBody {
  error?: string;
  message?: string;
}

interface MatchesEnvelope {
  matches: RawMatch[];
}

interface StandingsEnvelope {
  standings: RawStandingsGroup[];
}

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

interface AttemptOutcome<T> {
  response: ProviderResponse<T>;
  retryable: boolean;
  retryAfterMs: number | null;
}

export class FootballDataOrgProvider implements FootballDataProvider, ObservableHttpProvider {
  readonly name = "football-data-org";
  private lastRateLimitStatus: { limit: number | null; remaining: number | null; observedAt: string } | null = null;
  private lastRequestStatus: { ok: boolean; reason?: ProviderUnavailable["reason"]; at: string } | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly timeoutMs: number = 10_000,
    private readonly logger?: Logger,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly sleepImpl: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  getRateLimitStatus() {
    return this.lastRateLimitStatus;
  }

  getLastRequestStatus() {
    return this.lastRequestStatus;
  }

  // Response headers per https://docs.football-data.org/general/v4/lookup_tables.html's
  // "Response Headers" table: X-RequestsAvailable (remaining requests before
  // being blocked) and X-RequestCounter-Reset (seconds until the counter
  // resets) — a different pair from api-football's limit+remaining, and
  // notably this vendor never reports the total limit itself, only what's
  // left. `limit` is therefore always null here — never guessed at from the
  // documented "10/minute free tier" figure, since a different plan would
  // make that wrong.
  private recordRateLimitHeaders(headers: Headers): void {
    const remainingHeader = headers.get("x-requestsavailable");
    if (remainingHeader === null) return;

    const remaining = Number(remainingHeader);
    this.lastRateLimitStatus = { limit: null, remaining: Number.isFinite(remaining) ? remaining : null, observedAt: new Date().toISOString() };

    if (Number.isFinite(remaining) && remaining <= 1) {
      this.logger?.warn({ provider: this.name, remaining }, "football-data.org rate limit nearly exhausted");
    }
  }

  private async attemptRequest<T>(path: string, params: Record<string, string>): Promise<AttemptOutcome<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const sourceTimestamp = new Date().toISOString();

    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: { "X-Auth-Token": this.apiKey },
        signal: controller.signal
      });
      this.recordRateLimitHeaders(res.headers);

      // football-data.org's documented error statuses (400/403/404/429) do
      // not include a distinct 401 — a missing or invalid token is reported
      // as 403 "restricted resource," same as a valid token lacking access
      // to a paid-tier resource. Both are mapped to "unauthorized" here,
      // matching ApiFootballProvider's own 401||403 -> unauthorized
      // handling, since retrying either on the same route never helps.
      if (res.status === 401 || res.status === 403) {
        return this.outcome(await this.unavailableFromBody(res, "unauthorized", `football-data.org rejected the request (HTTP ${res.status})`), false, null);
      }
      if (res.status === 429) {
        // Undocumented whether a Retry-After header is sent — read
        // defensively, same caveat as everything else in this file.
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null;
        return this.outcome(await this.unavailableFromBody(res, "rate_limited", "football-data.org rate limit exceeded"), true, retryAfterMs);
      }
      if (res.status >= 500) {
        return this.outcome(this.unavailable("upstream_error", `football-data.org returned HTTP ${res.status}`), true, null);
      }
      if (!res.ok) {
        // Other 4xx (400 malformed request, 404 not found) — the request
        // itself is wrong for this resource; retrying it unchanged won't help.
        return this.outcome(await this.unavailableFromBody(res, "upstream_error", `football-data.org returned HTTP ${res.status}`), false, null);
      }

      let body: T;
      try {
        body = (await res.json()) as T;
      } catch {
        return this.outcome(this.unavailable("upstream_error", "football-data.org returned a non-JSON response"), false, null);
      }

      return this.outcome({ ok: true, data: body, sourceTimestamp, provider: this.name }, false, null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return this.outcome(this.unavailable("timeout", `football-data.org request timed out after ${this.timeoutMs}ms`), true, null);
      }
      return this.outcome(this.unavailable("upstream_error", err instanceof Error ? err.message : "Unknown network error"), true, null);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Reads the vendor's { error } or { message } body for a more specific
  // failure message where possible, falling back to the generic one if the
  // body isn't JSON or doesn't have either field.
  private async unavailableFromBody(res: Response, reason: ProviderUnavailable["reason"], fallbackMessage: string): Promise<ProviderUnavailable> {
    try {
      const body = (await res.json()) as FootballDataOrgErrorBody;
      const detail = body.error ?? body.message;
      return this.unavailable(reason, detail ? `${fallbackMessage}: ${detail}` : fallbackMessage);
    } catch {
      return this.unavailable(reason, fallbackMessage);
    }
  }

  private outcome<T>(response: ProviderResponse<T>, retryable: boolean, retryAfterMs: number | null): AttemptOutcome<T> {
    return { response, retryable, retryAfterMs };
  }

  private unavailable(reason: ProviderUnavailable["reason"], message: string): ProviderUnavailable {
    return { ok: false, reason, message, provider: this.name };
  }

  // Same never-fabricate contract as NullProvider, for the capabilities
  // this vendor's free tier genuinely does not offer.
  private notOnFreeTier(capability: string): ProviderUnavailable {
    return this.unavailable(
      "not_configured",
      `football-data.org's free tier does not provide ${capability}. ` +
        "Use api-football (FOOTBALL_DATA_PROVIDER=api-football) for this data, or a paid football-data.org plan. See Data_Sources.md."
    );
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<ProviderResponse<T>> {
    const totalAttempts = this.maxRetries + 1;
    let lastOutcome: AttemptOutcome<T> | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      lastOutcome = await this.attemptRequest<T>(path, params);
      const isLastAttempt = attempt === totalAttempts;
      if (!lastOutcome.retryable || isLastAttempt) break;

      const delayMs = lastOutcome.retryAfterMs ?? this.backoffDelayMs(attempt);
      this.logger?.warn(
        {
          provider: this.name,
          path,
          attempt,
          totalAttempts,
          delayMs,
          reason: lastOutcome.response.ok ? undefined : lastOutcome.response.reason
        },
        "Retrying football-data.org request after a transient failure"
      );
      await this.sleepImpl(delayMs);
    }

    const finalResponse = lastOutcome!.response;
    this.lastRequestStatus = finalResponse.ok
      ? { ok: true, at: new Date().toISOString() }
      : { ok: false, reason: finalResponse.reason, at: new Date().toISOString() };
    return finalResponse;
  }

  private backoffDelayMs(attempt: number): number {
    const exponential = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const jitter = Math.random() * DEFAULT_RETRY_BASE_DELAY_MS;
    return exponential + jitter;
  }

  private mapFixture(raw: RawMatch): ProviderFixture | null {
    // A match missing its season's start date can't be labeled — skip
    // rather than guess (mirrors every other mapper's "skip, don't
    // fabricate" policy in this codebase).
    if (!raw.season?.startDate || !raw.season?.endDate) return null;

    return {
      externalId: String(raw.id),
      competitionExternalId: String(raw.competition.id),
      competitionName: raw.competition.name,
      countryName: raw.area?.name ?? null,
      // The season's own numeric `id` is an opaque vendor identifier that
      // is NOT the value football-data.org's /standings endpoint's
      // `season` query param expects — that param wants the season's START
      // YEAR (e.g. "2026"). Using the start year as this platform's season
      // external id too means getStandings can pass it straight through
      // with no separate id-to-year lookup, and it matches api-football's
      // own convention of using the year as its season external id.
      seasonExternalId: raw.season.startDate.slice(0, 4),
      seasonLabel: `${raw.season.startDate.slice(0, 4)}/${raw.season.endDate.slice(0, 4)}`,
      homeTeamExternalId: String(raw.homeTeam.id),
      homeTeamName: raw.homeTeam.name,
      awayTeamExternalId: String(raw.awayTeam.id),
      awayTeamName: raw.awayTeam.name,
      venueName: null, // Not part of the match resource's documented fields.
      round: raw.matchday !== undefined && raw.matchday !== null ? String(raw.matchday) : (raw.stage ?? null),
      kickoffUtc: new Date(raw.utcDate).toISOString(),
      status: mapStatus(raw.status),
      homeScore: raw.score?.fullTime?.home ?? null,
      awayScore: raw.score?.fullTime?.away ?? null,
      homeScoreHt: raw.score?.halfTime?.home ?? null,
      awayScoreHt: raw.score?.halfTime?.away ?? null
    };
  }

  // Unlike ApiFootballProvider, this vendor's /matches endpoint genuinely
  // supports a multi-day dateFrom/dateTo range in one call — no single-day
  // restriction to work around here.
  async getFixturesForDateRange(fromIso: string, toIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    const result = await this.request<MatchesEnvelope>("/matches", {
      dateFrom: fromIso.slice(0, 10),
      dateTo: toIso.slice(0, 10)
    });
    if (!result.ok) return result;
    return { ...result, data: result.data.matches.map((m) => this.mapFixture(m)).filter((f): f is ProviderFixture => f !== null) };
  }

  async getResultsSince(sinceIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    return this.getFixturesForDateRange(sinceIso, new Date().toISOString());
  }

  async getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderStanding[]>> {
    // seasonExternalId is the season's start year (see mapFixture's
    // comment) — exactly what this endpoint's own `season` query param
    // expects, so it's forwarded as-is, not translated.
    const result = await this.request<StandingsEnvelope>(`/competitions/${competitionExternalId}/standings`, {
      season: seasonExternalId
    });
    if (!result.ok) return result;

    // A competition with a split table (group stage, home groups, etc.)
    // returns multiple standings groups — flattened into one list, same
    // simplification ApiFootballProvider's mapStandings already makes for
    // api-football's equivalent case (see that file's module comment and
    // Database.md's note on standings having no "group" column).
    const rows: ProviderStanding[] = [];
    for (const group of result.data.standings) {
      for (const raw of group.table) {
        rows.push({
          teamExternalId: String(raw.team.id),
          teamName: raw.team.name,
          position: raw.position,
          played: raw.playedGames,
          wins: raw.won,
          draws: raw.draw,
          losses: raw.lost,
          goalsFor: raw.goalsFor,
          goalsAgainst: raw.goalsAgainst,
          points: raw.points,
          form: raw.form ?? null
        });
      }
    }
    return { ...result, data: rows };
  }

  async getTeamStatistics(
    _teamExternalId: string,
    _competitionExternalId: string,
    _seasonExternalId: string
  ): Promise<ProviderResponse<ProviderTeamStatistics>> {
    return this.notOnFreeTier("team-season statistics (goals/matches-played aggregates)");
  }

  async getPlayerStatistics(
    _teamExternalId: string,
    _competitionExternalId: string,
    _seasonExternalId: string
  ): Promise<ProviderResponse<ProviderPlayerStatistics[]>> {
    return this.notOnFreeTier("player statistics");
  }

  async getInjuries(_teamExternalId: string, _seasonExternalId: string): Promise<ProviderResponse<ProviderInjury[]>> {
    return this.notOnFreeTier("injury reports");
  }

  async getLineup(_fixtureExternalId: string): Promise<ProviderResponse<ProviderLineup[]>> {
    return this.notOnFreeTier("confirmed lineups");
  }

  async getOdds(_fixtureExternalId: string): Promise<ProviderResponse<ProviderOdds[]>> {
    return this.notOnFreeTier("bookmaker odds");
  }

  async getFixtureStatistics(_fixtureExternalId: string): Promise<ProviderResponse<ProviderFixtureStatistics[]>> {
    return this.notOnFreeTier("per-fixture box-score statistics (corners)");
  }
}

// Per https://docs.football-data.org/general/v4/lookup_tables.html's
// documented status enum. AWARDED (a match awarded to one side, e.g. by
// forfeit) has a real final result, so it's treated as finished, same as
// FT/AET/PEN are for api-football. SUSPENDED has no equivalent "resumed
// later" signal in this schema, so it maps to "abandoned" — the closest of
// this schema's statuses, same reasoning ApiFootballProvider's mapStatus
// uses for ABD.
function mapStatus(status: string): ProviderFixture["status"] {
  switch (status) {
    case "SCHEDULED":
    case "TIMED":
      return "scheduled";
    case "IN_PLAY":
    case "PAUSED":
    case "EXTRA_TIME":
    case "PENALTY_SHOOTOUT":
      return "live";
    case "FINISHED":
    case "AWARDED":
      return "finished";
    case "POSTPONED":
      return "postponed";
    case "CANCELLED":
      return "cancelled";
    case "SUSPENDED":
      return "abandoned";
    default:
      // Unknown status codes are treated as scheduled rather than guessed
      // into a more specific bucket — same fallback policy as
      // ApiFootballProvider.mapStatus.
      return "scheduled";
  }
}

// Shape per football-data.org v4's documented /matches response — unverified
// against a live response, same caveat as every Raw* interface in
// ApiFootballProvider.ts.
interface RawMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number | null;
  stage?: string | null;
  area?: { name?: string | null } | null;
  competition: { id: number; name: string };
  season?: { startDate?: string | null; endDate?: string | null } | null;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  score?: {
    fullTime?: { home: number | null; away: number | null } | null;
    halfTime?: { home: number | null; away: number | null } | null;
  } | null;
}

// Shape per football-data.org v4's documented /competitions/{id}/standings
// response — unverified against a live response, same caveat as above.
interface RawStandingRow {
  position: number;
  team: { id: number; name: string };
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  form?: string | null;
}

interface RawStandingsGroup {
  stage?: string | null;
  type?: string | null;
  group?: string | null;
  table: RawStandingRow[];
}
