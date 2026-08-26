import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderResponse,
  ProviderTeamStatistics
} from "./types.js";

// The default provider when no real data source is configured. It NEVER
// fabricates fixtures, scores, injuries, or stats — it always returns a
// structured "not_configured" response so callers can render an explicit
// "Data unavailable" state instead of silently showing nothing or, worse,
// synthesizing something that looks real. See spec section 2 (No Fabrication).
export class NullProvider implements FootballDataProvider {
  readonly name = "null";

  private unavailable<T>(): ProviderResponse<T> {
    return {
      ok: false,
      reason: "not_configured",
      message:
        "No football data provider is configured (FOOTBALL_DATA_PROVIDER=null). " +
        "Set a real provider and API key to enable this endpoint. See Data_Sources.md.",
      provider: this.name
    };
  }

  async getFixturesForDateRange(_fromIso: string, _toIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    return this.unavailable();
  }

  async getResultsSince(_sinceIso: string): Promise<ProviderResponse<ProviderFixture[]>> {
    return this.unavailable();
  }

  async getTeamStatistics(
    _teamExternalId: string,
    _competitionExternalId: string,
    _seasonExternalId: string
  ): Promise<ProviderResponse<ProviderTeamStatistics>> {
    return this.unavailable();
  }

  async getInjuries(_teamExternalId: string, _seasonExternalId: string): Promise<ProviderResponse<unknown[]>> {
    return this.unavailable();
  }

  async getLineup(_fixtureExternalId: string): Promise<ProviderResponse<unknown>> {
    return this.unavailable();
  }

  async getStandings(
    _competitionExternalId: string,
    _seasonExternalId: string
  ): Promise<ProviderResponse<unknown[]>> {
    return this.unavailable();
  }
}
