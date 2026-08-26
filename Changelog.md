# Changelog

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
