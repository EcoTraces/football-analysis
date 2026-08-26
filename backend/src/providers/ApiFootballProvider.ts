import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderInjury,
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

  async getLineup(fixtureExternalId: string): Promise<ProviderResponse<unknown>> {
    return this.request("/fixtures/lineups", { fixture: fixtureExternalId });
  }

  async getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderStanding[]>> {
    const result = await this.request<RawStandingsEnvelope[]>("/standings", {
      league: competitionExternalId,
      season: seasonExternalId
    });
    if (!result.ok) return result;
    return { ...result, data: mapStandings(result.data) };
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
    failedToScore: typeof raw.failed_to_score?.total === "number" ? raw.failed_to_score.total : null
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
