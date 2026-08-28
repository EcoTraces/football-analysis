import { describe, expect, it } from "vitest";
import { NullProvider } from "../providers/NullProvider.js";

describe("NullProvider", () => {
  it("never returns ok:true — every method reports not_configured", async () => {
    const provider = new NullProvider();

    const results = await Promise.all([
      provider.getFixturesForDateRange("2026-01-01", "2026-01-02"),
      provider.getResultsSince("2026-01-01"),
      provider.getTeamStatistics("1", "39", "2026"),
      provider.getInjuries("1", "2026"),
      provider.getLineup("1"),
      provider.getStandings("1", "2026"),
      provider.getOdds("1"),
      provider.getFixtureStatistics("1"),
      provider.getPlayerStatistics("1", "39", "2026")
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not_configured");
        expect(result.provider).toBe("null");
      }
    }
  });
});
