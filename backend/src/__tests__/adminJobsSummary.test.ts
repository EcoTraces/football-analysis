import { describe, expect, it } from "vitest";
import { summarizeIngestionRuns, type IngestionRunRow } from "../routes/admin.js";

function run(overrides: Partial<IngestionRunRow>): IngestionRunRow {
  return {
    id: "run-1",
    job_name: "sync_fixtures",
    provider: "api-football",
    status: "succeeded",
    records_processed: 1,
    records_rejected: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    ...overrides
  };
}

describe("summarizeIngestionRuns", () => {
  it("returns the newest row per job_name as lastRun, given newest-first input", () => {
    const rows = [
      run({ id: "r2", job_name: "sync_odds", started_at: "2026-08-26T10:00:00Z" }),
      run({ id: "r1", job_name: "sync_odds", started_at: "2026-08-26T09:00:00Z" })
    ];

    const summary = summarizeIngestionRuns(rows);

    expect(summary.sync_odds?.lastRun.id).toBe("r2");
  });

  it("finds the most recent SUCCEEDED run separately from the most recent run overall", () => {
    const rows = [
      run({ id: "r3", job_name: "sync_injuries", status: "failed", started_at: "2026-08-26T12:00:00Z" }),
      run({ id: "r2", job_name: "sync_injuries", status: "succeeded", started_at: "2026-08-26T11:00:00Z" }),
      run({ id: "r1", job_name: "sync_injuries", status: "succeeded", started_at: "2026-08-26T10:00:00Z" })
    ];

    const summary = summarizeIngestionRuns(rows);

    expect(summary.sync_injuries?.lastRun.id).toBe("r3");
    expect(summary.sync_injuries?.lastSuccess?.id).toBe("r2"); // most recent SUCCEEDED, not the most recent overall
  });

  it("reports lastSuccess: null for a job that has never succeeded", () => {
    const rows = [run({ id: "r1", job_name: "sync_lineups", status: "failed" })];

    const summary = summarizeIngestionRuns(rows);

    expect(summary.sync_lineups?.lastSuccess).toBeNull();
  });

  it("keeps every distinct job_name as a separate entry", () => {
    const rows = [
      run({ id: "r1", job_name: "sync_fixtures" }),
      run({ id: "r2", job_name: "sync_odds" }),
      run({ id: "r3", job_name: "predictions" })
    ];

    const summary = summarizeIngestionRuns(rows);

    expect(Object.keys(summary).sort()).toEqual(["predictions", "sync_fixtures", "sync_odds"]);
  });

  it("returns an empty object for no rows", () => {
    expect(summarizeIngestionRuns([])).toEqual({});
  });
});
