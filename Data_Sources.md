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

## Retry, backoff, and rate-limit handling

`ApiFootballProvider`'s private `request()` method retries a bounded number
of times (default 3, plus the initial attempt — configurable via the
constructor's `maxRetries` param) with exponential backoff plus jitter,
but only for failures that might succeed on a later attempt:

- **Retried**: request timeout, a thrown network error (DNS, connection
  reset, etc.), HTTP 5xx, and HTTP 429 — a 429's `Retry-After` header is
  honored instead of the default backoff when present.
- **Not retried**: HTTP 401/403 (a bad key will never succeed on retry),
  any other 4xx, a non-JSON body, or a body-level vendor error (API-Football
  returns HTTP 200 with an `errors` object for things like an invalid
  league id — retrying an unchanged malformed request wastes quota for an
  outcome that will never change).

Every attempt records the response's rate-limit headers (api-sports.io's
`x-ratelimit-requests-limit`/`x-ratelimit-requests-remaining`, or RapidAPI's
capitalized equivalents — read defensively, since neither has been
confirmed against a live response) via `getRateLimitStatus()`, and the
outcome of the most recently *completed* request (after retries) via
`getLastRequestStatus()`. Both back `GET /health/api-football` without that
endpoint making a live call on every poll. A warning is logged if remaining
quota drops below 5% of the limit.

None of this — the retry logic, the backoff timing, the specific
rate-limit header names — has been exercised against a live response
either; it's implemented from api-football's documented headers and HTTP
semantics, tested against an injected fake `fetch`
(`backend/src/__tests__/apiFootballProvider.test.ts`), same caveat as
everything else in this file.

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
- `OddsProvider` — `getOdds(fixture)`

`FootballDataProvider` composes all seven. Every method returns a
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

`getStandings` returns a typed `ProviderStanding[]` too. The vendor nests a
competition's table(s) inside `league.standings` as an array of arrays (one
inner array per group — most competitions have exactly one, but a group
stage or a split championship/relegation round has several); the mapping
flattens all of them, since neither `ProviderStanding` nor the `standings`
table tracks which group a row came from (see `Database.md`'s note on that
simplification).

`getLineup` returns a typed `ProviderLineup[]` — one entry per team, since
a single fixture call returns both sides at once, unlike every other
provider method here which is scoped to one team (or one competition) per
call. `ApiFootballProvider` reasons (from the vendor's documentation,
unverified against a live response) that this endpoint only ever returns
officially released lineups, never a "predicted" one, and always maps
accordingly — see the lineups ingestion section below.

`getOdds` returns a typed `ProviderOdds[]` — one entry per bookmaker, each
carrying a list of `{ market, selection, decimalOdds }` selections.
`ApiFootballProvider.mapOdds` restricts this to `1x2`/`btts`/`over_under_2_5`,
classifying each vendor "bet" by its name (`mapBet`) and dropping any
bookmaker left with zero covered-market selections after filtering —
unverified against a live response, like every other mapping in this file.
The prediction engine also now produces `double_chance` and `correct_score`
(see `ML_Model.md`), but `mapOdds` doesn't cover either yet — those two
markets have model probabilities only, with no bookmaker odds ingested to
compare against (no value-analysis for them until this mapping is
extended, per `ProviderOddsSelection`'s comment in `providers/types.ts`).

**Shared helper extraction:** once a third sync job needed the same
"batch-lookup a table's rows by internal id, then read each one's provider
external id" logic, that logic moved out of each job file and into
`referenceDataService.ts` as `loadExternalRefs`/`externalId` — see its
export comments. `syncTeamStatistics.ts` and `syncInjuries.ts` were both
updated to use it instead of their own copies when this happened, rather
than leaving three near-identical implementations around.

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

## Standings ingestion: `syncStandings.ts`

`backend/src/jobs/syncStandings.ts::syncStandings` populates `standings`
from the vendor's own league-table endpoint:

1. Reads every distinct (competition, season) pair implied by real
   fixtures. Unlike team-statistics and injuries, this needs no
   external-key-based deduplication: an internal `competition_id` is
   already 1:1 with one real competition (it's a season's external id,
   not a competition's, that repeats across competitions — see
   `Database.md`), so plain internal-id dedup is enough.
2. Calls `provider.getStandings(competition, season)` — one call returns
   the entire table, not one row.
3. For each row, upserts a `teams` row (find-or-create by external id,
   same as fixture ingestion — the table gives each team's id and name) and
   then a `standings` row via a real `upsert(..., { onConflict:
   "season_id,team_id" })`, a genuine plain-column constraint from the
   initial schema.
4. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Each (competition, season) combination is processed independently. Trigger
it via `POST /api/admin/standings/sync`. This is the first job to give the
pre-existing `GET /standings/:leagueId` read route real data — that route
existed since the initial scaffold with nothing real to read until now.

**Known limitation:** flattens every group in the vendor's response into
one list — see the abstraction section above and `Database.md`.

## Lineups ingestion: `syncLineups.ts`

`backend/src/jobs/syncLineups.ts::syncLineups` populates `lineups` (and,
along the way, `players`) from the vendor's own lineups endpoint:

1. Reads real (non-synthetic) fixtures whose `kickoff_utc` falls within
   `±windowHours` of now (default 24) and whose status is `scheduled`,
   `live`, or `finished` — unlike the other sync jobs, this one is windowed
   around kickoff rather than scanning every fixture ever recorded, since
   lineups are only meaningful close to a match (spec section 6: "refresh
   closer to kickoff"). A symmetric window also picks up recently finished
   matches' confirmed lineups, which stay useful as team-news history.
2. For each fixture with a known external id (`fixtures.external_ref`,
   from `syncFixtures.ts`), calls `provider.getLineup(fixture)` — one call
   returns both teams, not one at a time.
3. An **empty** response is a normal, valid state (the vendor hasn't
   officially released the lineup yet), tracked separately as
   `fixturesNotYetAvailable` — not a failure, and nothing is written for
   that fixture.
4. For each team's lineup, upserts a `teams` row, a `players` row per named
   starter/substitute (find-or-create by external id, same pattern as
   injuries), and one `lineups` row via a real `upsert(..., { onConflict:
   "fixture_id,team_id" })` — a genuine plain-column constraint from the
   initial schema. Always writes `confirmation_status: 'confirmed'` — see
   the abstraction section above for the reasoning and its caveat.
5. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Each fixture (and each team's lineup within it) is processed
independently. Trigger it via `POST /api/admin/lineups/sync?hours=N`
(default 24, capped at 168 — see `admin.ts`).

**Known limitation:** `confirmation_status` is never written as
`'expected'` — this job either gets a confirmed lineup or nothing. If a
future provider (or a change in how api-football's endpoint actually
behaves) surfaces predicted lineups too, `ProviderLineup` needs a field to
carry that distinction through; don't just keep assuming every response is
confirmed (see `Task.md`).

## Odds ingestion: `syncOdds.ts`

`backend/src/jobs/syncOdds.ts::syncOdds` populates `odds_snapshots` from
the vendor's own odds endpoint:

1. Reads real (non-synthetic) fixtures whose `kickoff_utc` falls within
   `±windowHours` of now (default 24) and whose status is `scheduled` or
   `live` — windowed around kickoff like lineups, since odds are only
   meaningful for a match that hasn't been decided yet. Unlike
   `syncLineups.ts`, `finished` fixtures are excluded: there's no
   "closing odds" use case built on this schema yet.
2. For each fixture with a known external id, calls `provider.getOdds(fixture)`.
3. An **empty** response is a normal, valid state (no bookmaker has posted
   a covered-market price yet), tracked separately as
   `fixturesNotYetAvailable` — not a failure.
4. For each bookmaker/selection returned, inserts one `odds_snapshots` row
   via a plain `.insert()` — **deliberately not an upsert**. Every other
   sync job in this repo treats its target table as "current state" and
   upserts against a real or find-then-insert key; `odds_snapshots` is a
   genuine price-history time series (spec section 25 wants price
   movement, not just a current price), so overwriting would destroy the
   history the table exists to keep. This means running the job twice with
   unchanged prices produces two rows, not one — see `Database.md`'s
   "Known gaps" for the de-duplication optimization this doesn't attempt.
5. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Each fixture (and each bookmaker/selection within it) is processed
independently. Trigger it via `POST /api/admin/odds/sync?hours=N` (default
24, capped at 168 — see `admin.ts`).

**Known limitation:** no de-duplication against the immediately preceding
snapshot, so a tight sync schedule grows the table even when nothing
changed (see `Task.md`). Also unverified against a live response, like
every mapping in this file — `mapBet`'s market classification is a
best-effort guess at the vendor's bet-name strings, not a documented enum.

## Scheduler: `backend/src/scheduler/scheduler.ts`

Every sync/prediction job above exists as a plain async function callable
from an admin route (manual) or from a cron tick (automatic) — the jobs
themselves don't know or care which. `startScheduler()` wires the latter,
using [`node-cron`](https://www.npmjs.com/package/node-cron), when
`SCHEDULER_ENABLED=true` (`backend/.env.example`, off by default):

- Fixtures, team-statistics, injuries, and standings run once daily,
  staggered 15–30 minutes apart in that order (`02:00`, `02:30`, `02:45`,
  `03:00` UTC) so each starts after the one it depends on has had time to
  finish — team-statistics/injuries/standings all read fixtures that
  `syncFixtures` just wrote. Predictions run once daily after that, at
  `03:15` UTC, reading the `team_statistics` those jobs just wrote.
- Lineups and odds run every 15 minutes (offset from each other, `:00/:15/
  :30/:45` and `:05/:20/:35/:50`), since both are only meaningful/accurate
  close to kickoff (spec section 6: "refresh closer to kickoff") — running
  them once a day like the others would defeat the point.
- If no data provider is configured (`FOOTBALL_DATA_PROVIDER=null`), the
  six sync jobs are **not scheduled at all** — one clear warning is logged
  at startup instead of silently no-op'ing on every tick forever. The
  predictions job is still scheduled regardless, since it reads from the
  database rather than calling the provider (matching `/admin/predictions/run`,
  which has never required a provider either).
- Each scheduled run is wrapped (`guarded()`) so a thrown or rejected error
  is logged and swallowed rather than surfacing as an unhandled rejection
  inside node-cron's timer callback — one job failing must never crash the
  process or block a later tick of any job. node-cron's `noOverlap` option
  is set on every task, so a slow run of a 15-minute job can't overlap with
  the next tick of itself.

**Known limitation — single instance only.** `node-cron` has no
cross-process coordination. Running the backend as more than one replica
with `SCHEDULER_ENABLED=true` would have every replica independently
scheduling and running the same jobs, syncing (and, for `syncOdds.ts`,
appending odds snapshots) redundantly N times over rather than once. Fine
for today's single-instance deployment (`Deployment.md`); a distributed
lock or moving scheduling to an external trigger (Cloud Scheduler hitting
the existing admin endpoints) would be needed before scaling out.

**Also not done:** cron cadences are fixed constants in `scheduler.ts`, not
env-configurable — no real operational need for per-environment tuning has
come up yet. And none of this has been observed running for real over
multiple days; it's unit-tested against fakes (`backend/src/__tests__/scheduler.test.ts`)
and was smoke-tested by booting the server for a few seconds and confirming
the startup logs and a clean `SIGTERM` shutdown — not the same as watching
it actually drive a real ingestion pipeline over days of wall-clock time.

## Observability: job history and health endpoints

The infrastructure needed to actually *observe* the scheduler (rather than
just run it) already existed in part — every sync job has always written
an `ingestion_runs` row per invocation — but nothing read it back until
now, and the `predictions` job didn't write one at all.

- `runLatestPoissonPredictionsJob` (`generatePredictions.ts`) now also
  writes an `ingestion_runs` row (`job_name: "predictions"`,
  `provider: "ml-service"` — it doesn't call the football data provider, it
  reads `team_statistics` and calls the local ML microservice), so
  predictions show up in job history the same way the six sync jobs do.
- `GET /admin/jobs` and `GET /admin/jobs/summary` (`admin.ts`) read that
  table back — recent runs, and a last-run/last-succeeded-run summary per
  `job_name`. This is the concrete thing to watch during the scheduler's
  multi-day observation period once one starts (see `Task.md`): job
  success rate, whether any job is stuck on `"partial"`/`"failed"`, and
  whether `records_processed` keeps growing sanely instead of flatlining
  or exploding (the latter would flag `syncOdds.ts`'s known lack of
  de-duplication becoming a real problem, not just a theoretical one).
- `GET /health/scheduler` reports whether the in-process scheduler is
  running and each job's next scheduled run (`scheduler.ts`'s new
  `status()` method, backed by node-cron's `getNextRun()`).
- `GET /health/api-football` reports connectivity derived from the
  provider's own request history (`getLastRequestStatus()`/
  `getRateLimitStatus()`, above) — deliberately not a live ping on every
  poll, to avoid spending API quota on health checks.
- `GET /health/data` now includes per-dataset freshness
  (LIVE/RECENT/STALE/UNAVAILABLE, plus a GREEN/YELLOW/RED/GRAY color) for
  fixtures, standings, team-statistics, injuries, lineups, odds, and
  predictions, using the existing `freshness.ts` thresholds against each
  table's most recent non-synthetic `source_timestamp`
  (`captured_at`/`generated_at` for odds/predictions respectively).

None of this required new tables or new libraries — it's all built on the
`ingestion_runs` table and `freshness.ts` classifier that already existed;
what was missing was simply reading them back through an endpoint.

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

## Weather, news

Weather and news have no provider interface yet — add one following the
same pattern when a real source is chosen. `backend/.env.example` reserves
`WEATHER_API_KEY` for when that happens. (`ODDS_API_KEY` is no longer
reserved for a separate provider — odds now come from `ApiFootballProvider`
itself, via `getOdds`; see the odds ingestion section above.)
