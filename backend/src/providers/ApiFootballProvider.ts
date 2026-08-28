import type { Logger } from "pino";
import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderFixtureStatistics,
  ProviderInjury,
  ProviderLineup,
  ProviderLineupPlayer,
  ProviderOdds,
  ProviderOddsSelection,
  ProviderResponse,
  ProviderStanding,
  ProviderTeamStatistics,
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
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

interface ApiFootballEnvelope<T> {
  response: T;
  errors?: Record<string, string> | unknown[];
  results?: number;
}

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

// Last-observed rate-limit status from API-Football's response headers, so a
// health/monitoring endpoint can report it without this class needing to
// know anything about HTTP routes. api-sports.io's direct API documents
// `x-ratelimit-requests-limit`/`x-ratelimit-requests-remaining` (a daily
// quota); routing through RapidAPI instead uses `X-RateLimit-Requests-Limit`/
// `X-RateLimit-Requests-Remaining` for the same quota, plus a separate
// per-minute `X-RateLimit-Limit`/`X-RateLimit-Remaining` pair. Header names
// are read defensively (case-insensitive via the Headers API, first match
// wins) since — like every other mapping in this file — none of this has
// been confirmed against a live response yet.
export interface RateLimitStatus {
  limit: number | null;
  remaining: number | null;
  observedAt: string;
}

// Outcome of the most recent completed request (after retries), for a
// health/monitoring endpoint to report "last successful request" / "last
// failed request" without this class needing to know about HTTP routes.
export interface LastRequestStatus {
  ok: boolean;
  reason?: ProviderUnavailable["reason"];
  at: string;
}

interface AttemptOutcome<T> {
  response: ProviderResponse<T>;
  retryable: boolean;
  retryAfterMs: number | null;
}

export class ApiFootballProvider implements FootballDataProvider {
  readonly name = "api-football";
  private lastRateLimitStatus: RateLimitStatus | null = null;
  private lastRequestStatus: LastRequestStatus | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly timeoutMs: number = 10_000,
    private readonly logger?: Logger,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly sleepImpl: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** Rate-limit headers from the most recent response, if any were present. Null until a request has been made. */
  getRateLimitStatus(): RateLimitStatus | null {
    return this.lastRateLimitStatus;
  }

  /** Outcome of the most recent completed request (after retries). Null until a request has been made. */
  getLastRequestStatus(): LastRequestStatus | null {
    return this.lastRequestStatus;
  }

  private recordRateLimitHeaders(headers: Headers): void {
    const limitHeader = headers.get("x-ratelimit-requests-limit") ?? headers.get("x-ratelimit-limit");
    const remainingHeader = headers.get("x-ratelimit-requests-remaining") ?? headers.get("x-ratelimit-remaining");
    if (limitHeader === null && remainingHeader === null) return;

    const limit = limitHeader !== null ? Number(limitHeader) : null;
    const remaining = remainingHeader !== null ? Number(remainingHeader) : null;
    this.lastRateLimitStatus = { limit, remaining, observedAt: new Date().toISOString() };

    if (remaining !== null && limit !== null && limit > 0 && remaining / limit < 0.05) {
      this.logger?.warn({ provider: this.name, limit, remaining }, "API-Football rate limit nearly exhausted");
    }
  }

  // One HTTP attempt. Distinguishes retryable failures (timeout, network
  // error, HTTP 5xx, HTTP 429) from permanent ones (401/403 unauthorized, a
  // malformed/non-JSON body, or a body-level vendor error like an invalid
  // league/param) — retrying a permanent failure would just burn quota for
  // an outcome that will never change (spec's "do not endlessly retry an
  // invalid API key" requirement).
  private async attemptRequest<T>(path: string, params: Record<string, string>): Promise<AttemptOutcome<T>> {
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
      this.recordRateLimitHeaders(res.headers);

      if (res.status === 401 || res.status === 403) {
        return this.outcome(this.unavailable("unauthorized", `API-Football rejected the request (HTTP ${res.status})`), false, null);
      }
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null;
        return this.outcome(this.unavailable("rate_limited", "API-Football rate limit exceeded"), true, retryAfterMs);
      }
      if (res.status >= 500) {
        return this.outcome(this.unavailable("upstream_error", `API-Football returned HTTP ${res.status}`), true, null);
      }
      if (!res.ok) {
        // Other 4xx (bad request, not found, etc.) — the request itself is
        // malformed for this resource; retrying it unchanged won't help.
        return this.outcome(this.unavailable("upstream_error", `API-Football returned HTTP ${res.status}`), false, null);
      }

      let body: ApiFootballEnvelope<T>;
      try {
        body = (await res.json()) as ApiFootballEnvelope<T>;
      } catch {
        return this.outcome(this.unavailable("upstream_error", "API-Football returned a non-JSON response"), false, null);
      }

      // API-Football returns HTTP 200 even for an invalid key or bad
      // params, reporting the problem in `errors` instead.
      if (body.errors && !Array.isArray(body.errors) && Object.keys(body.errors).length > 0) {
        const message = Object.values(body.errors).join("; ");
        const reason = /token|key|plan/i.test(message) ? "unauthorized" : "upstream_error";
        return this.outcome(this.unavailable(reason, `API-Football error: ${message}`), false, null);
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        return this.outcome(this.unavailable("upstream_error", `API-Football error: ${JSON.stringify(body.errors)}`), false, null);
      }

      return this.outcome({ ok: true, data: body.response, sourceTimestamp, provider: this.name }, false, null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return this.outcome(this.unavailable("timeout", `API-Football request timed out after ${this.timeoutMs}ms`), true, null);
      }
      // A thrown (not merely rejected-with-status) error here is a network-
      // level failure (DNS, connection reset, etc.) — transient by nature.
      return this.outcome(this.unavailable("upstream_error", err instanceof Error ? err.message : "Unknown network error"), true, null);
    } finally {
      clearTimeout(timeout);
    }
  }

  private outcome<T>(response: ProviderResponse<T>, retryable: boolean, retryAfterMs: number | null): AttemptOutcome<T> {
    return { response, retryable, retryAfterMs };
  }

  // Retries retryable failures with exponential backoff (plus jitter),
  // honoring a 429 response's Retry-After header when present. Permanent
  // failures (unauthorized, malformed request) return on the first attempt.
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
        "Retrying API-Football request after a transient failure"
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
  ): Promise<ProviderResponse<ProviderTeamStatistics>> {
    const result = await this.request<RawTeamStatistics>("/teams/statistics", {
      team: teamExternalId,
      league: competitionExternalId,
      season: seasonExternalId
    });
    if (!result.ok) return result;

    const mapped = mapTeamStatistics(result.data);
    if (!mapped) {
      // The vendor returned 200 with a body that doesn't have the fields
      // this mapping needs (e.g. an empty statistics object for a team with
      // no fixtures yet) — treated as "no usable data," not as zeros, since
      // zeros would be indistinguishable from a team that's actually played
      // and drawn a blank.
      return this.unavailable(
        "upstream_error",
        "API-Football's team statistics response is missing the fields this mapping expects " +
          "(fixtures.played.total / goals.for.total.total / goals.against.total.total)."
      );
    }
    return { ...result, data: mapped };
  }

  async getInjuries(teamExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderInjury[]>> {
    const result = await this.request<RawInjury[]>("/injuries", { team: teamExternalId, season: seasonExternalId });
    if (!result.ok) return result;

    const mapped: ProviderInjury[] = [];
    for (const raw of result.data) {
      const entry = mapInjury(raw);
      if (entry) mapped.push(entry);
      // Entries missing a player id/name or fixture date are skipped rather
      // than stored with guessed values — see mapInjury.
    }
    return { ...result, data: mapped };
  }

  async getLineup(fixtureExternalId: string): Promise<ProviderResponse<ProviderLineup[]>> {
    const result = await this.request<RawLineupEntry[]>("/fixtures/lineups", { fixture: fixtureExternalId });
    if (!result.ok) return result;
    return { ...result, data: result.data.map(mapLineup).filter((l): l is ProviderLineup => l !== null) };
  }

  async getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderStanding[]>> {
    const result = await this.request<RawStandingsEnvelope[]>("/standings", {
      league: competitionExternalId,
      season: seasonExternalId
    });
    if (!result.ok) return result;
    return { ...result, data: mapStandings(result.data) };
  }

  // /fixtures/statistics is the ONLY api-football endpoint that includes
  // corner kicks — /teams/statistics (already used for team_statistics)
  // never does, at any level of detail. This is per-fixture (both teams in
  // one call, like getLineup/getOdds), not a team/season aggregate — see
  // syncFixtureStatistics.ts for how per-fixture rows get turned into a
  // team-season average.
  async getFixtureStatistics(fixtureExternalId: string): Promise<ProviderResponse<ProviderFixtureStatistics[]>> {
    const result = await this.request<RawFixtureStatisticsEntry[]>("/fixtures/statistics", { fixture: fixtureExternalId });
    if (!result.ok) return result;
    return {
      ...result,
      data: result.data.map(mapFixtureStatistics).filter((s): s is ProviderFixtureStatistics => s !== null)
    };
  }

  async getOdds(fixtureExternalId: string): Promise<ProviderResponse<ProviderOdds[]>> {
    const result = await this.request<RawOddsEnvelope[]>("/odds", { fixture: fixtureExternalId });
    if (!result.ok) return result;
    return { ...result, data: mapOdds(result.data) };
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

// Shape per api-football v3's documented /teams/statistics response —
// unverified against a live response, same caveat as RawFixture above.
// `clean_sheet`/`failed_to_score` are read defensively (optional chaining,
// null fallback) since they're less central to the documented contract
// than the fixtures/goals counts and more likely to have shifted.
interface RawTeamStatistics {
  fixtures?: {
    played?: { home?: number | null; away?: number | null; total?: number | null };
  };
  goals?: {
    for?: {
      total?: { home?: number | null; away?: number | null; total?: number | null };
    };
    against?: {
      total?: { home?: number | null; away?: number | null; total?: number | null };
    };
  };
  clean_sheet?: { total?: number | null };
  failed_to_score?: { total?: number | null };
  // Keyed by minute interval (e.g. "0-15", "76-90"), each with a `total`
  // count for that interval — not split by home/away, unlike goals. Summed
  // across every interval in mapTeamStatistics to get a season total.
  cards?: {
    yellow?: Record<string, { total?: number | null } | null> | null;
    red?: Record<string, { total?: number | null } | null> | null;
  };
}

function sumCardIntervals(intervals: Record<string, { total?: number | null } | null> | null | undefined): number | null {
  if (!intervals) return null;
  let sum = 0;
  let sawAny = false;
  for (const bucket of Object.values(intervals)) {
    if (typeof bucket?.total === "number") {
      sum += bucket.total;
      sawAny = true;
    }
  }
  // No usable interval at all (every bucket null/missing) is "no data," not
  // zero cards — a team that's genuinely never been booked is rare enough
  // that conflating it with a missing/malformed response would be worse.
  return sawAny ? sum : null;
}

function mapTeamStatistics(raw: RawTeamStatistics): ProviderTeamStatistics | null {
  const matchesPlayed = raw.fixtures?.played?.total;
  const matchesPlayedHome = raw.fixtures?.played?.home;
  const matchesPlayedAway = raw.fixtures?.played?.away;
  const goalsFor = raw.goals?.for?.total?.total;
  const goalsForHome = raw.goals?.for?.total?.home;
  const goalsForAway = raw.goals?.for?.total?.away;
  const goalsAgainst = raw.goals?.against?.total?.total;
  const goalsAgainstHome = raw.goals?.against?.total?.home;
  const goalsAgainstAway = raw.goals?.against?.total?.away;

  const required = [matchesPlayed, matchesPlayedHome, matchesPlayedAway, goalsFor, goalsForHome, goalsForAway, goalsAgainst, goalsAgainstHome, goalsAgainstAway];
  if (required.some((v) => typeof v !== "number")) return null;

  return {
    matchesPlayed: matchesPlayed as number,
    matchesPlayedHome: matchesPlayedHome as number,
    matchesPlayedAway: matchesPlayedAway as number,
    goalsFor: goalsFor as number,
    goalsForHome: goalsForHome as number,
    goalsForAway: goalsForAway as number,
    goalsAgainst: goalsAgainst as number,
    goalsAgainstHome: goalsAgainstHome as number,
    goalsAgainstAway: goalsAgainstAway as number,
    cleanSheets: typeof raw.clean_sheet?.total === "number" ? raw.clean_sheet.total : null,
    failedToScore: typeof raw.failed_to_score?.total === "number" ? raw.failed_to_score.total : null,
    yellowCards: sumCardIntervals(raw.cards?.yellow),
    redCards: sumCardIntervals(raw.cards?.red)
  };
}

// Shape per api-football v3's documented /injuries response — unverified
// against a live response, same caveat as the other Raw* interfaces above.
// One entry per (player, fixture) the player was reported missing for, not
// a single current-status flag — see getInjuries's mapping.
interface RawInjury {
  player?: { id?: number | null; name?: string | null; type?: string | null; reason?: string | null };
  fixture?: { date?: string | null };
}

// The vendor's `type`/`reason` fields are free text (e.g. type "Missing
// Fixture", reason "Knee Injury" or "Suspended"). There is no enum in the
// documented contract that maps cleanly onto this schema's status column,
// so this is a keyword heuristic, not a guaranteed-accurate classification
// — flagged in Task.md as needing validation against real responses.
function mapInjuryStatus(type: string | null | undefined, reason: string | null | undefined): ProviderInjury["status"] {
  const text = `${type ?? ""} ${reason ?? ""}`.toLowerCase();
  if (text.includes("suspen") || text.includes("red card") || text.includes("card accumulation")) return "suspended";
  if (text.includes("international")) return "international_duty";
  if (text.includes("doubt") || text.includes("question")) return "doubtful";
  return "injured";
}

function mapInjury(raw: RawInjury): ProviderInjury | null {
  const playerExternalId = raw.player?.id;
  const playerName = raw.player?.name;
  const fixtureDate = raw.fixture?.date;
  if (typeof playerExternalId !== "number" || !playerName || !fixtureDate) return null;

  return {
    playerExternalId: String(playerExternalId),
    playerName,
    status: mapInjuryStatus(raw.player?.type, raw.player?.reason),
    description: raw.player?.reason ?? raw.player?.type ?? null,
    reportedForFixtureUtc: new Date(fixtureDate).toISOString()
  };
}

// Shape per api-football v3's documented /standings response — unverified
// against a live response, same caveat as the other Raw* interfaces above.
// `standings` is an array of groups (e.g. separate group-stage tables, or a
// split "Championship Round"/"Relegation Round" in some leagues) — this
// mapping flattens every group into one list. This schema has no column
// for which group a row came from, so a team appearing in two groups in
// the same season would just have the later one win via upsert order; an
// edge case accepted for now rather than modeled (see Task.md).
interface RawStandingRow {
  rank?: number | null;
  team?: { id?: number | null; name?: string | null };
  points?: number | null;
  form?: string | null;
  all?: {
    played?: number | null;
    win?: number | null;
    draw?: number | null;
    lose?: number | null;
    goals?: { for?: number | null; against?: number | null };
  };
}

interface RawStandingsEnvelope {
  league?: { standings?: RawStandingRow[][] | null };
}

function mapStandingRow(raw: RawStandingRow): ProviderStanding | null {
  const teamExternalId = raw.team?.id;
  const teamName = raw.team?.name;
  const position = raw.rank;
  const points = raw.points;
  const played = raw.all?.played;
  const wins = raw.all?.win;
  const draws = raw.all?.draw;
  const losses = raw.all?.lose;
  const goalsFor = raw.all?.goals?.for;
  const goalsAgainst = raw.all?.goals?.against;

  const required = [position, points, played, wins, draws, losses, goalsFor, goalsAgainst];
  if (typeof teamExternalId !== "number" || !teamName || required.some((v) => typeof v !== "number")) return null;

  return {
    teamExternalId: String(teamExternalId),
    teamName,
    position: position as number,
    played: played as number,
    wins: wins as number,
    draws: draws as number,
    losses: losses as number,
    goalsFor: goalsFor as number,
    goalsAgainst: goalsAgainst as number,
    points: points as number,
    form: raw.form ?? null
  };
}

function mapStandings(envelopes: RawStandingsEnvelope[]): ProviderStanding[] {
  const rows: ProviderStanding[] = [];
  for (const envelope of envelopes) {
    for (const group of envelope.league?.standings ?? []) {
      for (const raw of group) {
        const mapped = mapStandingRow(raw);
        if (mapped) rows.push(mapped);
        // Rows missing required fields are skipped, not filled with
        // guessed values — same policy as every other mapper here.
      }
    }
  }
  return rows;
}

// Shape per api-football v3's documented /fixtures/lineups response —
// unverified against a live response, same caveat as the other Raw*
// interfaces above. One call returns an array with (up to) one entry per
// team, not one team at a time like team-statistics/injuries.
interface RawLineupPlayerEntry {
  player?: { id?: number | null; name?: string | null };
}

interface RawLineupEntry {
  team?: { id?: number | null; name?: string | null };
  formation?: string | null;
  startXI?: RawLineupPlayerEntry[] | null;
  substitutes?: RawLineupPlayerEntry[] | null;
}

function mapLineupPlayers(entries: RawLineupPlayerEntry[] | null | undefined): ProviderLineupPlayer[] {
  const players: ProviderLineupPlayer[] = [];
  for (const entry of entries ?? []) {
    const id = entry.player?.id;
    const name = entry.player?.name;
    if (typeof id === "number" && name) players.push({ externalId: String(id), name });
    // A malformed individual player entry is skipped, not the whole team —
    // same per-item policy as everywhere else in this file.
  }
  return players;
}

function mapLineup(raw: RawLineupEntry): ProviderLineup | null {
  const teamExternalId = raw.team?.id;
  const teamName = raw.team?.name;
  if (typeof teamExternalId !== "number" || !teamName) return null;

  return {
    teamExternalId: String(teamExternalId),
    teamName,
    formation: raw.formation ?? null,
    startingPlayers: mapLineupPlayers(raw.startXI),
    substitutePlayers: mapLineupPlayers(raw.substitutes)
  };
}

// Shape per api-football v3's documented /fixtures/statistics response —
// unverified against a live response, same caveat as the other Raw*
// interfaces above. One call returns an array with (up to) one entry per
// team, each carrying a flat list of {type, value} pairs covering many
// stat types (shots, possession, cards, corners, ...) — only "Corner
// Kicks" is parsed today; the rest are read but discarded until another
// market needs them (matches this file's existing "map only what's used"
// policy — see mapOdds's comment on the same tradeoff for bookmaker markets).
interface RawFixtureStatisticEntry {
  type?: string | null;
  value?: number | string | null;
}

interface RawFixtureStatisticsEntry {
  team?: { id?: number | null };
  statistics?: RawFixtureStatisticEntry[] | null;
}

function findStatisticValue(entries: RawFixtureStatisticEntry[] | null | undefined, type: string): number | null {
  const entry = entries?.find((e) => e.type === type);
  if (entry === undefined || entry.value === null || entry.value === undefined) return null;
  const value = typeof entry.value === "string" ? Number(entry.value) : entry.value;
  return Number.isFinite(value) ? value : null;
}

function mapFixtureStatistics(raw: RawFixtureStatisticsEntry): ProviderFixtureStatistics | null {
  const teamExternalId = raw.team?.id;
  if (typeof teamExternalId !== "number") return null;

  return {
    teamExternalId: String(teamExternalId),
    corners: findStatisticValue(raw.statistics, "Corner Kicks")
  };
}

// Shape per api-football v3's documented /odds response — unverified
// against a live response, same caveat as the other Raw* interfaces above.
// One call returns every bookmaker offering odds for the fixture, each
// with a list of "bets" (markets) and, per bet, a list of "values"
// (selections + price).
interface RawOddsValue {
  value?: string | null;
  odd?: string | null;
}

interface RawOddsBet {
  name?: string | null;
  values?: RawOddsValue[] | null;
}

interface RawOddsBookmaker {
  name?: string | null;
  bets?: RawOddsBet[] | null;
}

interface RawOddsEnvelope {
  bookmakers?: RawOddsBookmaker[] | null;
}

function parseDecimalOdds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  // The schema requires decimal_odds > 1 (anything else can't be a real
  // decimal price) — an out-of-range or unparseable value is dropped, not
  // clamped or guessed into range.
  return Number.isFinite(value) && value > 1 ? value : null;
}

// Only the three markets this platform's prediction engine actually
// produces are extracted (see ProviderOddsSelection) — a bookmaker's other
// markets/lines are read but intentionally not stored. Bet names and
// value labels are matched case-insensitively since this vendor's casing
// for them isn't nailed down by the (unverified) documentation.
function mapBet(bet: RawOddsBet): ProviderOddsSelection[] {
  const name = bet.name?.trim().toLowerCase() ?? "";
  const values = bet.values ?? [];
  const selections: ProviderOddsSelection[] = [];

  const push = (market: ProviderOddsSelection["market"], selection: string, oddRaw: string | null | undefined) => {
    const decimalOdds = parseDecimalOdds(oddRaw);
    if (decimalOdds !== null) selections.push({ market, selection, decimalOdds });
  };

  if (name === "match winner" || name === "1x2") {
    for (const v of values) {
      const label = v.value?.trim().toLowerCase();
      if (label === "home") push("1x2", "home", v.odd);
      else if (label === "draw") push("1x2", "draw", v.odd);
      else if (label === "away") push("1x2", "away", v.odd);
    }
  } else if (name === "both teams score" || name === "both teams to score") {
    for (const v of values) {
      const label = v.value?.trim().toLowerCase();
      if (label === "yes") push("btts", "yes", v.odd);
      else if (label === "no") push("btts", "no", v.odd);
    }
  } else if (name.includes("over/under") || name.includes("goals over")) {
    for (const v of values) {
      const label = v.value?.trim().toLowerCase();
      if (label === "over 2.5") push("over_under_2_5", "over", v.odd);
      else if (label === "under 2.5") push("over_under_2_5", "under", v.odd);
      // Other lines (1.5, 3.5, ...) are read but not stored — see the
      // module comment on ProviderOddsSelection.
    }
  }

  return selections;
}

function mapOdds(envelopes: RawOddsEnvelope[]): ProviderOdds[] {
  const odds: ProviderOdds[] = [];
  for (const envelope of envelopes) {
    for (const bookmaker of envelope.bookmakers ?? []) {
      if (!bookmaker.name) continue; // Can't attribute odds to an unnamed bookmaker.
      const selections = (bookmaker.bets ?? []).flatMap(mapBet);
      if (selections.length > 0) odds.push({ bookmaker: bookmaker.name, selections });
    }
  }
  return odds;
}
