# Data Sources

## Current state: `ApiFootballProvider` implemented, disabled by default

`FOOTBALL_DATA_PROVIDER=null` (the default) uses `NullProvider`
(`backend/src/providers/NullProvider.ts`), which returns
`{ ok: false, reason: "not_configured" }` from every method — see
`Coding_Rules.md` → "No Fake Data Rule."

Setting `FOOTBALL_DATA_PROVIDER=api-football` and a real
`FOOTBALL_DATA_API_KEY` switches to `ApiFootballProvider`
(`backend/src/providers/ApiFootballProvider.ts`), a real implementation
against [api-football](https://www.api-football.com) (api-sports.io) v3.
Chosen over narrower alternatives (e.g. football-data.org) for its coverage
outside Europe's top leagues, which the platform's stated scope (Asia,
South America, etc.) needs.

**Important caveat:** this class has not been exercised against a live API
key in development — none was available in the environment it was written
in. Every request shape and response mapping follows the vendor's published
v3 documentation, not a verified live response, and is covered by unit
tests using injected fake HTTP responses (`backend/src/__tests__/apiFootballProvider.test.ts`),
not live calls. Before relying on it: get a real key, run `POST
/api/admin/sync?days=1` against a real Supabase project, and check
`ingestion_runs.error_summary` for anything indicating the mapping needs
adjusting (the vendor's actual field names/shapes can differ from what's
documented, or change over time).

If you don't need worldwide coverage, football-data.org's free tier (top
European competitions, simpler API, no league/season params required for
most endpoints) may be an easier first integration — it would need its own
provider class following the same pattern.

## The abstraction

`backend/src/providers/types.ts` defines the contracts application code
depends on:

- `FixtureProvider` — `getFixturesForDateRange` (single UTC day per call —
  see below)
- `ResultsProvider` — `getResultsSince`
- `TeamStatsProvider` — `getTeamStatistics(team, competition, season)`
- `InjuryProvider` — `getInjuries(team, season)`
- `LineupProvider` — `getLineup(fixture)`
- `StandingsProvider` — `getStandings(competition, season)`
- `OddsProvider` — `getOdds` (not yet consumed by any route/job)

`FootballDataProvider` composes the first six. Every method returns a
`ProviderResponse<T>` — either `{ ok: true, data, sourceTimestamp,
provider }` or `{ ok: false, reason, message, provider }` with `reason` one
of `not_configured | rate_limited | upstream_error | timeout |
unauthorized`. Callers must handle both branches explicitly.

`getTeamStatistics` and `getInjuries` take a competition/season alongside
the team id — added after implementing the real provider revealed that
vendors scope team stats per competition (a team in two competitions the
same season has different stats in each), not just per season as the
interface originally assumed. This is the abstraction adapting to a real
integration's actual requirements, not a workaround. `getTeamStatistics`
returns a typed `ProviderTeamStatistics` (matches played/goals for/against,
overall and split by home/away, plus clean sheets and failed-to-score where
the vendor provides them) rather than `unknown` — `ApiFootballProvider`
maps the vendor's raw shape and returns `{ ok: false, reason:
"upstream_error" }` if the response is missing fields the mapping needs,
rather than writing zeros that would be indistinguishable from a team that
actually has a blank record.

`ProviderFixture` carries denormalized names (`competitionName`,
`countryName`, `homeTeamName`, etc.) alongside external ids — real
ingestion needs them to create reference rows (countries/competitions/
teams/seasons) the first time it sees an entity; see below.

`getInjuries` similarly returns a typed `ProviderInjury[]` rather than
`unknown[]` — each entry is one (player, fixture) report, not a
current-status snapshot (the vendor's endpoint reports "this player missed
this fixture," not "this player is currently out"); see the injuries
ingestion section below for how the sync job turns that into one row per
player. `status` is a best-effort classification from the vendor's
free-text `type`/`reason` fields (`ApiFootballProvider.ts::mapInjuryStatus`)
— there's no documented enum to map onto this schema's status column, so
treat it as a heuristic, not a guarantee, until checked against live data.

### Single-day constraint

`ApiFootballProvider.getFixturesForDateRange` only accepts a single UTC day
per call — the vendor's `/fixtures` endpoint takes one `date`, not a range.
A multi-day request returns `{ ok: false, reason: "upstream_error" }`
without making a network call. Callers wanting a range iterate day-by-day
themselves (`backend/src/jobs/syncFixtures.ts::utcDaysInRange`).

## Fixture ingestion: `syncFixtures.ts`

`backend/src/jobs/syncFixtures.ts::syncFixturesForDateRange` is the first
real ingestion job:

1. For each UTC day in the range, calls the provider for that day's
   fixtures. A failed day is logged and skipped — it doesn't abort the rest
   of the run.
2. For each fixture, resolves (creating if needed) its country, competition,
   season, and both teams via `backend/src/services/referenceDataService.ts`,
   matched by the provider's own external id (`external_ref->>'api_football'`)
   — except countries, which the fixtures endpoint only gives a *name* for
   (no stable id), so those are matched/created by name instead.
3. Upserts the fixture itself, matched by its own external id (not by
   team+kickoff — a postponed-and-rescheduled fixture keeps the same
   provider id but a different kickoff time, so matching on the id is what
   makes re-syncing safe).
4. Writes one `ingestion_runs` row per invocation (`succeeded` / `partial` /
   `failed`) recording how many fixtures were processed vs. rejected, for
   the admin data-health view.

Each fixture is processed independently — one fixture's reference-data
resolution failing doesn't lose the others in the same batch (spec section
38: per-item isolation). Trigger it via `POST /api/admin/sync?days=N`
(`N` capped at 14 — see `admin.ts`; that endpoint has no auth yet, so this
cap is a stopgap against an expensive accidental call, not a real
authorization control).

**Known limitation:** reference-data lookups are find-then-insert (two
round trips), not an atomic `INSERT ... ON CONFLICT`, because the unique
constraints involved are partial indexes over a jsonb expression
(`external_ref->>'api_football'`) and this repo has no live database to
verify that PostgREST's `on_conflict` parameter matches such an index
correctly. This means two concurrent sync runs could theoretically both
insert the same external id. Not a problem for the current single periodic
job; revisit before parallelizing ingestion (see `Task.md`).

**Also not yet done:** team nationality/country is intentionally left
`null` by this job — the fixtures payload only gives the *competition's*
country, and assigning that to each team would be wrong for continental
competitions and only coincidentally right for domestic ones. A dedicated
team-info sync (using the vendor's `/teams` endpoint, which does give each
team's own country) is needed before that field is populated — see
`Task.md`.

## Team-statistics ingestion: `syncTeamStatistics.ts`

`backend/src/jobs/syncTeamStatistics.ts::syncTeamStatistics` populates
`team_statistics` from the vendor's own aggregated per-team stats endpoint
— it does not compute anything from our own `fixtures` rows:

1. Reads every distinct (team, competition, season) combination implied by
   real (non-synthetic) fixtures — both home and away sides — and
   deduplicates them, so a team with nineteen home fixtures in one
   competition/season only costs one provider call for that combination,
   not nineteen.
2. Looks up each team/competition/season's external id (batched via `.in()`
   queries, not one row at a time) and skips any combination missing one —
   can't call the provider without it, and this is not treated as an error
   worth failing the run over.
3. Calls `provider.getTeamStatistics(team, competition, season)` and writes
   three rows per combination — `overall`, `home`, `away` scopes — via a
   real `upsert(..., { onConflict: "team_id,season_id,scope" })`, since
   `team_statistics`'s uniqueness constraint is a genuine plain-column
   constraint (unlike fixtures/teams/competitions/seasons — see
   `Database.md`), so PostgREST's `on_conflict` is documented to work
   against it correctly.
4. Writes one `ingestion_runs` row per invocation, same as `syncFixtures.ts`.

Each combination is processed independently — one team's provider call
failing doesn't lose the others (same per-item isolation as
`syncFixtures.ts`). Trigger it via `POST /api/admin/team-statistics/sync`,
**after** `/api/admin/sync` (it reads from `fixtures`, so there must be some
to read) and **before** `/api/admin/predictions/run` (which reads from
`team_statistics`, not from fixtures' scores directly).

**Known limitation:** this only ever writes `overall`/`home`/`away` scopes.
`last_5`/`last_10` rolling windows (spec section 9) need match-by-match
results, which the vendor's aggregated `/teams/statistics` endpoint doesn't
provide — that needs a separate results-sync job pulling and storing
individual match results, not an extension of this one (see `Task.md`).

## Injuries ingestion: `syncInjuries.ts`

`backend/src/jobs/syncInjuries.ts::syncInjuries` populates `players` and
`injuries` from the vendor's own injuries endpoint:

1. Reads every distinct (team, season) pair implied by real
   (non-synthetic) fixtures — both home and away sides. Unlike
   `syncTeamStatistics.ts`, this is **not** scoped by competition: the
   provider's `/injuries` endpoint only takes team+season (a player's
   injury doesn't depend on which competition a fixture belongs to), so
   the dedup key is the (teamExternalId, seasonExternalId) pair actually
   sent to the provider — two internal `season_id` rows for the same team
   (one per competition) sharing the same external season id (e.g. both
   "2026") collapse into a single call rather than two redundant ones.
2. Calls `provider.getInjuries(team, season)`. The response is one entry
   per (player, fixture) the player was reported missing for — not a
   single current-status flag — so for each team's results, only the most
   recently dated report per player is kept
   (`syncInjuries.ts::mostRecentPerPlayer`) as the closest available proxy
   for "their status right now."
3. For each kept report, upserts a `players` row (find-or-create by
   external id, same pattern as teams/competitions) and then an `injuries`
   row via a real `upsert(..., { onConflict: "player_id" })` — a genuine
   plain-column constraint added in migration 0003, same category as
   `team_statistics`'s.
4. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Each (team, season) combination is processed independently — one team's
provider call failing doesn't lose the others. Trigger it via `POST
/api/admin/injuries/sync`.

**Known limitation — no "returned" transition.** This schema models
"current status per player," and a player who recovers simply stops
appearing in fresh reports; nothing in this job detects that and flips
their row to `returned`. Their last-known row just goes stale, which the
freshness classifier (`backend/src/lib/freshness.ts`) surfaces to callers
as `STALE` rather than this job guessing at recovery — an honest "we don't
know anymore," not a wrong "still injured" being actively reasserted. A
future improvement (e.g. detecting the player in a subsequent confirmed
lineup) is tracked in `Task.md`, not implemented here.

**Also unverified:** the `status` classification is a keyword heuristic
over free text with no documented enum behind it — see the abstraction
section above and `Task.md`.

## Adding another provider

1. Pick a reputable source (spec section 5) and confirm rate limits,
   attribution requirements, and terms of service before writing code
   against it.
2. Implement a class satisfying `FootballDataProvider`, following
   `ApiFootballProvider.ts`'s pattern: injectable `fetch` and timeout for
   testability, explicit mapping to `ProviderFixture` (etc.), and
   `{ ok: false, reason: "upstream_error", ... }` on any failure rather than
   throwing or returning partial/guessed data.
3. Add its required env vars to `backend/.env.example` and
   `backend/src/config/env.ts` (extend the `FOOTBALL_DATA_PROVIDER` enum).
4. Register it in `backend/src/providers/registry.ts` — fail fast at boot
   if required config is missing rather than silently falling back to
   `NullProvider` (see the `api-football` case for the pattern).
5. Write an ingestion job (`syncFixtures.ts` is the template) using the
   external-id-based upsert approach in `referenceDataService.ts` so
   repeated runs don't duplicate rows.
6. Set `source`/`source_timestamp` on every row you write — the freshness
   classifier (`backend/src/lib/freshness.ts`) depends on it.
7. Write unit tests against an injected fake `fetch`, the way
   `apiFootballProvider.test.ts` does — this repo has no live credentials
   to test against in CI, so the mapping logic has to be verifiable without
   one.

No route, no service, no frontend component should need to change to add a
provider. If one does, the abstraction has a gap; fix the interface, not
the caller.

## Odds, weather, news

`OddsProvider` exists in `types.ts` but has no consumer yet (value analysis
per spec section 25 isn't built). Weather and news have no provider
interface yet — add one following the same pattern when a real source is
chosen. `backend/.env.example` reserves `ODDS_API_KEY` and `WEATHER_API_KEY`
for when that happens.
