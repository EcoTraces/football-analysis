import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import type { FakeRow } from "./testSupabaseFake.js";
import { buildTrainingRows, runLatestGradientBoostingTrainingJob } from "../jobs/trainGradientBoosting.js";
import { ApiError } from "../middleware/errorHandler.js";

const silentLogger = pino({ level: "silent" });

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function finishedFixture(overrides: Record<string, unknown> & { id: string }): FakeRow {
  return { season_id: "season-1", competition_id: "comp-1", status: "finished", is_synthetic: false, ...overrides };
}

function priorHistoryFixtures(teamId: string, opponentId: string, count: number, beforeIso: string) {
  const base = new Date(beforeIso).getTime();
  const daysOutsideWindow = 40; // Keeps history out of the [from, to] window under test — see runBacktest.test.ts's identical helper.
  return Array.from({ length: count }, (_, i) => {
    const kickoff = new Date(base - (daysOutsideWindow + count - i) * 24 * 60 * 60 * 1000).toISOString();
    return finishedFixture({ id: `hist-${teamId}-${i}`, home_team_id: teamId, away_team_id: opponentId, kickoff_utc: kickoff, home_score: 1, away_score: 1 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTrainingRows", () => {
  it("builds one point-in-time training row per qualifying fixture and skips fixtures below the match threshold", async () => {
    const fake = new FakeSupabase();
    const kickoff = "2024-03-10T15:00:00.000Z";
    fake.seed("fixtures", [
      ...priorHistoryFixtures("team-home", "hist-opp", 3, kickoff),
      ...priorHistoryFixtures("team-away", "hist-opp", 3, kickoff),
      ...priorHistoryFixtures("team-thin", "hist-opp", 2, kickoff), // below MIN_MATCHES_FOR_PREDICTION
      finishedFixture({ id: "fx-qualifies", home_team_id: "team-home", away_team_id: "team-away", kickoff_utc: kickoff, home_score: 2, away_score: 0 }),
      finishedFixture({ id: "fx-skipped", home_team_id: "team-thin", away_team_id: "team-away", kickoff_utc: kickoff, home_score: 1, away_score: 1 })
    ]);

    const { rows, skipped } = await buildTrainingRows(fakeClient(fake), silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "home" });
    expect(rows[0]!.homeTeam.matchesPlayed).toBe(3);
    expect(skipped).toBe(1);
  });
});

describe("runLatestGradientBoostingTrainingJob", () => {
  it("returns nulls without creating an ingestion_runs row when no gradient-boosting model_version exists yet", async () => {
    const fake = new FakeSupabase();
    const result = await runLatestGradientBoostingTrainingJob(fakeClient(fake), "http://ml-service.invalid", silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(result.modelVersionId).toBeNull();
    expect(result.runId).toBeNull();
    expect(fake.rows("ingestion_runs")).toHaveLength(0);
  });

  it("trains successfully and updates the model_versions row's trained_at/training_dataset_version/notes", async () => {
    const fake = new FakeSupabase();
    fake.seed("model_versions", [{ id: "mv-gb", name: "gradient-boosting", version: "0.1.0" }]);
    const kickoff = "2024-03-10T15:00:00.000Z";
    fake.seed("fixtures", [
      ...priorHistoryFixtures("team-home", "hist-opp", 3, kickoff),
      ...priorHistoryFixtures("team-away", "hist-opp", 3, kickoff),
      finishedFixture({ id: "fx-1", home_team_id: "team-home", away_team_id: "team-away", kickoff_utc: kickoff, home_score: 2, away_score: 0 })
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sampleSize: 1, trainAccuracy: 1.0, classCounts: { home: 1, draw: 0, away: 0 } })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLatestGradientBoostingTrainingJob(fakeClient(fake), "http://ml-service.invalid", silentLogger, {
      from: "2024-03-01T00:00:00.000Z",
      to: "2024-03-31T23:59:59.000Z"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://ml-service.invalid/train/gradient_boosting",
      expect.objectContaining({ method: "POST" })
    );
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(sentBody.rows).toHaveLength(1);

    expect(result.modelVersionId).toBe("mv-gb");
    expect(result.sampleSize).toBe(1);
    expect(result.trainAccuracy).toBe(1.0);

    const runs = fake.rows("ingestion_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job_name: "train:gradient-boosting", status: "succeeded" });

    const modelVersions = fake.rows("model_versions");
    expect(modelVersions[0]!.trained_at).toBeTruthy();
    expect(modelVersions[0]!.training_dataset_version).toBe("2024-03-01T00:00:00.000Z..2024-03-31T23:59:59.000Z");
    expect(modelVersions[0]!.notes).toContain("sampleSize=1");
  });

  it("surfaces ml-service's validation failure as a 422 ApiError and marks the ingestion_runs row failed", async () => {
    const fake = new FakeSupabase();
    fake.seed("model_versions", [{ id: "mv-gb", name: "gradient-boosting", version: "0.1.0" }]);
    // No fixtures seeded — buildTrainingRows produces zero rows, which
    // ml-service is expected to reject (mocked here, since the real
    // gradient_boosting.py enforces MIN_TRAINING_ROWS itself).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ detail: "Need at least 20 training rows, got 0." })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runLatestGradientBoostingTrainingJob(fakeClient(fake), "http://ml-service.invalid", silentLogger, {
        from: "2024-03-01T00:00:00.000Z",
        to: "2024-03-31T23:59:59.000Z"
      })
    ).rejects.toMatchObject({ statusCode: 422, message: "Need at least 20 training rows, got 0." } satisfies Partial<ApiError>);

    const runs = fake.rows("ingestion_runs");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job_name: "train:gradient-boosting", status: "failed" });

    // A failed training run must never silently mark the model as trained.
    expect(fake.rows("model_versions")[0]!.trained_at).toBeUndefined();
  });
});
