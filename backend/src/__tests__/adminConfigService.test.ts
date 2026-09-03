import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./testSupabaseFake.js";
import {
  getAccumulatorTargets,
  getCompetitionAllowlist,
  getEnabledCompetitionIds,
  getEnsembleWeights,
  getScreeningConfig,
  setCompetitionAllowlistEntry,
  upsertAccumulatorTarget,
  upsertEnsembleWeights,
  upsertScreeningConfig
} from "../services/adminConfigService.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("getEnsembleWeights", () => {
  it("returns code-level defaults with isDefault: true when no row exists", async () => {
    const fake = new FakeSupabase();
    const result = await getEnsembleWeights(fakeClient(fake));
    expect(result.isDefault).toBe(true);
    expect(result.elo + result.poisson + result.form + result.homeAway + result.injuries + result.market).toBeCloseTo(1, 3);
  });

  it("returns the real row with isDefault: false once one exists", async () => {
    const fake = new FakeSupabase();
    fake.seed("ensemble_config", [
      { id: "ec-1", key: "default", elo_weight: 0.3, poisson_weight: 0.2, form_weight: 0.2, home_away_weight: 0.15, injuries_weight: 0.1, market_weight: 0.05 }
    ]);
    const result = await getEnsembleWeights(fakeClient(fake));
    expect(result).toMatchObject({ elo: 0.3, poisson: 0.2, isDefault: false });
  });

  it("upsertEnsembleWeights round-trips through getEnsembleWeights", async () => {
    const fake = new FakeSupabase();
    await upsertEnsembleWeights(fakeClient(fake), { elo: 0.25, poisson: 0.25, form: 0.2, homeAway: 0.15, injuries: 0.1, market: 0.05 }, "admin-1");
    const result = await getEnsembleWeights(fakeClient(fake));
    expect(result).toMatchObject({ elo: 0.25, poisson: 0.25, form: 0.2, homeAway: 0.15, injuries: 0.1, market: 0.05, isDefault: false });
  });

  it("re-upserting updates the single row in place rather than duplicating it", async () => {
    const fake = new FakeSupabase();
    await upsertEnsembleWeights(fakeClient(fake), { elo: 0.3, poisson: 0.2, form: 0.2, homeAway: 0.15, injuries: 0.1, market: 0.05 }, "admin-1");
    await upsertEnsembleWeights(fakeClient(fake), { elo: 0.4, poisson: 0.2, form: 0.15, homeAway: 0.1, injuries: 0.1, market: 0.05 }, "admin-1");
    expect(fake.rows("ensemble_config")).toHaveLength(1);
    expect((await getEnsembleWeights(fakeClient(fake))).elo).toBe(0.4);
  });
});

describe("getScreeningConfig", () => {
  it("returns code-level defaults with isDefault: true when no row exists", async () => {
    const result = await getScreeningConfig(fakeClient(new FakeSupabase()));
    expect(result.isDefault).toBe(true);
    expect(result.riskThresholds.eliteMin).toBeGreaterThan(result.riskThresholds.strongMin);
  });

  it("upsertScreeningConfig round-trips through getScreeningConfig", async () => {
    const fake = new FakeSupabase();
    await upsertScreeningConfig(
      fakeClient(fake),
      {
        scoreWeights: { ensembleConfidence: 0.5, ev: 0.2, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 90, strongMin: 75, mediumMin: 55, highRiskMin: 35 }
      },
      "admin-1"
    );
    const result = await getScreeningConfig(fakeClient(fake));
    expect(result.scoreWeights.ensembleConfidence).toBe(0.5);
    expect(result.riskThresholds.eliteMin).toBe(90);
    expect(result.isDefault).toBe(false);
  });
});

describe("accumulator targets", () => {
  it("returns the seeded defaults, ordered by legs, when the table is empty", async () => {
    const result = await getAccumulatorTargets(fakeClient(new FakeSupabase()));
    expect(result.map((t) => t.legs)).toEqual([5, 7, 10, 15, 20]);
  });

  it("upsertAccumulatorTarget updates just the one target row", async () => {
    const fake = new FakeSupabase();
    fake.seed("accumulator_targets", [
      { id: "at-5", legs: 5, min_selection_score: 60, enabled: true },
      { id: "at-7", legs: 7, min_selection_score: 65, enabled: true }
    ]);
    await upsertAccumulatorTarget(fakeClient(fake), 5, 72, false, "admin-1");
    const result = await getAccumulatorTargets(fakeClient(fake));
    const five = result.find((t) => t.legs === 5)!;
    const seven = result.find((t) => t.legs === 7)!;
    expect(five).toMatchObject({ minSelectionScore: 72, enabled: false });
    expect(seven).toMatchObject({ minSelectionScore: 65, enabled: true }); // untouched
  });
});

describe("competition allowlist", () => {
  it("getEnabledCompetitionIds returns null when nothing is allowlisted", async () => {
    const result = await getEnabledCompetitionIds(fakeClient(new FakeSupabase()));
    expect(result).toBeNull();
  });

  it("getEnabledCompetitionIds returns null when every entry is disabled", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [{ id: "a1", competition_id: "comp-1", enabled: false }]);
    const result = await getEnabledCompetitionIds(fakeClient(fake));
    expect(result).toBeNull();
  });

  it("getEnabledCompetitionIds returns the set of enabled competition ids", async () => {
    const fake = new FakeSupabase();
    fake.seed("competition_allowlist", [
      { id: "a1", competition_id: "comp-1", enabled: true },
      { id: "a2", competition_id: "comp-2", enabled: false },
      { id: "a3", competition_id: "comp-3", enabled: true }
    ]);
    const result = await getEnabledCompetitionIds(fakeClient(fake));
    expect(result).toEqual(new Set(["comp-1", "comp-3"]));
  });

  it("setCompetitionAllowlistEntry adds a new entry and can later disable it", async () => {
    const fake = new FakeSupabase();
    await setCompetitionAllowlistEntry(fakeClient(fake), "comp-1", true, "admin-1");
    expect(await getEnabledCompetitionIds(fakeClient(fake))).toEqual(new Set(["comp-1"]));

    await setCompetitionAllowlistEntry(fakeClient(fake), "comp-1", false, "admin-1");
    expect(await getEnabledCompetitionIds(fakeClient(fake))).toBeNull();
    expect(await getCompetitionAllowlist(fakeClient(fake))).toHaveLength(1); // updated in place, not duplicated
  });
});
