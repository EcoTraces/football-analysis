import { describe, expect, it } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  getCompetitionRho,
  getLeagueAverages,
  runLeagueCalibration,
  LEAGUE_AVG_AWAY_GOALS,
  LEAGUE_AVG_HOME_GOALS,
  MIN_FIXTURES_FOR_LEAGUE_CALIBRATION
} from "../jobs/calibrateLeagues.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function finishedFixture(id: string, competitionId: string, homeScore: number, awayScore: number) {
  return {
    id,
    competition_id: competitionId,
    season_id: "season-1",
    status: "finished",
    is_synthetic: false,
    home_score: homeScore,
    away_score: awayScore
  };
}

describe("getLeagueAverages", () => {
  it("returns the fixed cross-league default, uncalibrated, when no row exists for the competition", async () => {
    const fake = new FakeSupabase();
    const result = await getLeagueAverages(fakeClient(fake), "comp-1");
    expect(result).toEqual({
      leagueAvgHomeGoals: LEAGUE_AVG_HOME_GOALS,
      leagueAvgAwayGoals: LEAGUE_AVG_AWAY_GOALS,
      calibrated: false,
      sampleSize: null
    });
  });

  it("returns the real calibrated averages when a row exists", async () => {
    const fake = new FakeSupabase();
    fake.seed("league_calibration", [
      { id: "lc-1", competition_id: "comp-1", league_avg_home_goals: 1.9, league_avg_away_goals: 1.3, sample_size: 55 },
      { id: "lc-2", competition_id: "comp-2", league_avg_home_goals: 1.1, league_avg_away_goals: 0.8, sample_size: 30 }
    ]);
    const result = await getLeagueAverages(fakeClient(fake), "comp-1");
    expect(result).toEqual({ leagueAvgHomeGoals: 1.9, leagueAvgAwayGoals: 1.3, calibrated: true, sampleSize: 55 });
  });
});

describe("runLeagueCalibration", () => {
  it("calibrates a competition with enough real finished fixtures and computes the correct averages", async () => {
    const fake = new FakeSupabase();
    const fixtures = [];
    // 2-1, alternating, MIN_FIXTURES_FOR_LEAGUE_CALIBRATION times — average should land exactly at 2/1.
    for (let i = 0; i < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION; i++) {
      fixtures.push(finishedFixture(`fx-${i}`, "comp-real", 2, 1));
    }
    fake.seed("fixtures", fixtures);

    const result = await runLeagueCalibration(fakeClient(fake), silentLogger);

    expect(result.competitionsCalibrated).toBe(1);
    expect(result.competitionsSkipped).toBe(0);

    const rows = fake.rows("league_calibration");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      competition_id: "comp-real",
      league_avg_home_goals: 2,
      league_avg_away_goals: 1,
      sample_size: MIN_FIXTURES_FOR_LEAGUE_CALIBRATION
    });

    const runs = fake.rows("ingestion_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job_name: "calibrate_leagues", status: "succeeded" });
  });

  it("skips a competition with fewer than the minimum real fixtures and writes no row for it", async () => {
    const fake = new FakeSupabase();
    const fixtures = [];
    for (let i = 0; i < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION - 1; i++) {
      fixtures.push(finishedFixture(`fx-${i}`, "comp-thin", 2, 1));
    }
    fake.seed("fixtures", fixtures);

    const result = await runLeagueCalibration(fakeClient(fake), silentLogger);

    expect(result.competitionsCalibrated).toBe(0);
    expect(result.competitionsSkipped).toBe(1);
    expect(fake.rows("league_calibration")).toHaveLength(0);
  });

  it("excludes synthetic and unfinished fixtures from the calibration entirely", async () => {
    const fake = new FakeSupabase();
    const fixtures = [];
    for (let i = 0; i < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION; i++) {
      fixtures.push(finishedFixture(`fx-${i}`, "comp-real", 2, 1));
    }
    // Would badly skew the average toward 10-0 if counted — must not be.
    fixtures.push({ ...finishedFixture("fx-synthetic", "comp-real", 10, 0), is_synthetic: true });
    fixtures.push({ ...finishedFixture("fx-scheduled", "comp-real", 10, 0), status: "scheduled" });
    fake.seed("fixtures", fixtures);

    await runLeagueCalibration(fakeClient(fake), silentLogger);

    const rows = fake.rows("league_calibration");
    expect(rows[0]).toMatchObject({ league_avg_home_goals: 2, league_avg_away_goals: 1, sample_size: MIN_FIXTURES_FOR_LEAGUE_CALIBRATION });
  });

  it("calibrates multiple competitions independently in one pass", async () => {
    const fake = new FakeSupabase();
    const fixtures = [];
    for (let i = 0; i < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION; i++) {
      fixtures.push(finishedFixture(`a-${i}`, "comp-a", 3, 1)); // avg 3-1
      fixtures.push(finishedFixture(`b-${i}`, "comp-b", 1, 1)); // avg 1-1
    }
    fake.seed("fixtures", fixtures);

    const result = await runLeagueCalibration(fakeClient(fake), silentLogger);

    expect(result.competitionsCalibrated).toBe(2);
    const rows = fake.rows("league_calibration");
    const byCompetition = new Map(rows.map((r) => [r.competition_id as string, r]));
    expect(byCompetition.get("comp-a")).toMatchObject({ league_avg_home_goals: 3, league_avg_away_goals: 1 });
    expect(byCompetition.get("comp-b")).toMatchObject({ league_avg_home_goals: 1, league_avg_away_goals: 1 });
  });

  it("re-running calibration updates the existing row rather than duplicating it", async () => {
    const fake = new FakeSupabase();
    const fixtures = [];
    for (let i = 0; i < MIN_FIXTURES_FOR_LEAGUE_CALIBRATION; i++) {
      fixtures.push(finishedFixture(`fx-${i}`, "comp-real", 2, 1));
    }
    fake.seed("fixtures", fixtures);

    await runLeagueCalibration(fakeClient(fake), silentLogger);
    // A new fixture arrives before the next scheduled run — average shifts.
    fake.seed("fixtures", [...fixtures, finishedFixture("fx-extra", "comp-real", 0, 0)]);
    await runLeagueCalibration(fakeClient(fake), silentLogger);

    const rows = fake.rows("league_calibration");
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]!.sample_size).toBe(MIN_FIXTURES_FOR_LEAGUE_CALIBRATION + 1);
  });
});

describe("getCompetitionRho", () => {
  it("returns undefined when the competition has no fit yet", async () => {
    const fake = new FakeSupabase();
    const result = await getCompetitionRho(fakeClient(fake), "comp-1");
    expect(result).toBeUndefined();
  });

  it("returns the fitted rho when a row exists for the competition", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_rho", [
      { id: "cr-1", model_version_id: "mv-1", competition_id: "comp-1", fitted_rho: -0.27, default_rho: -0.1, sample_size: 40, informative_matches: 40 },
      { id: "cr-2", model_version_id: "mv-1", competition_id: "comp-2", fitted_rho: -0.05, default_rho: -0.1, sample_size: 35, informative_matches: 35 }
    ]);
    const result = await getCompetitionRho(fakeClient(fake), "comp-1");
    expect(result).toBe(-0.27);
  });
});
