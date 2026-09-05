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

// A second, always-attempted provider used ONLY for odds/injuries/lineups
// (see scheduler.ts/matchFixturesToSecondaryProvider.ts) — independent of
// FOOTBALL_DATA_PROVIDER, which still decides the single source of truth
// for fixtures/results/team-stats/standings. This is what lets a
// deployment run football-data.org as its primary fixtures/results source
// while still getting real odds/injuries/lineups from API-Football, which
// football-data.org's plan doesn't cover.
//
// Hardcoded to api-football rather than a second switch statement:
// currently it's the only vendor this app maps odds/injuries/lineups from
// with any real fidelity. Revisit if a second odds/injuries/lineups-
// capable vendor is ever added. Falls back to NullProvider (never a
// crash, never a silent reuse of a DIFFERENT primary provider) when
// FOOTBALL_DATA_API_KEY isn't set, so a deployment that only wants
// football-data.org fixtures with no odds/injuries/lineups coverage keeps
// working exactly as it did before this existed — every fixture then just
// stays UNAVAILABLE for those three domains, the same honest signal as
// any other unconfigured provider (see NullProvider.ts).
//
// Accepts the already-constructed primary provider so that when
// FOOTBALL_DATA_PROVIDER=api-football too, this reuses that SAME instance
// rather than standing up a second one — two independent ApiFootballProvider
// objects for the same vendor account would track rate-limit/last-request
// state separately, making GET /health/api-football's report incomplete
// (it only ever reads the primary instance).
export function createSecondaryOddsProvider(env: Env, logger: Logger, primary?: FootballDataProvider): FootballDataProvider {
  if (primary?.name === "api-football") return primary;
  if (!env.FOOTBALL_DATA_API_KEY) return new NullProvider();
  return new ApiFootballProvider(
    env.FOOTBALL_DATA_API_KEY,
    undefined,
    undefined,
    undefined,
    logger,
    undefined,
    undefined,
    env.FOOTBALL_DATA_RAPIDAPI_KEY || undefined
  );
}
