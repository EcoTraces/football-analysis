import { describe, expect, it } from "vitest";
import pino from "pino";
import { createSecondaryOddsProvider } from "../providers/registry.js";
import { ApiFootballProvider } from "../providers/ApiFootballProvider.js";
import { NullProvider } from "../providers/NullProvider.js";
import type { Env } from "../config/env.js";

const silentLogger = pino({ level: "silent" });

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 8080,
    NODE_ENV: "test",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ML_SERVICE_URL: "http://localhost:8000",
    FOOTBALL_DATA_PROVIDER: "null",
    FOOTBALL_DATA_API_KEY: "",
    FOOTBALL_DATA_RAPIDAPI_KEY: "",
    FOOTBALL_DATA_ORG_API_KEY: "",
    SCHEDULER_ENABLED: false,
    WEATHER_API_KEY: "",
    ALLOWED_ORIGINS: "http://localhost:5173",
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 120,
    ...overrides
  };
}

describe("createSecondaryOddsProvider", () => {
  it("returns NullProvider when FOOTBALL_DATA_API_KEY is unset", () => {
    const provider = createSecondaryOddsProvider(baseEnv(), silentLogger);
    expect(provider).toBeInstanceOf(NullProvider);
  });

  it("builds a dedicated ApiFootballProvider when a key is set and the primary is a different provider", () => {
    const env = baseEnv({ FOOTBALL_DATA_API_KEY: "a-real-key", FOOTBALL_DATA_PROVIDER: "football-data-org" });
    const primary = new NullProvider(); // stand-in for a football-data-org instance — only .name is inspected

    const provider = createSecondaryOddsProvider(env, silentLogger, primary);

    expect(provider).toBeInstanceOf(ApiFootballProvider);
    expect(provider).not.toBe(primary);
    expect(provider.name).toBe("api-football");
  });

  it("reuses the primary instance directly when it's already api-football, rather than constructing a second one", () => {
    const env = baseEnv({ FOOTBALL_DATA_API_KEY: "a-real-key", FOOTBALL_DATA_PROVIDER: "api-football" });
    const primary = new ApiFootballProvider("a-real-key", undefined, undefined, undefined, silentLogger);

    const provider = createSecondaryOddsProvider(env, silentLogger, primary);

    expect(provider).toBe(primary);
  });
});
