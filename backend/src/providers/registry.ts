import type { Env } from "../config/env.js";
import type { FootballDataProvider } from "./types.js";
import { NullProvider } from "./NullProvider.js";
import { ApiFootballProvider } from "./ApiFootballProvider.js";

// Single place that decides which concrete provider backs the abstraction.
// Adding a real vendor means writing one class that implements
// FootballDataProvider and registering it here — no other file in the app
// changes.
export function createProvider(env: Env): FootballDataProvider {
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
      return new ApiFootballProvider(env.FOOTBALL_DATA_API_KEY);
    default:
      return new NullProvider();
  }
}
