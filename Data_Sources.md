# Data Sources

## Current state: two real providers implemented, `null` disabled by default

`FOOTBALL_DATA_PROVIDER=null` (the default) uses `NullProvider`
(`backend/src/providers/NullProvider.ts`), which returns
`{ ok: false, reason: "not_configured" }` from every method — see
`Coding_Rules.md` → "No Fake Data Rule."

Two real providers exist. **Pick exactly one** — see "Two providers, never
blended" below for why this platform never runs both against the same data
at once:

- **`FOOTBALL_DATA_PROVIDER=api-football`** + a real `FOOTBALL_DATA_API_KEY`
  switches to `ApiFootballProvider` (`backend/src/providers/ApiFootballProvider.ts`),
  a real implementation against [api-football](https://www.api-football.com)
  (api-sports.io) v3. Broad coverage outside Europe's top five leagues,
  which the platform's stated scope (Asia, South America, etc.) needs —
  but its free tier caps at 100 requests/**day**. Covers fixtures,
  standings, team/player statistics, injuries, lineups, and odds. An
  optional RapidAPI backup channel exists for this provider specifically —
  see "Optional RapidAPI backup channel" below.
- **`FOOTBALL_DATA_PROVIDER=football-data-org`** + a real
  `FOOTBALL_DATA_ORG_API_KEY` switches to `FootballDataOrgProvider`
  (`backend/src/providers/FootballDataOrgProvider.ts`), a real
  implementation against [football-data.org](https://www.football-data.org)
  v4. Only 12 major competitions on its free tier, but no daily cap (10
  requests/**minute** instead) and curated, non-crowd-sourced data. Covers
  fixtures and standings only — see "football-data.org: a swappable
  alternative provider" below for exactly what its free tier does and
  doesn't offer.

**Important caveat, `ApiFootballProvider`:** this class has never been
exercised against a live API key in this environment — none has been
available. Every request shape and response mapping follows the vendor's
published documentation, not a verified live response, and is covered only
by unit tests using injected fake HTTP responses
(`backend/src/__tests__/apiFootballProvider.test.ts`), not live calls.
Before relying on it: get a real key, run `POST /api/admin/sync?days=1`
against a real Supabase project, and check `ingestion_runs.error_summary`
for anything indicating the mapping needs adjusting.

**`FootballDataOrgProvider` — partially verified against live data
(2026-09-03).** A real key was exercised directly against the vendor's
live v4 API (bypassing the database/Supabase layer, which no real project
in this environment can reach — see "What was and wasn't verified" below).
Real fixtures (186 matches, correctly split live/finished/scheduled),
Premier League standings (60 rows, correct team names/positions/points),
the `not_configured` short-circuit for unsupported capabilities, and error
handling all matched expectations — with one real, live-caught bug: the
vendor's own docs name the rate-limit header `X-RequestsAvailable`, but a
live response actually sends `x-requests-available-minute` — fixed in
`recordRateLimitHeaders()` (was silently always returning `null` before
this). A second live check confirmed the error envelope really is
`{ message, errorCode }` on at least one endpoint (a documented example
elsewhere shows `{ error }`) — `unavailableFromBody()` already checked
`body.error ?? body.message` defensively before this, which is exactly why
that fix wasn't needed too.

**What was and wasn't verified.** The live check exercised
`FootballDataOrgProvider`'s own HTTP request/response mapping directly —
it did **not** exercise `syncFixtures.ts`/`syncStandings.ts` writing real
rows into a real Supabase project (no live Supabase project is reachable
from this environment), so the reference-data upsert path
(`providerRefKey`, `external_ref` matching, idempotency on a second run)
for this specific provider remains unverified beyond its `FakeSupabase`
unit tests. `getFixturesForDateRange`/`getResultsSince`/`getStandings` and
the rate-limit/error-handling paths are now genuinely live-verified;
`getTeamStatistics`/`getPlayerStatistics`/`getInjuries`/`getLineup`/
`getOdds`/`getFixtureStatistics` never make a live call at all (by design —
see the capability table below), so "verified" for them just means the
short-circuit itself was confirmed to fire correctly, not that a live
endpoint was checked.

## Two providers, never blended

`referenceDataService.ts` keys every entity (`countries` excepted — see
below) by `external_ref->>'<provider_key>'`, where `<provider_key>` is
derived from the active provider's own `FootballDataProvider.name`
(`providerRefKey()` — e.g. `"api-football"` → `"api_football"`,
`"football-data-org"` → `"football_data_org"`). **Nothing in this platform
resolves "api-football's team 33" and "football-data-org's team 66" as the
same real Manchester United** — the two vendors use entirely unrelated
numeric id schemes for the same real-world teams/competitions, and there is
no fuzzy name-matching entity-resolution layer (deliberately not built —
see the plan discussion that scoped this feature: a wrong fuzzy match would
silently corrupt team_statistics/predictions, a worse failure than simply
not merging).

This is why `FOOTBALL_DATA_PROVIDER` is a single-value switch, not a list:
**exactly one provider is active in a given deployment/environment.**
Practical consequences:

- **Switching providers starts fresh entity rows.** If you sync with
  `api-football` for a while, then switch to `football-data-org`, the next
  sync creates new `teams`/`competitions`/`seasons`/`fixtures` rows keyed
  under `football_data_org` — it does not find or update the rows
  `api-football` already created. Old rows aren't deleted; they just stop
  being touched by new syncs.
- **Migrations `0002`/`0003` and `0014` each add their own provider's
  partial unique indexes** (`external_ref->>'api_football'` /
  `external_ref->>'football_data_org'` respectively) on the same tables —
  so the same real-world external id colliding between two providers (e.g.
  both happening to use `"39"` for the Premier League) never causes a false
  match; each index only enforces uniqueness within its own provider's key.
  Verified directly against a real Postgres 16 instance: two rows with the
  same external id under different provider keys coexist safely, while a
  genuine duplicate within one provider's key is correctly rejected.
- **`countries` is the one exception** — every provider matches/creates
  countries by name (`upsertCountryByName`), not external_ref, since a
  country has no stable, comparable external id worth keying on across
  vendors anyway (a name collision here, e.g. "England", is actually the
  correct match). `0002`'s `uq_countries_external_api_football` index (and
  `0014` deliberately does *not* add a football-data-org equivalent) is
  unused dead schema for this reason, same as it always was.

## football-data.org: a swappable alternative provider

`FootballDataOrgProvider` implements the full `FootballDataProvider`
interface, but its free tier genuinely only supports two of the nine
capabilities that interface declares:

| Capability | Support |
|---|---|
| `getFixturesForDateRange` / `getResultsSince` | **Real.** `GET /v4/matches?dateFrom=&dateTo=` — and unlike `ApiFootballProvider`, this vendor's endpoint genuinely accepts a multi-day range in one call, no single-UTC-day workaround needed. |
| `getStandings` | **Real.** `GET /v4/competitions/{id}/standings`. |
| `getTeamStatistics`, `getPlayerStatistics`, `getInjuries`, `getLineup`, `getOdds`, `getFixtureStatistics` | **`reason: "not_configured"`, always** — this vendor's free tier has no endpoint for any of these. Same "never fabricate, no data no market" contract `NullProvider` already establishes for an unconfigured provider entirely — a sync job calling one of these against `football-data-org` simply logs a per-item skip/failure and moves on, exactly as it already does for any other real provider failure. |

Two mapping decisions worth calling out:

- **The season external id is the season's start year, not the vendor's
  opaque `season.id`.** football-data.org's `/standings` endpoint takes an
  optional `?season=<year>` query param (e.g. `2026`) — using that same
  year as this platform's season external id means `getStandings` can
  forward `seasonExternalId` straight through with no separate id-to-year
  lookup, and it happens to match api-football's own convention of using
  the year as its season external id too.
- **`SUSPENDED` maps to this schema's `"abandoned"` status** — the closest
  available match; football-data.org's status enum has no "will resume
  later" distinction from "stopped for good," same reasoning
  `ApiFootballProvider`'s own `ABD → abandoned` mapping uses.

**Rate-limit tracking is a different shape from api-football's.** The
vendor's docs (https://docs.football-data.org/general/v4/lookup_tables.html)
name the header `X-RequestsAvailable`; a live response actually sends
`x-requests-available-minute` (confirmed 2026-09-03 — see "What was and
wasn't verified" above), which is what `recordRateLimitHeaders()` reads.
Also present but unused: `X-RequestCounter-Reset` (seconds until reset) —
no header for the total limit itself, unlike api-football's paired
limit+remaining headers. So `FootballDataOrgProvider.getRateLimitStatus().limit`
is always `null` — never guessed at from the documented "10/minute free
tier" figure, since a different plan would make that wrong.

**Error handling.** football-data.org's documented error statuses are
400/403/404/429, with no separate 401 — both a missing and an invalid token
report as 403 "restricted resource," so 401 and 403 are both mapped to
`unauthorized` here (matching `ApiFootballProvider`'s own 401‖403 handling),
and neither is retried on the same channel. The error body itself is a flat
`{ error: string }` (or `{ message: string }`) — a different envelope shape
from api-football's `{ response, errors }`.

**`GET /health/api-football` now reports whichever HTTP-backed provider is
actually configured**, not just `api-football` specifically — it duck-types
against a small `ObservableHttpProvider` interface (`getRateLimitStatus()`/
`getLastRequestStatus()`) rather than an `instanceof` check against one
concrete class, so `football-data-org`'s connectivity/rate-limit status
shows up there too. The route path itself stays `/health/api-football` for
URL stability (see `API.md`) even though it's no longer literally
api-football-specific.

## Retry, backoff, and rate-limit handling (ApiFootballProvider)

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

## Optional RapidAPI backup channel

`api-football` is reachable through two separate channels for the exact
same underlying vendor data: directly against api-sports.io (`x-apisports-key`
header — the primary channel this class has always used), or proxied
through RapidAPI (`x-rapidapi-key`/`x-rapidapi-host` headers — see
[RapidAPI's api-football listing](https://rapidapi.com/api-sports/api/api-football)).
These are two separate subscriptions with two separate quota pools, even
though the response shape is identical — which makes RapidAPI a natural
**failover**, not a second data source: `ApiFootballProvider` can be given
a `FOOTBALL_DATA_RAPIDAPI_KEY` (`backend/.env.example`) alongside the
primary `FOOTBALL_DATA_API_KEY`, and every request then tries the primary
channel first (with its own full retry policy, exactly as before), only
moving to the RapidAPI channel — with its own full retry policy in turn —
if the primary channel is still failing once its retries are exhausted.

- **Never a load-balance.** A request that succeeds on the primary channel
  never touches the backup at all. The backup is tried only after the
  primary has genuinely failed (any reason — unauthorized, rate limited,
  timeout, upstream error), since a different channel also means a
  different credential; an unauthorized primary key is exactly the kind of
  failure a working backup key can recover from.
- **`FOOTBALL_DATA_RAPIDAPI_KEY` is optional and off by default.** An empty
  value (the default) means the provider only ever has one route —
  behavior, including exact `fetch` call counts, is unchanged from before
  this option existed. This is the one part of `registry.ts` that
  intentionally does NOT fail fast at boot the way a missing primary key
  does: a backup is optional infrastructure, not a required one.
- **`getRateLimitStatus()`/`getLastRequestStatus()` now report which
  channel** (`route: "primary" | "backup"`) the most recent observation
  came from, so `GET /health/api-football` can show whether a failover has
  actually happened, not just whether one is configured.
- **Same "never exercised against live data" caveat as everything else in
  this file** — the RapidAPI channel's exact header casing/rate-limit
  header names follow published documentation, not a verified live
  response, and (like the primary channel) is only covered by unit tests
  against an injected fake `fetch`.

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
- `FixtureStatisticsProvider` — `getFixtureStatistics(fixture)`
- `PlayerStatsProvider` — `getPlayerStatistics(team, competition, season)`

`FootballDataProvider` composes all nine. Every method returns a
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
actually has a blank record. `ProviderTeamStatistics` also carries
`yellowCards`/`redCards` — a season total summed across the vendor's
per-minute-interval `cards.yellow`/`cards.red` breakdown
(`ApiFootballProvider.ts::sumCardIntervals`), not split by home/away since
the vendor's cards breakdown isn't structured that way (unlike goals).
Missing/unparseable cards data doesn't fail the whole response the way a
missing core field does — `yellowCards`/`redCards` are simply `null`, since
they're not among the required fields the mapping insists on.

`ProviderFixture` carries denormalized names (`competitionName`,
`countryName`, `homeTeamName`, etc.) alongside external ids — real
ingestion needs them to create reference rows (countries/competitions/
teams/seasons) the first time it sees an entity; see below.
`homeScoreHt`/`awayScoreHt` (mapped from the vendor's `score.halftime`
object) were added alongside the `first_half_result`/`half_with_most_goals`
markets (`ML_Model.md`) — `fixtures.home_score_ht`/`away_score_ht` existed
in the schema since 0001 but nothing had ever parsed or written them until
now, so there's now finally a real data source to eventually check those
markets' predictions against (that check hasn't been done — see
`ML_Model.md`'s caveat on this).

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
The prediction engine also now produces `double_chance`, `correct_score`,
`total_cards`, and `total_corners` (see `ML_Model.md`), but `mapOdds`
doesn't cover any of them yet — all four have model probabilities only,
with no bookmaker odds ingested to compare against (no value-analysis for
them until this mapping is extended, per `ProviderOddsSelection`'s comment
in `providers/types.ts`).

`getFixtureStatistics` returns a typed `ProviderFixtureStatistics[]` — one
entry per team, like `getLineup`/`getOdds`. This is the **only** provider
method that returns corner kicks — api-football's `/teams/statistics`
(used by `getTeamStatistics` above) never includes corners at any level of
detail, so there was no way to add corners the cheap way (parsing more
fields off an endpoint already being called), unlike cards. The vendor's
`/fixtures/statistics` response carries a flat `{type, value}` list per
team covering many stat types (shots, possession, cards, corners, fouls,
...); `ApiFootballProvider.ts::mapFixtureStatistics` only extracts
`"Corner Kicks"` today — everything else in that list is read and
discarded (same "map only what's used" policy as `mapOdds`'s restriction
to covered markets). See "Fixture-statistics ingestion" below for how
per-fixture rows become a team-season corners average.

`getPlayerStatistics` returns a typed `ProviderPlayerStatistics[]` — one
entry per player, team/season-scoped like `getTeamStatistics`. api-football's
`/players` endpoint is paginated (default 20 players/page); this only ever
requests the first page — a known, documented limitation (see its comment
in `ApiFootballProvider.ts`), not fixed here since the anytime-goalscorer
market only ever surfaces a team's top scorers anyway
(`player_market.py::MAX_CANDIDATES`), and a fringe player past the 20th
slot is exceedingly unlikely to be among them. A player who played both
league and cup football for the same team has multiple `statistics` stints
in the vendor's response; `mapPlayerStatistics` picks the one matching the
requested competition, falling back to the first stint if none matches.

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

## Fixture-statistics ingestion: `syncFixtureStatistics.ts`

`backend/src/jobs/syncFixtureStatistics.ts::syncFixtureStatistics` exists
for exactly one reason: corners aren't in `/teams/statistics`'s season
aggregate at all, so there was no way to get them the way goals/cards were
added (parsing more fields off a call already being made). This job:

1. Reads real (non-synthetic) fixtures with `status = 'finished'` whose
   `kickoff_utc` falls within the last `windowHours` (default 72) — a
   look-back-only window, unlike lineups/odds's look-both-ways one, since a
   fixture's corners only exist to fetch once it's actually over.
2. For each fixture with a known external id, calls
   `provider.getFixtureStatistics(fixture)`, then matches each returned
   entry's `teamExternalId` against the fixture's own two participants
   (resolved via `loadExternalRefs`, like `syncTeamStatistics.ts` does) — an
   entry for a team that isn't one of the two participants is rejected and
   counted, not silently accepted.
3. Upserts one `fixture_statistics` row per (fixture, team) — genuinely
   idempotent (a real plain-column `unique (fixture_id, team_id)`
   constraint, same category as `lineups`/`team_statistics`), unlike
   `odds_snapshots`'s deliberate append-only design above.
4. After processing, re-aggregates every (team, season) pair touched by
   this run: averages that team's non-null `fixture_statistics.corners`
   values for the season and upserts the result into
   `team_statistics.corners` (`refreshTeamCornersAverage`, exported for
   direct testing). This upsert only supplies
   `team_id`/`season_id`/`scope`/`corners`/`source`/`source_timestamp` —
   Postgres's `ON CONFLICT DO UPDATE` only sets the columns present in the
   payload, so it can't clobber the goals/cards fields
   `syncTeamStatistics.ts` wrote to the same row (verified against both the
   real schema's documented upsert semantics and this repo's `FakeSupabase`
   test double, which mirrors that column-scoped merge — see its `update()`
   and `upsert()` comments).
5. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Trigger it via `POST /api/admin/fixture-statistics/sync?hours=N` (default
72, capped at 168 — see `admin.ts`). **Known limitation:** if a match's
stats aren't finalized by the vendor within the window, they're missed
until backfilled some other way — there's no unbounded "catch every
finished fixture eventually" pass, matching the same quota-conscious
windowing tradeoff lineups/odds already make.

## Player-statistics ingestion: `syncPlayerStatistics.ts`

`backend/src/jobs/syncPlayerStatistics.ts::syncPlayerStatistics` mirrors
`syncTeamStatistics.ts` almost exactly, one level down: team/season-scoped,
same combination-dedup shape, same idempotent-upsert design — just for
players instead of the team as a whole. This job:

1. Uses the same `loadCombinations` shape as `syncTeamStatistics.ts` — one
   (team, competition, season) combination per non-synthetic fixture,
   deduplicated.
2. For each combination with a known external id for all three, calls
   `provider.getPlayerStatistics(team, competition, season)`.
3. For each returned player, calls `upsertPlayer` (the same helper
   `syncLineups.ts` uses) to resolve/create the internal player row, then
   upserts one `player_statistics` row per (player, team, season) — a real
   plain-column `unique (player_id, team_id, season_id)` constraint (0006).
4. Writes one `ingestion_runs` row per invocation, same as the other jobs.

Trigger it via `POST /api/admin/player-statistics/sync` (no window
parameter — it's team/season-scoped like team-statistics, not windowed
around kickoff like lineups/odds/fixture-statistics).

**Known limitations:** the single-page-only `/players` pagination gap
above; and `upsertPlayer` doesn't update an existing player's `team_id` on
a repeat call, so a transferred player's `players.team_id` can go stale
(see `Database.md`'s "Known gaps" — `player_statistics` itself isn't
affected, since it's keyed by `player_id, team_id, season_id`, so a
transfer correctly gets its own row for the new team).

## Scheduler: `backend/src/scheduler/scheduler.ts`

Every sync/prediction job above exists as a plain async function callable
from an admin route (manual) or from a cron tick (automatic) — the jobs
themselves don't know or care which. `startScheduler()` wires the latter,
using [`node-cron`](https://www.npmjs.com/package/node-cron), when
`SCHEDULER_ENABLED=true` (`backend/.env.example`, off by default):

- Fixtures, team-statistics, player-statistics, injuries, standings, and
  fixture-statistics run once daily, staggered 5–30 minutes apart in that
  order (`02:00`, `02:30`, `02:35`, `02:45`, `03:00`, `03:10` UTC) so each
  starts after the one it depends on has had time to finish —
  team-statistics/player-statistics/injuries/standings all read fixtures
  that `syncFixtures` just wrote (player-statistics grouped right after
  team-statistics — same team/season-scoped shape), and fixture-statistics
  runs last (before predictions) since nothing about corners needs to be
  "closer to kickoff" the way lineups/odds do — a finished match's corners
  don't change once posted. Predictions run once daily after that, at
  `03:15` UTC, reading the `team_statistics` those jobs just wrote
  (goals/cards directly, corners via fixture-statistics's aggregation) and
  `player_statistics` for the anytime-goalscorer markets.
- Lineups and odds run every 15 minutes (offset from each other, `:00/:15/
  :30/:45` and `:05/:20/:35/:50`), since both are only meaningful/accurate
  close to kickoff (spec section 6: "refresh closer to kickoff") — running
  them once a day like the others would defeat the point.
- If no data provider is configured (`FOOTBALL_DATA_PROVIDER=null`), the
  eight sync jobs are **not scheduled at all** — one clear warning is logged
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

**Cross-process lock (0016_job_locks.sql).** `node-cron` itself still has
no coordination between processes, but every scheduled job now goes
through `withJobLock()` before it runs, which calls the
`try_acquire_job_lock` Postgres function to atomically claim that job's row
in `job_locks` (an `INSERT ... ON CONFLICT DO UPDATE ... WHERE
expires_at < now()`, so two replicas racing to claim the same job's lock
at the same instant can't both win it — see that migration's own comment).
A replica that doesn't get the lock skips that run and logs why, rather
than syncing (or, for `syncOdds.ts`, appending odds snapshots)
redundantly. The lock has a generous TTL (30 minutes,
`DEFAULT_JOB_LOCK_TTL_SECONDS`) rather than an explicit release, so a
crashed replica's lock still frees itself up on its own. This hasn't been
exercised against actually-concurrent replicas (this Blueprint still
deploys a single `plan: free` instance — `Deployment.md`), only unit-tested
against `FakeSupabase`'s single-threaded model of the same INSERT/ON
CONFLICT semantics (`jobLock.test.ts`) — real Postgres's row-level
consistency is what actually makes two simultaneous callers resolve to
exactly one winner, and that guarantee itself is trusted, not re-tested,
here.

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
  predictions show up in job history the same way the eight sync jobs do.
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
   `ApiFootballProvider.ts`'s pattern (broad coverage, every capability
   real) or `FootballDataOrgProvider.ts`'s (narrower free tier — some
   methods honestly return `{ ok: false, reason: "not_configured", ... }`
   rather than pretending to support what the vendor's plan doesn't
   offer): injectable `fetch` and timeout for testability, explicit mapping
   to `ProviderFixture` (etc.), and `{ ok: false, reason: "upstream_error",
   ... }` on any failure rather than throwing or returning partial/guessed
   data. Decide up front whether the new provider is meant to be a
   **swappable alternative** (the pattern both existing providers follow —
   see "Two providers, never blended" above) or something that shares
   entity identity with an existing one; the latter needs real
   cross-provider entity resolution, not just a new provider class.
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
