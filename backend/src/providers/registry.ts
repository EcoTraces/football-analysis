import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import type { FootballDataProvider } from "./types.js";
import { NullProvider } from "./NullProvider.js";
import { ApiFootballProvider } from "./ApiFootballProvider.js";
import { FootballDataOrgProvider } from "./FootballDataOrgProvider.js";

// Single place that decides which concrete provider backs the abstraction.
// Adding a real vendor means writing one class that implements
// FootballDataProvider and registering it here — no other file in the app
// changes.
export function createProvider(env: Env, logger: Logger): FootballDataProvider {
  switch (env.FOOTBALL_DATA_PROVIDER) {
    case "null":
      return new NullProvider();
    case "api-football":
      if (!env.FOOTBALL_DATA_API_KEY) {
        // Fail fast rather than silently falling back to NullProvider — if
        // an operator explicitly asked for a real provider, running with no
        // data and no explanation is worse than refusing to boot.
        throw new Error(
          "FOOTBALL_DATA_PROVIDER=api-football requires FOOTBALL_DATA_API_KEY to be set. " +
            "See backend/.env.example and Data_Sources.md."
        );
      }
      // FOOTBALL_DATA_RAPIDAPI_KEY is optional — an empty string (the
      // default) is passed through as-is, which ApiFootballProvider treats
      // as "no backup configured" (see its routes() — a falsy key means the
      // provider only ever has one route, same as before this option
      // existed).
      return new ApiFootballProvider(env.FOOTBALL_DATA_API_KEY, undefined, undefined, undefined, logger, undefined, undefined, env.FOOTBALL_DATA_RAPIDAPI_KEY || undefined);
    case "football-data-org":
      if (!env.FOOTBALL_DATA_ORG_API_KEY) {
        throw new Error(
          "FOOTBALL_DATA_PROVIDER=football-data-org requires FOOTBALL_DATA_ORG_API_KEY to be set. " +
            "See backend/.env.example and Data_Sources.md."
        );
      }
      return new FootballDataOrgProvider(env.FOOTBALL_DATA_ORG_API_KEY, undefined, undefined, undefined, logger);
    default:
      return new NullProvider();
  }
}
