import type { Env } from "../config/env.js";
import type { FootballDataProvider } from "./types.js";
import { NullProvider } from "./NullProvider.js";

// Single place that decides which concrete provider backs the abstraction.
// Adding a real vendor (e.g. api-football) means writing one class that
// implements FootballDataProvider and registering it here — no other file
// in the app changes.
export function createProvider(env: Env): FootballDataProvider {
  switch (env.FOOTBALL_DATA_PROVIDER) {
    case "null":
      return new NullProvider();
    case "api-football":
      throw new Error(
        "FOOTBALL_DATA_PROVIDER=api-football is not implemented yet. " +
          "Implement ApiFootballProvider against FootballDataProvider and register it here."
      );
    default:
      return new NullProvider();
  }
}
