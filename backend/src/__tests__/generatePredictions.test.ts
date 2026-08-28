import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import { generatePredictionsForUpcomingFixtures } from "../jobs/generatePredictions.js";
import type { PoissonPredictionRequest, PoissonPredictionResponse, PredictionClient } from "../services/predictionClient.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function samplePredictionResponse(): PoissonPredictionResponse {
  return {
    modelName: "poisson-baseline",
    modelVersion: "0.1.0",
    dataQuality: "strong",
    predictions: [{ market: "1x2", selection: "home", probability: 0.5, factors: [] }]
  };
}

describe("generatePredictionsForUpcomingFixtures", () => {
  it("forwards each team's own cards/corners averages, omitting a team's when its team_statistics value is null", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      {
        id: "fx-1",
        season_id: "season-1",
        home_team_id: "team-home",
        away_team_id: "team-away",
        status: "scheduled",
        is_synthetic: false,
        kickoff_utc: new Date(Date.now() + 3600_000).toISOString()
      }
    ]);
    fake.seed("team_statistics", [
      {
        id: "ts-home",
        team_id: "team-home",
        season_id: "season-1",
        scope: "overall",
        matches_played: 10,
        goals_scored: 15,
        goals_conceded: 8,
        yellow_cards: 20,
        corners: 55
      },
      {
        id: "ts-away",
        team_id: "team-away",
        season_id: "season-1",
        scope: "overall",
        matches_played: 10,
        goals_scored: 12,
        goals_conceded: 10,
        yellow_cards: null, // not populated yet for this team
        corners: 48
      }
    ]);
    fake.seed("player_statistics", [
      { id: "ps-1", team_id: "team-home", season_id: "season-1", player_name: "Home Striker", goals_scored: 12, matches_played: 10 },
      { id: "ps-2", team_id: "team-home", season_id: "season-1", player_name: "Home Winger", goals_scored: 3, matches_played: 9 }
      // team-away has no player_statistics rows at all
    ]);

    const predictPoisson = vi.fn().mockResolvedValue(samplePredictionResponse());
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    const result = await generatePredictionsForUpcomingFixtures(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger);

    expect(result).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(predictPoisson).toHaveBeenCalledTimes(1);

    const payload = predictPoisson.mock.calls[0]?.[0] as PoissonPredictionRequest;
    expect(payload.homeTeamAvgYellowCards).toBe(2); // 20 / 10
    expect(payload.homeTeamAvgCorners).toBe(5.5); // 55 / 10
    expect(payload.awayTeamAvgYellowCards).toBeUndefined(); // null in the row — never sent as 0
    expect(payload.awayTeamAvgCorners).toBeCloseTo(4.8); // 48 / 10

    expect(payload.homeTeamPlayers).toEqual([
      { name: "Home Striker", goalsScored: 12, matchesPlayed: 10 },
      { name: "Home Winger", goalsScored: 3, matchesPlayed: 9 }
    ]);
    expect(payload.awayTeamPlayers).toBeUndefined(); // no player_statistics rows synced for this team yet

    const predictions = fake.rows("predictions");
    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toMatchObject({ fixture_id: "fx-1", market: "1x2", selection: "home" });
  });

  it("uses a competition's real calibrated league averages instead of the fixed cross-league default when one exists", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      {
        id: "fx-1",
        season_id: "season-1",
        competition_id: "comp-calibrated",
        home_team_id: "team-home",
        away_team_id: "team-away",
        status: "scheduled",
        is_synthetic: false,
        kickoff_utc: new Date(Date.now() + 3600_000).toISOString()
      }
    ]);
    fake.seed("team_statistics", [
      { id: "ts-home", team_id: "team-home", season_id: "season-1", scope: "overall", matches_played: 10, goals_scored: 15, goals_conceded: 8 },
      { id: "ts-away", team_id: "team-away", season_id: "season-1", scope: "overall", matches_played: 10, goals_scored: 12, goals_conceded: 10 }
    ]);
    fake.seed("league_calibration", [
      { id: "lc-1", competition_id: "comp-calibrated", league_avg_home_goals: 2.1, league_avg_away_goals: 1.7, sample_size: 40 }
    ]);

    const predictPoisson = vi.fn().mockResolvedValue(samplePredictionResponse());
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    await generatePredictionsForUpcomingFixtures(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger);

    const payload = predictPoisson.mock.calls[0]?.[0] as PoissonPredictionRequest;
    expect(payload.leagueAvgHomeGoals).toBe(2.1);
    expect(payload.leagueAvgAwayGoals).toBe(1.7);
  });

  it("falls back to the fixed cross-league default when the fixture's competition has no calibration yet", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      {
        id: "fx-1",
        season_id: "season-1",
        competition_id: "comp-uncalibrated",
        home_team_id: "team-home",
        away_team_id: "team-away",
        status: "scheduled",
        is_synthetic: false,
        kickoff_utc: new Date(Date.now() + 3600_000).toISOString()
      }
    ]);
    fake.seed("team_statistics", [
      { id: "ts-home", team_id: "team-home", season_id: "season-1", scope: "overall", matches_played: 10, goals_scored: 15, goals_conceded: 8 },
      { id: "ts-away", team_id: "team-away", season_id: "season-1", scope: "overall", matches_played: 10, goals_scored: 12, goals_conceded: 10 }
    ]);
    // No league_calibration row for comp-uncalibrated (or the table at all).

    const predictPoisson = vi.fn().mockResolvedValue(samplePredictionResponse());
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    await generatePredictionsForUpcomingFixtures(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger);

    const payload = predictPoisson.mock.calls[0]?.[0] as PoissonPredictionRequest;
    expect(payload.leagueAvgHomeGoals).toBe(1.5);
    expect(payload.leagueAvgAwayGoals).toBe(1.1);
  });

  it("skips a fixture when either team has fewer than 3 matches of stats, without calling the prediction client", async () => {
    const fake = new FakeSupabase();
    fake.seed("fixtures", [
      {
        id: "fx-1",
        season_id: "season-1",
        home_team_id: "team-home",
        away_team_id: "team-away",
        status: "scheduled",
        is_synthetic: false,
        kickoff_utc: new Date(Date.now() + 3600_000).toISOString()
      }
    ]);
    fake.seed("team_statistics", [
      {
        id: "ts-home",
        team_id: "team-home",
        season_id: "season-1",
        scope: "overall",
        matches_played: 2,
        goals_scored: 3,
        goals_conceded: 2,
        yellow_cards: 4,
        corners: 10
      }
      // away team has no team_statistics row at all
    ]);

    const predictPoisson = vi.fn();
    const fakePredictionClient = { predictPoisson } as unknown as PredictionClient;

    const result = await generatePredictionsForUpcomingFixtures(fakeClient(fake), fakePredictionClient, "mv-1", silentLogger);

    expect(result).toEqual({ processed: 0, skipped: 1, failed: 0 });
    expect(predictPoisson).not.toHaveBeenCalled();
  });
});
