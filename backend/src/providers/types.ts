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
