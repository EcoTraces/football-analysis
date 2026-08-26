# Data Sources

## Current state: no provider configured

`FOOTBALL_DATA_PROVIDER=null` (the default) uses `NullProvider`
(`backend/src/providers/NullProvider.ts`), which returns
`{ ok: false, reason: "not_configured" }` from every method. This is
deliberate — see `Coding_Rules.md` → "No Fake Data Rule." No demo/plausible
data is substituted.

## The abstraction

`backend/src/providers/types.ts` defines the contracts application code
depends on:

- `FixtureProvider` — `getFixturesForDateRange`
- `ResultsProvider` — `getResultsSince`
- `TeamStatsProvider` — `getTeamStatistics`
- `InjuryProvider` — `getInjuries`
- `LineupProvider` — `getLineup`
- `StandingsProvider` — `getStandings`
- `OddsProvider` — `getOdds` (not yet consumed by any route/job)

`FootballDataProvider` composes the first six. Every method returns a
`ProviderResponse<T>` — either `{ ok: true, data, sourceTimestamp,
provider }` or `{ ok: false, reason, message, provider }` with `reason` one
of `not_configured | rate_limited | upstream_error | timeout |
unauthorized`. Callers must handle both branches explicitly; there is no
"just return empty array on error" shortcut that could be mistaken for "no
data exists."

## Adding a real provider

1. Pick a reputable source (spec section 5): an official league/competition
   feed, an established football-stats API (with a license permitting this
   use), or similar. Confirm rate limits, attribution requirements, and
   terms of service before writing code against it.
2. Implement a class satisfying `FootballDataProvider` — e.g.
   `backend/src/providers/ApiFootballProvider.ts` — that calls the vendor's
   API, maps its response shape into `ProviderFixture` (etc.), and returns
   `{ ok: false, reason: "upstream_error", ... }` on any failure rather than
   throwing or returning partial/guessed data.
3. Add its required env vars to `backend/.env.example` and
   `backend/src/config/env.ts` (extend the `FOOTBALL_DATA_PROVIDER` enum).
4. Register it in `backend/src/providers/registry.ts`.
5. Write an ingestion job (parallel to `generatePredictions.ts`) that calls
   the provider and upserts into the relevant table, using the
   provider-agnostic natural-key unique indexes already in the schema
   (`Database.md`) so repeated runs don't duplicate rows.
6. Set `source`/`source_timestamp` on every row you write — the freshness
   classifier (`backend/src/lib/freshness.ts`) depends on it.

No other file — no route, no service, no frontend component — should need
to change. If it does, the abstraction has a gap; fix the interface, not the
caller.

## Odds, weather, news

`OddsProvider` exists in `types.ts` but has no consumer yet (value analysis
per spec section 25 isn't built). Weather and news have no provider
interface yet — add one following the same pattern when a real source is
chosen. `backend/.env.example` reserves `ODDS_API_KEY` and `WEATHER_API_KEY`
for when that happens.
