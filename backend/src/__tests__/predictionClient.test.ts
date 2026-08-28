import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictionClient } from "../services/predictionClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PredictionClient.predictGradientBoosting", () => {
  it("returns null (never throws) when ml-service responds 409 not-trained-yet, same contract as predictPoisson", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: "not trained" }) })
    );
    const client = new PredictionClient("http://ml-service.invalid");
    const result = await client.predictGradientBoosting({
      homeTeam: { matchesPlayed: 10, goalsScoredAvg: 1.5, goalsConcededAvg: 1.0 },
      awayTeam: { matchesPlayed: 10, goalsScoredAvg: 1.0, goalsConcededAvg: 1.5 }
    });
    expect(result).toBeNull();
  });

  it("returns the parsed response on success, hitting the gradient_boosting endpoint specifically", async () => {
    const body = {
      modelName: "gradient-boosting",
      modelVersion: "0.1.0",
      dataQuality: "strong",
      predictions: [
        { market: "1x2", selection: "home", probability: 0.5, factors: [] },
        { market: "1x2", selection: "draw", probability: 0.3, factors: [] },
        { market: "1x2", selection: "away", probability: 0.2, factors: [] }
      ]
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PredictionClient("http://ml-service.invalid");
    const result = await client.predictGradientBoosting({
      homeTeam: { matchesPlayed: 10, goalsScoredAvg: 1.5, goalsConcededAvg: 1.0 },
      awayTeam: { matchesPlayed: 10, goalsScoredAvg: 1.0, goalsConcededAvg: 1.5 }
    });

    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ml-service.invalid/predict/gradient_boosting");
  });
});

describe("PredictionClient.trainGradientBoosting", () => {
  it("returns the parsed training result on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sampleSize: 25, trainAccuracy: 0.8, classCounts: { home: 10, draw: 5, away: 10 } })
      })
    );
    const client = new PredictionClient("http://ml-service.invalid");
    const result = await client.trainGradientBoosting({ rows: [] });
    expect(result).toEqual({ sampleSize: 25, trainAccuracy: 0.8, classCounts: { home: 10, draw: 5, away: 10 } });
  });

  it("throws with ml-service's own detail message on a validation failure, rather than swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: "Need at least 20 training rows, got 3." }) })
    );
    const client = new PredictionClient("http://ml-service.invalid");
    await expect(client.trainGradientBoosting({ rows: [] })).rejects.toThrow("Need at least 20 training rows, got 3.");
  });

  it("falls back to a generic message when the error body has no detail field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const client = new PredictionClient("http://ml-service.invalid");
    await expect(client.trainGradientBoosting({ rows: [] })).rejects.toThrow("Training request failed with status 500");
  });
});
