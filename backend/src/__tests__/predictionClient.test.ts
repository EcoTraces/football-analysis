import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictionClient } from "../services/predictionClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
    await expect(client.trainGradientBoosting({ rows: [] })).rejects.toThrow("Request to /train/gradient_boosting failed with status 500");
  });
});

describe("PredictionClient.fitDixonColesRho", () => {
  it("returns the parsed fit result on success, hitting the dixon_coles_rho endpoint specifically", async () => {
    const body = {
      sampleSize: 40,
      informativeMatches: 40,
      fittedRho: -0.32,
      logLikelihoodAtFittedRho: -10.1,
      logLikelihoodAtDefaultRho: -25.4,
      defaultRho: -0.1
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PredictionClient("http://ml-service.invalid");
    const result = await client.fitDixonColesRho({ leagueAvgHomeGoals: 1.5, leagueAvgAwayGoals: 1.1, rows: [] });

    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ml-service.invalid/fit/dixon_coles_rho");
  });

  it("throws with ml-service's own detail message on a validation failure, rather than swallowing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ detail: "Need at least 30 matches finishing 0-0, 1-0, 0-1, or 1-1 to fit rho, got 2 out of 50 rows." })
      })
    );
    const client = new PredictionClient("http://ml-service.invalid");
    await expect(client.fitDixonColesRho({ leagueAvgHomeGoals: 1.5, leagueAvgAwayGoals: 1.1, rows: [] })).rejects.toThrow(
      "Need at least 30 matches finishing 0-0, 1-0, 0-1, or 1-1 to fit rho"
    );
  });
});

describe("PredictionClient.getRhoStatus", () => {
  it("returns the parsed status on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fittedRho: -0.28, defaultRho: -0.1 }) }));
    const client = new PredictionClient("http://ml-service.invalid");
    const result = await client.getRhoStatus();
    expect(result).toEqual({ fittedRho: -0.28, defaultRho: -0.1 });
  });

  it("throws when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new PredictionClient("http://ml-service.invalid");
    await expect(client.getRhoStatus()).rejects.toThrow("rho_status request failed with status 500");
  });
});

// ml-service/app/security.py rejects any /predict/*, /fit/*, or /train/*
// request without a matching X-API-Key header once ML_SERVICE_API_KEY is
// configured there — these confirm this client actually sends one.
describe("PredictionClient X-API-Key header", () => {
  it("sends no X-API-Key header when no key is configured anywhere", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fittedRho: null, defaultRho: -0.1 }) });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PredictionClient("http://ml-service.invalid");
    await client.getRhoStatus();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("sends the explicitly constructed key as X-API-Key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fittedRho: null, defaultRho: -0.1 }) });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PredictionClient("http://ml-service.invalid", "explicit-key");
    await client.getRhoStatus();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("explicit-key");
  });

  it("falls back to ML_SERVICE_API_KEY from the environment when no key is passed explicitly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fittedRho: null, defaultRho: -0.1 }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ML_SERVICE_API_KEY", "env-key");

    const client = new PredictionClient("http://ml-service.invalid");
    await client.getRhoStatus();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("env-key");
  });

  it("sends the header on POST endpoints too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelName: "elo", modelVersion: "0.1.0", dataQuality: "strong", predictions: [] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new PredictionClient("http://ml-service.invalid", "explicit-key");
    await client.predictElo({ homeTeam: { rating: 1500, matchesPlayed: 10 }, awayTeam: { rating: 1500, matchesPlayed: 10 } });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("explicit-key");
  });
});
