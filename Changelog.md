# Changelog

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
