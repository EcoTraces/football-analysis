# Changelog

## 2026-08-26 — Retry/rate-limit hardening + job observability infrastructure

Closes the two remaining cross-cutting gaps as far as they can be closed
without a live API key or real wall-clock days: hardens the API client and
builds the monitoring infrastructure needed to actually observe the
scheduler once both are available. **Neither gap is closed outright** — see
Task.md/Road_map.md for exactly what's still blocked and on what.

- `ApiFootballProvider`'s `request()` now retries transient failures
  (timeout, network error, HTTP 5xx, HTTP 429 — honoring `Retry-After`)
  with exponential backoff plus jitter, and does NOT retry permanent ones
  (401/403, other 4xx, a non-JSON body, a body-level vendor error like an
  invalid league id). Tracks the last-seen rate-limit response headers
  (`getRateLimitStatus()`) and the outcome of the most recently completed
  request (`getLastRequestStatus()`), warning when quota drops below 5%.
  Threaded a `Logger` into the provider (optional, backward-compatible
  with all 26 existing positional-arg test constructions).
- `runLatestPoissonPredictionsJob` now writes an `ingestion_runs` row like
  the six sync jobs always have — predictions previously had no persistent
  execution history at all.
- Added `GET /admin/jobs` and `GET /admin/jobs/summary` (admin-only):
  read real job history back from `ingestion_runs` — recent runs, and a
  last-run/last-succeeded-run summary per job. Added `GET
  /health/scheduler` (whether the in-process scheduler is running, each
  job's cron expression and next run time — `scheduler.ts` gained a
  `status()` method) and `GET /health/api-football` (provider connectivity
  derived from real request history, not a live probe on every poll).
  Extended `GET /health/data` with per-dataset freshness
  (fixtures/standings/team-statistics/injuries/lineups/odds/predictions),
  LIVE/RECENT/STALE/UNAVAILABLE plus a GREEN/YELLOW/RED/GRAY color, using
  the existing `freshness.ts` classifier — added a `teamStatistics` domain
  to it, the one dataset it didn't already cover.
- 32 new tests (8 for retry/rate-limit behavior in
  `apiFootballProvider.test.ts`, 1 more scheduler `status()` test, 10 in a
  new `health.test.ts`, 5 in a new `adminJobsSummary.test.ts`, plus the
  wiring changes) — 127 backend tests passing in total, clean lint/
  typecheck/build. Manually smoke-tested `GET /health/scheduler`, `GET
  /health/api-football`, and `GET /health/data` against a running server
  (dummy Supabase credentials, no live project available in this
  environment): confirmed correct behavior with `SCHEDULER_ENABLED=true`
  and no provider configured (scheduler running with only `predictions`
  scheduled, provider reporting `NOT_CONFIGURED`, every freshness domain
  reporting `UNAVAILABLE`/`GRAY` against an unreachable dummy database)
  rather than crashing or fabricating a healthy-looking response.
- **Not done, and cannot be done from here**: no real API-Football key
  exists anywhere in this environment — obtaining one requires a human to
  sign up for a real account (api-football.com or RapidAPI). Nothing above
  has been exercised against live data; only against injected fakes. See
  README.md → "Configuring a live API-Football key" for the exact steps
  and commands to run the moment a key is configured.
- **Not done, and cannot be done from here**: the scheduler has not run
  for real over any meaningful period — that requires `SCHEDULER_ENABLED=true`
  plus a real API key running continuously for at least 72 hours (7 days
  preferred) in a persistent environment, which has not started. The
  infrastructure to observe it (this changelog entry) is now in place;
  the observation period itself is not. Do not treat this as done until
  it actually has run that long — see Task.md's "OBSERVATION PENDING" item.

## 2026-08-26 — Scheduler for sync/prediction jobs

- Added `backend/src/scheduler/scheduler.ts`: an in-process cron scheduler
  (`node-cron`) wiring `syncFixtures`/`syncTeamStatistics`/`syncInjuries`/
  `syncStandings`/`syncLineups`/`syncOdds`/predictions to real recurring
  schedules instead of relying solely on manual `POST /admin/*` calls.
  Off by default — set `SCHEDULER_ENABLED=true` (new env var, defaults
  `false`) to start it.
- Fixtures/team-statistics/injuries/standings run once daily, staggered
  15–30 minutes apart in dependency order; predictions run once daily
  after those; lineups and odds run every 15 minutes, since both only
  become meaningful/accurate close to kickoff (spec section 6). If no data
  provider is configured, the six sync jobs are skipped entirely at
  startup (one clear warning, not a no-op every tick) — predictions still
  runs, since it reads from the database rather than the provider, matching
  the existing admin route's behavior.
- Each scheduled run is wrapped so a thrown/rejected error is logged
  instead of crashing the process or blocking a later tick; every task
  uses node-cron's `noOverlap` option so a slow 15-minute job can't overlap
  with its own next tick.
- Refactored `/admin/predictions/run`'s "look up the latest poisson-baseline
  model_version, then run predictions against it" logic out of `admin.ts`
  and into a new shared `runLatestPoissonPredictionsJob` in
  `generatePredictions.ts`, so the admin route and the scheduler share one
  implementation instead of the scheduler duplicating it.
- Added `.order()`/`.limit()` support to the test double
  (`testSupabaseFake.ts`) — needed to test the model-version lookup, the
  first job requiring "most recent row" semantics rather than an exact/set/
  range filter.
- Added graceful shutdown to `index.ts`: `SIGTERM`/`SIGINT` now stop the
  scheduler and close the HTTP server cleanly, verified manually against a
  running server (confirmed the shutdown log line and clean process exit).
- 10 new tests (`scheduler.test.ts`) covering: every exported cron
  expression is syntactically valid; all six sync jobs plus predictions are
  scheduled when a provider is configured; only predictions is scheduled
  (with a warning) when none is; `stop()` is idempotent; the fixtures job's
  3-day UTC window and the lineups/odds jobs' 24-hour kickoff window are
  wired with the right default parameters; the predictions job's two
  branches (no model_version yet vs. a real run); and the error-guarding
  wrapper catches and logs rather than propagating — 104 backend tests
  passing in total, clean lint/typecheck/build.
- Manually smoke-tested against a running server (dummy Supabase
  credentials, since no live project is available in this environment):
  confirmed the startup log correctly skips the six sync jobs and warns
  when `FOOTBALL_DATA_PROVIDER=null`, schedules only `predictions`, and
  that `SIGTERM` triggers a clean shutdown. Not the same as observing it
  drive a real ingestion pipeline over multiple days — flagged explicitly
  in `Task.md`/`Road_map.md` as still needed, along with the scheduler's
  single-backend-instance assumption (no cross-process locking) before
  scaling to more than one replica.

## 2026-08-26 — Odds/markets sync job

- Added `syncOdds.ts`: populates `odds_snapshots` from the provider's own
  odds endpoint for real (non-synthetic) fixtures with status
  `scheduled`/`live` whose kickoff falls within `±windowHours` of now
  (default 24) — windowed around kickoff like lineups, since odds aren't
  meaningful for a match already decided or far in the future.
- Gave `OddsProvider.getOdds` a real typed return (`ProviderOdds[]`) and,
  for the first time, added `OddsProvider` to the `FootballDataProvider`
  interface itself — every provider (and every test double implementing
  it) now has to implement `getOdds`. `ApiFootballProvider.mapOdds`
  restricts mapping to the three markets the prediction engine actually
  produces (`1x2`/`btts`/`over_under_2_5`), classifying each vendor "bet"
  by name (`mapBet`) and dropping bookmakers left with no covered-market
  selections after filtering.
- **Deliberately not idempotent-by-upsert**, unlike every other sync job so
  far: `odds_snapshots` is a genuine price-history time series (spec
  section 25 wants price movement, not a current price), so every
  successful run does a plain `.insert()` per bookmaker/selection rather
  than upserting — running the job twice with unchanged prices produces
  two full sets of rows, by design. No de-duplication against the prior
  snapshot is implemented yet (tracked as a known gap, not solved here, to
  keep this first version simple and unambiguously correct).
- Added `POST /api/admin/odds/sync?hours=N` (default 24, capped at 168) —
  shares the same `MAX_KICKOFF_WINDOW_HOURS` constant as lineups now
  (renamed from `MAX_LINEUP_WINDOW_HOURS`).
- 13 new tests (4 in `apiFootballProvider.test.ts` for the odds mapping —
  covering multi-market bookmakers, an uncovered market/line being dropped,
  a bookmaker left with zero covered selections being dropped entirely, and
  invalid odds values being rejected while valid ones in the same bet
  survive; 9 in `syncOdds.test.ts` covering per-selection insert counts,
  external-id call correctness, empty-response handling, the
  not-idempotent-by-design behavior explicitly asserted as row growth
  across two runs, price-change history preservation, time-window
  filtering that excludes a `finished` fixture, missing-external-ref
  skipping, per-fixture failure isolation, and synthetic-fixture
  exclusion) — 94 backend tests passing in total, clean lint/typecheck/
  build. Widening `FootballDataProvider` to include `OddsProvider` required
  updating five existing test files' `FakeProvider` doubles to add a
  `getOdds` stub — expected fallout from strengthening a shared interface,
  not a sign of a design problem.
- Not yet verified against a live API key, same caveat as every other
  sync job in this repository — `mapBet`'s classification of the vendor's
  bet-name strings is a best-effort guess, not a documented enum.

## 2026-08-26 — Lineups sync job

- Added `syncLineups.ts`: populates `lineups` (and `players` along the way)
  from the provider's own lineups endpoint. Unlike every other sync job so
  far, this one is windowed around kickoff (`kickoff_utc` within
  ±`windowHours`, default 24) rather than scanning every fixture ever
  recorded — lineups are only meaningful close to a match. One provider
  call per fixture returns both teams. An empty response is treated as a
  normal "not yet officially released" state, tracked separately from
  failures, not as an error.
- Gave `LineupProvider.getLineup` a real typed return (`ProviderLineup[]`)
  instead of `unknown` — `ApiFootballProvider` maps both teams per call and
  skips individual malformed player entries without dropping the whole
  team. Always writes `confirmation_status: 'confirmed'`, reasoned from the
  vendor's documentation (this endpoint only updates once lineups are
  officially released, not a "predicted lineup" feature) — flagged
  explicitly as unverified against a live response, and as a gap if a
  provider ever mixes confirmed and predicted lineups in one response.
- Upserts a `lineups` row via a real `upsert(..., { onConflict:
  "fixture_id,team_id" })`, another genuine plain-column constraint from
  the initial schema.
- Added `POST /api/admin/lineups/sync?hours=N` (default 24, capped at 168).
- 13 new tests (4 in `apiFootballProvider.test.ts` for the lineups mapping
  — including the empty-response and malformed-entry cases, 9 in
  `syncLineups.test.ts` covering the kickoff-time window, status
  filtering, idempotency, missing-external-ref skipping, per-fixture
  failure isolation, and synthetic-fixture exclusion) — 81 backend tests
  passing in total, clean lint/typecheck/build. Manually verified the new
  route requires auth on a running server.
- Caught the same test-fixture bug a third time (after injuries and before
  writing standings' tests correctly the first time): the fake provider's
  default response initially gave both teams' lineups the same player
  external ids, which isn't realistic and would have made "N distinct
  players" assertions pass or fail for the wrong reason. Fixed before
  running the suite for real.
- Added `.gte()`/`.lte()` support to the test double
  (`testSupabaseFake.ts`) to support the kickoff-time window query — the
  first sync job needing a range filter rather than exact/set matches.

## 2026-08-26 — Standings sync job

- Added `syncStandings.ts`: populates `standings` from the provider's own
  league-table endpoint for every distinct (competition, season) pair
  implied by real fixtures — one call returns the whole table, so unlike
  team-statistics/injuries there's no per-team fan-out. Upserts a `teams`
  row per entry (find-or-create by external id) and then a `standings` row
  via a real `upsert(..., { onConflict: "season_id,team_id" })`, another
  genuine plain-column constraint from the initial schema.
- Gave `StandingsProvider.getStandings` a real typed return
  (`ProviderStanding[]`) instead of `unknown[]` — `ApiFootballProvider`
  flattens the vendor's grouped table structure (`league.standings`, an
  array of arrays for competitions with split tables) into one list, and
  skips rows missing required fields rather than guessing.
- This is the first job to give the pre-existing `GET /standings/:leagueId`
  read route real data — that route has existed since the initial scaffold
  with nothing real to read until now.
- Refactored: this is the third sync job needing the same "batch-lookup
  external ids by internal id" logic, so pulled `externalId`/
  `loadExternalRefs` out of `syncTeamStatistics.ts`'s and `syncInjuries.ts`'s
  local copies into `referenceDataService.ts` as shared exports, and
  updated both existing jobs to use them — rather than writing a third
  near-identical copy for this one.
- 12 new tests (4 in `apiFootballProvider.test.ts` for the standings
  mapping — including flattening multiple groups and skipping incomplete
  rows, 8 in `syncStandings.test.ts` covering deduplication, idempotency,
  a position/points change actually landing on a later sync, missing-
  external-ref skipping, per-item failure isolation, and synthetic-fixture
  exclusion) — 68 backend tests passing in total, clean lint/typecheck/
  build. Manually verified the new route requires auth on a running server,
  and that the referenceDataService refactor didn't change behavior (full
  suite re-run green before and after).

## 2026-08-26 — Injuries sync job

- Added `syncInjuries.ts`: populates `players` and `injuries` from the
  provider's own injuries endpoint for every distinct (team, season) pair
  implied by real fixtures, deduplicated on the external id pair actually
  sent to the provider (the endpoint isn't competition-scoped, unlike team
  statistics). Since the vendor reports one entry per (player, fixture) a
  player was missing for rather than a single current-status flag, the job
  keeps only the most recently dated report per player.
- Gave `InjuryProvider.getInjuries` a real typed return (`ProviderInjury[]`)
  instead of `unknown[]` — `ApiFootballProvider` maps the vendor's raw
  response and skips entries missing a player id/name/fixture date rather
  than guessing. Status (`injured`/`suspended`/`international_duty`/
  `doubtful`) is classified with a keyword heuristic over the vendor's
  free-text `type`/`reason` fields — flagged explicitly as unverified,
  since there's no documented enum behind it.
- Added migration `0003_injuries_and_players_refs.sql`: external-id
  uniqueness for `players` (mirroring teams/competitions), and a new
  uniqueness constraint on `injuries.player_id` the initial schema didn't
  anticipate needing — this models "current status per player," not a
  history of every report, and `syncInjuries.ts` upserts against it
  directly (a real plain-column constraint, like `team_statistics`'s).
- Explicitly does *not* mark a recovered player `returned` — a player who
  stops appearing in fresh reports just goes stale (surfaced by the
  existing freshness classifier) rather than this job guessing at recovery.
  Documented as a known gap, not silently glossed over.
- Added `POST /api/admin/injuries/sync` (inherits the existing admin auth
  automatically). Factored the repeated "no provider configured" check
  out of the three sync routes into one `requireProvider()` helper while
  adding this, rather than copy-pasting it a third time.
- 12 new tests (3 in `apiFootballProvider.test.ts` for the injuries
  mapping, 9 in `syncInjuries.test.ts` covering deduplication, most-recent-
  report selection, idempotency, missing-external-ref skipping, per-item
  failure isolation, empty-result handling, and synthetic-fixture
  exclusion) — 56 backend tests passing in total, clean lint/typecheck/
  build. Caught and fixed a bug in my own test fixture during this pass:
  the fake provider's default response returned the same player for every
  team, which isn't realistic and would have made the "one player per
  team" assertions pass or fail for the wrong reason.

## 2026-08-26 — Team-statistics sync job

- Added `syncTeamStatistics.ts`: populates `team_statistics` from the
  provider's own aggregated `/teams/statistics` endpoint (not computed from
  our own results) for every distinct (team, competition, season) implied
  by real fixtures, deduplicated so a team isn't queried once per fixture.
  Writes `overall`/`home`/`away` scope rows.
- Gave `TeamStatsProvider.getTeamStatistics` a real typed return
  (`ProviderTeamStatistics`) instead of `unknown` — `ApiFootballProvider`
  now maps the vendor's raw response and returns `upstream_error` if
  required fields are missing, rather than writing zeros that would look
  identical to a team with an actual blank record.
- This is the one ingestion job so far using a real `upsert(...,
  { onConflict })` instead of find-then-insert — `team_statistics`'s
  `(team_id, season_id, scope)` uniqueness is a genuine plain-column
  constraint (unlike the expression-index uniqueness on fixtures/teams/
  competitions/seasons), so PostgREST's on_conflict is documented to work
  against it directly.
- Added `POST /api/admin/team-statistics/sync` (inherits the same admin
  auth as every other route on that router automatically, since it's
  applied once via `router.use(...)` — didn't need separate wiring).
- 9 new tests (2 in `apiFootballProvider.test.ts` for the new mapping, 7 in
  `syncTeamStatistics.test.ts` covering deduplication, idempotency,
  missing-external-ref skipping, per-item failure isolation, and synthetic-
  fixture exclusion) — 44 backend tests passing in total, clean lint/
  typecheck/build. Verified live against a running server that the new
  route inherits the existing admin-auth rejection (401 with no token).
- Predictions can now run on real (non-synthetic) fixtures once both
  `/admin/sync` and `/admin/team-statistics/sync` have been run for them —
  not yet exercised end-to-end against a live provider/database, same
  caveat as the rest of the ingestion pipeline.

## 2026-08-26 — Admin route authentication

- Added `requireAdmin` middleware (`backend/src/middleware/requireAdmin.ts`):
  verifies a Supabase-issued JWT via `auth.getUser()` and requires
  `user_profiles.role = 'admin'` for the underlying user. Applied once to
  the whole admin router (`router.use(...)`) rather than per-route, so a
  future admin endpoint can't accidentally ship unauthenticated.
- Auth failures are explicit: `401 unauthenticated` for a missing/malformed
  header or a token the auth server doesn't recognize, `403 forbidden` for
  a valid but non-admin user — never a silent pass-through or a generic 500.
- 6 new unit tests against a fake Supabase client (auth + `user_profiles`
  lookup), plus manual verification against a running server: confirmed a
  request with no `Authorization` header, a non-Bearer scheme, and an
  unrecognized token all get rejected with `401` and the server stays up
  through all of them (35 backend tests passing in total).
- Documented the one remaining manual step this doesn't automate: there's
  no signup/role-assignment UI, so README.md now has "Creating the first
  admin user" (create a Supabase Auth user, set their `user_profiles.role`
  to `admin` via SQL, sign in to get a JWT).
- Flagged clearly in `Task.md`/`Road_map.md`: this has only been tested
  against a fake Supabase client, not a real project's actual JWTs/token
  lifecycle — that verification is still outstanding.

## 2026-08-26 — Real fixture data provider (API-Football)

- Implemented `ApiFootballProvider` against api-football v3, satisfying the
  existing `FootballDataProvider` abstraction. Not yet exercised against a
  live API key (none available in this environment) — mapping follows the
  vendor's documented contract and is covered by unit tests using injected
  fake HTTP responses. See `Data_Sources.md` for the verification steps
  still needed.
- Extended `TeamStatsProvider`/`InjuryProvider` signatures to take
  competition/season context, discovered to be necessary once implementing
  a real provider (a team's stats are scoped per competition, not just
  per season).
- Added migration `0002_provider_external_refs.sql`: external_ref columns
  and uniqueness indexes on countries/seasons/fixtures (plus filling in
  ones missing on teams/competitions from 0001), so ingestion can upsert
  against a stable provider id instead of a natural key that breaks under
  postponements. Correctly scoped the seasons index per-competition after
  catching that a season's provider id ("2026") repeats across every
  competition.
- Built `referenceDataService.ts` (find-or-create by external id for
  countries/competitions/seasons/teams) and `syncFixtures.ts`, the first
  real ingestion job: idempotent, per-fixture failure isolation, and an
  `ingestion_runs` row per invocation for observability.
- Wired the registry to construct `ApiFootballProvider` when configured,
  failing fast at boot if the API key is missing rather than silently
  falling back to `NullProvider`.
- Added `POST /api/admin/sync?days=N` to trigger a sync manually (capped at
  14 days as a stopgap against an expensive accidental call — this route
  still has no authentication, tracked in `Task.md`).
- 21 new backend tests (provider error-taxonomy mapping, reference-data
  idempotency including the per-competition season scoping, sync job
  idempotency/resilience) — 29 backend tests passing in total, all lint/
  typecheck/build clean.
- Left team nationality and competition type unpopulated by design rather
  than inferring them incorrectly from data the fixtures payload doesn't
  actually provide — documented as explicit follow-ups in `Task.md`.

## 2026-08-26 — Initial scaffold

- Created the repository and the full domain schema in Supabase/Postgres
  (`supabase/migrations/0001_init.sql`), plus a clearly-flagged, isolated
  synthetic dev seed (`supabase/seed/dev_seed_synthetic.sql`).
- Built the backend API (Node/Express/TypeScript): health endpoints, a
  `FootballDataProvider` abstraction with a `NullProvider` default,
  fixtures/matches/teams/competitions/standings read routes, a prediction
  generation job, and admin endpoints to trigger it and check data health.
- Built the ML service (Python/FastAPI): a Dixon-Coles-adjusted Poisson
  goals model producing 1X2/BTTS/Over-Under-2.5 probabilities with
  sample-size-driven data quality and plain-language explanation factors.
- Built the frontend (React/Vite/TypeScript/Tailwind): today's fixtures
  list, match detail with prediction cards, dark/light mode, accessible
  freshness badges, responsible-gambling footer.
- Added unit tests across all three services (freshness classification,
  provider fallback, Poisson market math, prediction confidence, and
  frontend components) and a GitHub Actions CI workflow running lint,
  typecheck, tests, and build for each.
- Wrote the full documentation set (`PRD.md`, `Architecture.md`,
  `Database.md`, `Coding_Rules.md`, `Road_map.md`, `Task.md`, `API.md`,
  `ML_Model.md`, `Data_Sources.md`, `Deployment.md`).
