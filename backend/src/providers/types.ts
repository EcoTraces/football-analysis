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
  ): Promise<ProviderResponse<unknown>>;
}

export interface InjuryProvider {
  getInjuries(teamExternalId: string, seasonExternalId: string): Promise<ProviderResponse<unknown[]>>;
}

export interface LineupProvider {
  getLineup(fixtureExternalId: string): Promise<ProviderResponse<unknown>>;
}

export interface StandingsProvider {
  getStandings(competitionExternalId: string, seasonExternalId: string): Promise<ProviderResponse<unknown[]>>;
}

export interface OddsProvider {
  getOdds(fixtureExternalId: string): Promise<ProviderResponse<unknown[]>>;
}

export interface FootballDataProvider
  extends FixtureProvider,
    ResultsProvider,
    TeamStatsProvider,
    InjuryProvider,
    LineupProvider,
    StandingsProvider {
  readonly name: string;
}
