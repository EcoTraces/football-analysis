# Outstanding Tasks

## Security

- [x] `/api/admin/*` authentication — `requireAdmin` middleware
  (`backend/src/middleware/requireAdmin.ts`) verifies a Supabase JWT via
  `auth.getUser()` and requires `user_profiles.role = 'admin'`, applied to
  the whole admin router. Verified manually against a running server
  (missing header → 401, malformed header → 401, unrecognized token → 401)
  and unit-tested against a fake Supabase client (6 tests) — **not yet
  exercised against a real Supabase project's actual JWTs**, only against
  the fake's `auth.getUser`/`user_profiles` behavior. Test against a live
  project before relying on it in production.
- [x] Signup + role-assignment UI — the frontend now has real `/sign-in`/
  `/sign-up` pages (Supabase Auth, email+password) and an admin-only
  `/admin/users` panel (`GET /admin/users`, `POST /admin/users/:id/role`)
  to promote/demote accounts without direct SQL. Only the very first admin
  still needs the one-time manual SQL bootstrap (README.md → "User access
  control") — unavoidable, since there's no admin yet to promote you.
  `POST /admin/users/:id/role` refuses to demote the only remaining admin
  (`409 last_admin`).
- [x] Closed a role self-escalation gap found while building the above:
  0001's RLS policies let a signed-in user PATCH their own `role` to
  `'admin'` directly (row-level, not column-level, restriction). Fixed in
  `supabase/migrations/0004_user_profiles_role_guard.sql` — a `before
  update` trigger blocks any `role` change unless running as the service
  role, and the INSERT policy now pins new rows to `role = 'user'`. See
  `Database.md`'s "Access control" section. **Not yet run against a live
  Supabase project** — same caveat as everything else in this file.
- [x] Gated the whole app behind authentication — previously only
  `/api/admin/*` required a signed-in user; fixtures/matches/teams/leagues/
  standings were publicly readable. `requireAuth` (any signed-in user, no
  role check) is now applied to `createFixturesRouter`/`createMatchesRouter`/
  `createTeamsRouter`/`createCompetitionsRouter` — only `/api/health*`
  remains public. The frontend's `/` and `/matches/:id` routes are wrapped
  in `<RequireAuth>`, redirecting an unauthenticated visitor straight to
  `/sign-in`; this is enforced independently on the backend too, so a
  direct API call can't bypass the UI-level gate. 5 new tests
  (`requireAuth.test.ts`, mirroring `requireAdmin.test.ts`'s structure).
  Manually verified live: `GET /api/health` stays `200` with no token,
  `GET /api/fixtures/today`/`GET /api/leagues` now `401` without one; in a
  real browser, `/` and `/matches/:id` redirect to `/sign-in` when signed
  out. **Not yet verified against a real Supabase project's JWTs** — same
  caveat as the rest of this file.
- [ ] Add request logging/audit trail for admin actions (who ran
  `/admin/sync`, when, with what result; who promoted/demoted whom via the
  new `/admin/users/:id/role`) — `requireAdmin`/`requireAuth` know the
  authenticated user id at that point (`req.authUser`) but nothing persists
  it yet.
- [ ] Consider token revocation/expiry edge cases explicitly: `auth.getUser()`
  should reject an expired or revoked token, but this hasn't been verified
  against Supabase's actual token lifecycle (only against the test fake,
  which has no concept of expiry).
- [ ] `GET /admin/users` fetches only the first 200 accounts (no
  pagination) — fine until this platform has a real user base, not a
  long-term design.
- [ ] No email-confirmation-required UX has been tested against a real
  Supabase project — `SignUp.tsx` handles both cases (immediate session vs.
  "check your email") based on whether `signUp()` returns a session, but
  which one actually happens depends on the project's Auth settings, which
  this environment has no live project to check against.

## Data

- [x] Implement a real `FixtureProvider` — `ApiFootballProvider`
  (`backend/src/providers/ApiFootballProvider.ts`), registered in
  `providers/registry.ts`. **Not yet verified against a live API key** —
  see `Data_Sources.md`'s caveat. Get a real key and run `POST
  /api/admin/sync?days=1` against a real Supabase project before trusting it.
- [x] Add retry-with-backoff and rate-limit tracking to `ApiFootballProvider`
  — transient failures (timeout, network error, HTTP 5xx, HTTP 429) retry
  with exponential backoff (honoring a 429's `Retry-After` header),
  permanent failures (401/403, a malformed request, a body-level vendor
  error) don't retry. Tracks the last-seen rate-limit response headers and
  the outcome of the most recent completed request via
  `getRateLimitStatus()`/`getLastRequestStatus()`, surfaced by `GET
  /health/api-football`. 8 new tests. Still unverified against live
  rate-limit headers — the header names followed are documented, not
  confirmed against a real response (same caveat as the rest of this file).
- [ ] **BLOCKED ON THE USER**: nothing above can be exercised against a real
  API-Football account from this environment — there is no real
  `FOOTBALL_DATA_API_KEY` configured anywhere in it, and obtaining one
  requires signing up for a third-party service (api-football.com or
  RapidAPI) with a real account, which only the project owner can do. See
  README.md → "Configuring a live API-Football key" for the exact steps
  and the commands to run once a key exists.
- [x] Build the fixture ingestion job — `syncFixtures.ts`, idempotent via
  the fixture's own external id (not the natural key — a postponed fixture
  keeps its id but changes kickoff time).
- [ ] Verify `ApiFootballProvider`'s response mapping against a live key —
  field names/shapes are implemented from documentation, not a confirmed
  live response.
- [ ] Populate team nationality (`teams.country_id`) — intentionally left
  null by `syncFixtures.ts` (see `Data_Sources.md`); needs a dedicated
  `/teams` sync.
- [ ] Sync a real `/countries` list so competitions/teams get an
  authoritative country id and flag instead of match-by-name.
- [x] Build a team-statistics sync job — `syncTeamStatistics.ts`, calling
  the vendor's own aggregated `/teams/statistics` endpoint (not computed
  from our own results) for every distinct (team, competition, season)
  implied by real fixtures, writing `overall`/`home`/`away` scope rows.
  **Not yet verified against a live API key** — same caveat as fixtures.
- [ ] No results-sync job exists — `syncFixtures.ts` only pulls a rolling
  window of fixtures (today + N days), so historical results aren't
  backfilled into our own `fixtures` table. `syncTeamStatistics.ts` doesn't
  need that (it uses the vendor's pre-aggregated stats endpoint instead),
  but nothing else in this repo benefits from historical results yet —
  worth doing once head-to-head analysis (spec section 11) is built.
- [ ] `syncTeamStatistics.ts` only populates `overall`/`home`/`away`
  scopes — `last_5`/`last_10` (spec section 9's rolling windows) need
  actual match-by-match results, which the vendor's aggregated endpoint
  doesn't provide; that's the results-sync job above, not this one.
- [x] Build the injuries sync job — `syncInjuries.ts`, keyed on (team,
  season) pairs implied by real fixtures (deduplicated on the external id
  pair, since the endpoint isn't competition-scoped), keeping only the most
  recently dated report per player and upserting a `players` row plus one
  `injuries` row per player. **Not yet verified against a live API key** —
  same caveat as fixtures/team-statistics.
- [ ] `syncInjuries.ts`'s status classification (`injured` / `suspended` /
  `international_duty` / `doubtful`) is a keyword heuristic over the
  vendor's free-text `type`/`reason` fields
  (`ApiFootballProvider.ts::mapInjuryStatus`) — validate it against real
  responses; the enum values it guesses at may not match the vendor's
  actual terminology.
- [ ] `syncInjuries.ts` never marks a player `returned` — a recovered
  player just stops appearing in fresh reports, leaving their last known
  row to go stale rather than being updated to reflect recovery (the
  freshness classifier surfaces the staleness, but nothing flips the
  status). Revisit once there's a signal to detect recovery from (e.g. the
  player appearing in a subsequent confirmed lineup).
- [x] Build the standings sync job — `syncStandings.ts`, keyed on
  (competition, season) pairs implied by real fixtures (one provider call
  returns the whole table), upserting a `standings` row per team via a real
  `upsert(..., { onConflict: "season_id,team_id" })`. Feeds the existing
  `GET /standings/:leagueId` read route with real data for the first time.
  **Not yet verified against a live API key** — same caveat as the other
  sync jobs.
- [ ] `syncStandings.ts` flattens every group in the vendor's response
  (`RawStandingsEnvelope.league.standings`, an array of arrays for
  competitions with split tables like group stages or
  championship/relegation rounds) into one list — a team appearing in two
  groups in the same season just has the later one win via upsert order,
  since this schema has no column for which group a row came from. Revisit
  if that turns out to matter for a real competition's data.
- [x] Build the lineups sync job — `syncLineups.ts`, windowed around
  kickoff (`kickoff_utc` within ±`windowHours`, default 24) rather than
  scanning every fixture, since lineups only exist close to kickoff. One
  provider call per fixture returns both teams; upserts a `teams` row, a
  `players` row per named starter/substitute, and one `lineups` row per
  team via a real `upsert(..., { onConflict: "fixture_id,team_id" })`.
  **Not yet verified against a live API key** — same caveat as the other
  sync jobs.
- [ ] `syncLineups.ts` always writes `confirmation_status: 'confirmed'` —
  reasoned from api-football's documentation stating this endpoint only
  updates once lineups are officially released (not a "predicted lineup"
  feature), but that reasoning itself is unverified against a live
  response. If a future provider (or this one, if the docs turn out wrong)
  mixes confirmed and predicted lineups in one response, `ProviderLineup`
  needs a field for that — don't just keep assuming "confirmed."
- [x] Build the odds sync job — `syncOdds.ts`, windowed around kickoff like
  lineups (scheduled/live fixtures only — no "closing odds" use case exists
  yet for finished ones). Restricted to the three markets the prediction
  engine actually produces (`1x2`/`btts`/`over_under_2_5` —
  `ProviderOddsSelection`) so a future value-analysis feature can compare
  model probability against market price for the same market; other
  markets/lines a bookmaker offers are read but not stored. **Deliberately
  not idempotent-by-upsert** like every other sync job — `odds_snapshots`
  is a genuine time series (spec section 25 wants price movement, not just
  a current price), so every successful run appends new rows rather than
  overwriting. **Not yet verified against a live API key** — same caveat
  as the other sync jobs.
- [ ] `syncOdds.ts` has no de-duplication: running it on a tight schedule
  with unchanged prices still inserts a full new set of snapshot rows every
  time, growing the table with duplicate-valued history. A future version
  could skip inserting when a selection's price is identical to its
  immediately preceding snapshot — not implemented now, to keep this job's
  first version simple and unambiguously correct rather than guessing at
  the right dedup window.
- [x] Wire the sync/prediction jobs to a scheduler — `backend/src/scheduler/scheduler.ts`,
  an in-process cron scheduler (`node-cron`) started from `index.ts` when
  `SCHEDULER_ENABLED=true` (off by default). Fixtures/team-statistics/
  injuries/standings run once daily, staggered 15–30 minutes apart so each
  depends only on the previous one having finished (fixtures first, since
  the others all read from it); lineups and odds run every 15 minutes,
  since they only become meaningful/accurate close to kickoff (spec section
  6: "refresh closer to kickoff"); predictions run once daily after the
  ingestion chain. If no data provider is configured, the six sync jobs are
  skipped entirely (with one startup warning, not a no-op every tick) —
  predictions still runs, since it reads `team_statistics` from the
  database rather than calling the provider. Each job is wrapped so a
  thrown/rejected error is logged, not left to crash the process or block
  later ticks. Uses node-cron's `noOverlap` option so a slow run of a
  15-minute job can't start a second overlapping run of itself.
- [ ] The scheduler assumes a single backend instance — `node-cron` has no
  cross-process coordination (no lock/leader-election), so running more
  than one replica with `SCHEDULER_ENABLED=true` would sync everything N
  times over redundantly. Fine for today's single-instance deployment
  (`Deployment.md`); revisit (e.g. a distributed lock, or moving this to an
  external scheduler like Cloud Scheduler hitting the existing admin
  endpoints) before running more than one replica.
- [ ] The scheduler's cron cadences are fixed constants in
  `scheduler.ts`, not configurable via env vars — fine for now since
  nothing has asked for per-job tuning yet; revisit if a real operational
  need for different schedules per environment shows up.
- [ ] **OBSERVATION PENDING** — none of the scheduler's cron timing has been
  observed running for real over multiple days (only unit-tested against
  fake timers/providers and smoke-tested for a few seconds at boot). The
  infrastructure to observe it now exists (`ingestion_runs` already
  persisted every run; `GET /admin/jobs`/`GET /admin/jobs/summary` read it
  back; `GET /health/scheduler` reports whether the scheduler is alive and
  each job's next run time) — what's missing is the observation period
  itself, which requires `SCHEDULER_ENABLED=true` plus a real
  `FOOTBALL_DATA_API_KEY` running continuously for at least 72 hours (7
  days preferred) in a persistent environment. This has NOT happened.
  Observation start time: not yet started. Do not mark this complete after
  a single successful run, however clean — a bad interaction only shows up
  after real repeated cycles (rate limits, token/lease expiry, accumulating
  duplicate rows, a job silently degrading to "partial" every time).
- [x] Add job-history/observability endpoints — `GET /admin/jobs` (recent
  `ingestion_runs` rows, optional `?job_name=`/`?limit=` filters) and `GET
  /admin/jobs/summary` (last run + last succeeded run per job_name,
  admin-authenticated); `GET /health/scheduler` (whether the scheduler is
  running, each job's cron expression and next run time) and `GET
  /health/api-football` (provider configured y/n, last request outcome,
  last-seen rate-limit headers — derived from real request history, not a
  live probe on every hit, to avoid burning API quota on health-check
  polls); `GET /health/data` extended with per-dataset freshness
  (fixtures/standings/team-statistics/injuries/lineups/odds/predictions),
  each classified LIVE/RECENT/STALE/UNAVAILABLE (surfaced alongside a
  GREEN/YELLOW/RED/GRAY color) via the existing `freshness.ts` thresholds.
  The `predictions` job now also writes an `ingestion_runs` row (it didn't
  before), so it shows up in this history like the six sync jobs. 15 new
  tests.
- [ ] Revisit the find-then-insert reference-data upserts
  (`referenceDataService.ts`) for a race condition if ingestion is ever
  parallelized — see its code comments.
- [ ] Set `competition_type` correctly (`syncFixtures.ts` hardcodes
  `"league"` for every synced competition — API-Football's league payload
  doesn't distinguish league/cup in the fixtures endpoint response used
  here; needs its own `/leagues` sync to get this right).

## Model

- [ ] Backtesting pipeline: load historical results, walk-forward
  train/validation/test split, write to `model_evaluations`.
- [ ] Add at least one additional model (e.g. gradient boosting) and compare
  against the Poisson baseline before calling anything an "ensemble."
- [ ] Fit the Dixon-Coles `RHO` parameter from real data instead of using
  the current fixed approximation (`ml-service/app/models/poisson.py`).
- [ ] League-specific calibration once enough leagues have real data.

## Frontend

- [x] User accounts (Supabase Auth) — `/sign-in`/`/sign-up` pages exist,
  `AuthProvider`/`useAuth()` tracks session + own profile. The whole app
  requires sign-in now, not just admin routes (see "Security" above).
- [x] Admin dashboard UI — `/admin` (provider connectivity, scheduler
  status, per-dataset freshness, job history + summary, manual sync
  trigger buttons for every job) and `/admin/users` (promote/demote), both
  under a shared `AdminLayout` sub-nav. No admin action is curl-only
  anymore. **Not yet verified against a live provider/Supabase project** —
  every render state was checked with mocked network responses in a real
  browser (Playwright), not real data (see `Data_Sources.md`'s and this
  file's live-verification caveats throughout).
- [ ] The admin dashboard's manual sync buttons always use each job's
  backend default window (e.g. `days=1` for fixtures, `hours=24` for
  lineups/odds) — no UI to override them. Fine for now; add input fields
  if an operator actually needs a wider one-off sync.
- [ ] Search, notifications, and a search/results UI — none exist yet.
- [ ] Daily analysis and accumulator research pages.

## Infra

- [ ] CI: add a security-scanning step (e.g. `npm audit` gate, `pip-audit`)
  before deployment.
- [x] Backend deployment config for Render — `render.yaml` (Blueprint,
  Docker runtime, secrets marked `sync: false`) plus a `backend/.dockerignore`
  so a local `.env` can never end up baked into an image. See
  `Deployment.md` → "Deploying the backend to Render" for the exact
  click-through steps. **Not yet actually deployed** — no Render account is
  connected to this repo/environment; this is config only, waiting on the
  user to connect their own account and click deploy.
- [ ] ML service and frontend still have no concrete hosting target
  (Dockerfiles exist, no Blueprint/IaC) — only the backend does now.
- [ ] Caching layer for fixtures/standings once there's a real provider
  worth caching.

## Housekeeping

- [ ] `npm audit` reported vulnerabilities in dev dependencies (eslint 8
  chain) for both `backend` and `frontend` — track and upgrade to ESLint 9
  when the flat-config migration is scheduled.
