// Provider abstraction (spec section 5). Every concrete provider (a real
// paid football-data API, an odds feed, etc.) implements this interface.
// Application code never talks to a vendor SDK directly — only through
// these contracts — so swapping or adding providers never touches routes,
// services, or the frontend.

export interface ProviderFixture {
  externalId: string;
  competitionExternalId: string;
  competitionName: string;
  countryName: string | null;
  seasonExternalId: string;
  seasonLabel: string;
  homeTeamExternalId: string;
  homeTeamName: string;
  awayTeamExternalId: string;
  awayTeamName: string;
  venueName: string | null;
  round: string | null;
  kickoffUtc: string;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned";
  homeScore: number | null;
  awayScore: number | null;
  // Present in the vendor's response since the initial fixtures mapping was
  // written, but never parsed until the first_half_result/half_with_most_goals
  // markets needed real half-time scores to eventually check predictions
  // against (see ML_Model.md) — fixtures.home_score_ht/away_score_ht (0001)
  // sat unpopulated the whole time.
  homeScoreHt: number | null;
  awayScoreHt: number | null;
  // Raw vendor string (e.g. football-data.org's "LEAGUE"/"CUP") for
  // referenceDataService.ts's normalizeCompetitionType() to classify —
  // optional because api-football's /fixtures endpoint (unlike football-
  // data.org's /matches) doesn't include it at all; that would need a
  // separate /leagues call this MVP doesn't make (see Data_Sources.md and
  // Road_map.md's Phase 7 "team nationality and competition type not yet
  // correctly populated"). Undefined here always normalizes to the
  // existing 'league' default, never a guess.
  competitionType?: string;
}

export interface ProviderTeamStatistics {
  matchesPlayed: number;
  matchesPlayedHome: number;
  matchesPlayedAway: number;
  goalsFor: number;
  goalsForHome: number;
  goalsForAway: number;
  goalsAgainst: number;
  goalsAgainstHome: number;
  goalsAgainstAway: number;
  cleanSheets: number | null;
  failedToScore: number | null;
  // Season totals, not split by home/away — the vendor's /teams/statistics
  // cards breakdown isn't split that way (see ApiFootballProvider.ts's
  // mapTeamStatistics).
  yellowCards: number | null;
  redCards: number | null;
}

// Per-player season stats, scoped to one team (a player who transferred
// mid-season has a separate stint/response entry per team — see
// getPlayerStatistics's comment in ApiFootballProvider.ts).
export interface ProviderPlayerStatistics {
  playerExternalId: string;
  playerName: string;
  matchesPlayed: number;
  goalsScored: number | null;
  minutesPlayed: number | null;
}

export interface ProviderInjury {
  playerExternalId: string;
  playerName: string;
  // A best-effort classification from the vendor's free-text type/reason
  // fields (e.g. "Suspended", "Knee Injury") — see mapInjuryStatus in
  // ApiFootballProvider.ts. Not a guaranteed-accurate mapping; unverified
  // against live data like the rest of this provider.
  status: "injured" | "suspended" | "international_duty" | "doubtful" | "returned";
  description: string | null;
  // The fixture this report is attached to — the provider reports one
  // entry per (player, fixture) they were missing for, not a single
  // current-status flag. The caller picks the most recent one per player.
  reportedForFixtureUtc: string;
}

export interface ProviderStanding {
  teamExternalId: string;
  teamName: string;
  position: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  // e.g. "WWDLW" — nullable since not every vendor/competition reports it.
  form: string | null;
}

export interface ProviderLineupPlayer {
  externalId: string;
  name: string;
}

export interface ProviderLineup {
  teamExternalId: string;
  teamName: string;
  formation: string | null;
  startingPlayers: ProviderLineupPlayer[];
  substitutePlayers: ProviderLineupPlayer[];
}

export interface ProviderOddsSelection {
  // Restricted to the markets this platform's prediction engine actually
  // produces (see ml-service/app/main.py) — 1x2, btts, over_under_2_5 —
  // so odds can be compared against a model probability for the same
  // market (spec section 25, Value Analysis). Other markets/lines a
  // bookmaker offers (Asian handicap, other O/U lines, ...) are not
  // captured; extend this once the prediction engine covers them too.
  market: "1x2" | "btts" | "over_under_2_5";
  selection: string; // 'home' | 'draw' | 'away' | 'yes' | 'no' | 'over' | 'under'
  decimalOdds: number;
}

export interface ProviderOdds {
  bookmaker: string;
  selections: ProviderOddsSelection[];
}

// One call returns one entry per team (home + away), like getLineup/getOdds
// — not scoped to one team at a time. `corners: null` means the vendor's
// response for this fixture didn't include a parseable corners value (not
// yet played, or the field genuinely missing) — never coerced to 0, since
// 0 corners is a real possible result and shouldn't be indistinguishable
// from "no data."
export interface ProviderFixtureStatistics {
  teamExternalId: string;
  corners: number | null;
}

export interface ProviderResult {
  ok: true;
  data: unknown;
  sourceTimestamp: string;
  provider: string;
}

export interface ProviderUnavailable {
  ok: false;
  reason: "not_configured" | "rate_limited" | "upstream_error" | "timeout" | "unauthorized";
  message: string;
  provider: string;
}

export type ProviderResponse<T> =
  | { ok: true; data: T; sourceTimestamp: string; provider: string }
  | ProviderUnavailable;

export interface FixtureProvider {
  getFixturesForDateRange(fromIso: string, toIso: string): Promise<ProviderResponse<ProviderFixture[]>>;
}

export interface ResultsProvider {
  getResultsSince(sinceIso: string): Promise<ProviderResponse<ProviderFixture[]>>;
}

export interface TeamStatsProvider {
  // Most vendors (including API-Football) scope team statistics to a
  // specific competition, not just a season — a team playing in two
  // competitions in the same season has different stats in each.
  getTeamStatistics(
    teamExternalId: string,
    competitionExternalId: string,
    seasonExternalId: string
  ): Promise<ProviderResponse<ProviderTeamStatistics>>;
}

export interface InjuryProvider {
  getInjuries(teamExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderInjury[]>>;
}

export interface LineupProvider {
  // One fixture call returns both teams' lineups, not one — unlike the
  // team/season-scoped providers above.
  getLineup(fixtureExternalId: string): Promise<ProviderResponse<ProviderLineup[]>>;
}

export interface StandingsProvider {
  getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<ProviderStanding[]>>;
}

export interface OddsProvider {
  // One fixture call returns every bookmaker's odds, like getLineup
  // returns both teams — not scoped to one bookmaker at a time.
  getOdds(fixtureExternalId: string): Promise<ProviderResponse<ProviderOdds[]>>;
}

export interface FixtureStatisticsProvider {
  // Post-match box-score stats, one call per fixture (both teams). Unlike
  // TeamStatsProvider's season aggregates, this is the only source for
  // corners — api-football doesn't include corners in /teams/statistics at
  // all (see ApiFootballProvider.ts's module comment on getFixtureStatistics).
  getFixtureStatistics(fixtureExternalId: string): Promise<ProviderResponse<ProviderFixtureStatistics[]>>;
}

export interface PlayerStatsProvider {
  // Team/season-scoped like TeamStatsProvider, not per-fixture — see
  // getPlayerStatistics's comment in ApiFootballProvider.ts for the
  // single-page-only limitation this method has.
  getPlayerStatistics(
    teamExternalId: string,
    competitionExternalId: string,
    seasonExternalId: string
  ): Promise<ProviderResponse<ProviderPlayerStatistics[]>>;
}

export interface FootballDataProvider
  extends FixtureProvider,
    ResultsProvider,
    TeamStatsProvider,
    InjuryProvider,
    LineupProvider,
    StandingsProvider,
    OddsProvider,
    FixtureStatisticsProvider,
    PlayerStatsProvider {
  readonly name: string;
}

// Last-observed HTTP rate-limit status, for a health/monitoring endpoint to
// report without needing to know the calling route. Not every provider
// tracks this (NullProvider has nothing to track), so this is a separate,
// optional capability rather than part of FootballDataProvider itself —
// checked via a duck-typed "does this provider implement it" test (see
// routes/health.ts's isObservableHttpProvider), not an `instanceof` against
// one specific concrete class, so any real HTTP-backed provider (currently
// ApiFootballProvider and FootballDataOrgProvider) can plug into the same
// health endpoint.
export interface ProviderRateLimitStatus {
  limit: number | null;
  remaining: number | null;
  observedAt: string;
}

// Outcome of the most recently *completed* request (after retries and any
// failover), same "optional capability" reasoning as ProviderRateLimitStatus
// above.
export interface ProviderLastRequestStatus {
  ok: boolean;
  reason?: ProviderUnavailable["reason"];
  at: string;
}

export interface ObservableHttpProvider {
  getRateLimitStatus(): ProviderRateLimitStatus | null;
  getLastRequestStatus(): ProviderLastRequestStatus | null;
}
