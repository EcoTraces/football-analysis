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
- [x] Manual security review (the `/security-review` automated skill could
  not run in this environment — its git-diff hook is fixed to a different,
  unrelated repo's working directory and cannot be redirected — so this was
  a manual read-through of the changes made since the last review instead).
  Found and fixed 3 issues, none critical/high:
  - `POST /admin/sync` and the 6 other admin sync/predictions-run routes
    (`team-statistics`, `injuries`, `standings`, `lineups`, `odds`,
    `predictions/run`) had no rate limit beyond the app-wide global one —
    a compromised or careless admin token could burn the API-Football
    quota for the whole app by hammering these. Added a stricter
    per-route limiter (`syncTriggerLimit` in `admin.ts`, 10 requests per
    15 minutes, keyed by authenticated user id rather than IP) to exactly
    those 7 routes. Deliberately not applied to `POST
    /admin/users/:id/role`, which doesn't call a third-party API.
  - `me.ts` applied `createRequireAuth` inline on its one route instead of
    via `router.use()`, unlike every other router in this codebase — not
    exploitable today (there was only ever the one route), but an
    inconsistency that would silently ship a second route unauthenticated
    if one were ever added without noticing the pattern. Changed to
    `router.use()` to match `admin.ts`/`fixtures.ts`/etc.
  - `fixturesService.ts`'s `teamId` filter built a raw PostgREST `.or()`
    filter string by interpolating `filters.teamId` directly. `.eq()`
    calls elsewhere are safely parameterized by supabase-js regardless of
    content, but `.or()` takes a raw string — an unvalidated value
    containing filter syntax (commas, `.`, operators) could inject
    additional OR conditions into the query. The one caller (`GET
    /fixtures`) already validates `teamId` as a UUID via zod before this
    function is reached, but that's an invariant this function couldn't
    see or enforce on its own. Added a defensive UUID-format check
    directly in `fixturesService.ts` at the point the string is built, so
    the function is safe even if called from somewhere that skips the
    caller-side validation. First-ever test coverage for this file: 4 new
    tests (`fixturesService.test.ts`), including one asserting a
    filter-syntax `teamId` is rejected rather than silently accepted.
    Required adding `.or()` support to the shared `FakeSupabase` test
    double.
  Verified: `tsc --noEmit`, `eslint`, `npm run build` all clean; full test
  suite passes, 145/145 across 19 files (up from 141/18). **Not a
  substitute for a real automated/third-party security audit** — this was
  one person(+AI) reading the diff, not a tool-driven scan or a
  professional pen test.
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
- [x] Cards (bookings) and corners data, for the `total_cards`/`total_corners`
  markets (see "Model" below). Two very different-sized pieces of work:
  - Cards: `ProviderTeamStatistics` gained `yellowCards`/`redCards`,
    `team_statistics` gained matching columns (migration 0005) —
    `ApiFootballProvider.ts::mapTeamStatistics` now also sums the vendor's
    per-minute-interval `cards.yellow`/`cards.red` breakdown from the
    **same** `/teams/statistics` response `syncTeamStatistics.ts` was
    already fetching. No new provider call, no new sync job.
  - Corners: api-football simply doesn't expose corners in
    `/teams/statistics` at any level, so this needed real new
    infrastructure — a new `fixture_statistics` table (migration 0005, one
    row per fixture+team), a new `FixtureStatisticsProvider`/
    `getFixtureStatistics` (`/fixtures/statistics`, one call per **finished**
    fixture, windowed to the last 72h by default like lineups/odds are
    windowed around kickoff), a new `syncFixtureStatistics.ts` job wired
    into the scheduler (daily, before predictions) and
    `POST /admin/fixture-statistics/sync?hours=N`, and an aggregation step
    (`refreshTeamCornersAverage`) that averages a team's per-fixture corners
    into the (previously unpopulated) `team_statistics.corners` column via a
    column-scoped upsert that can't clobber the goals/cards fields the
    team-statistics job writes to the same row.
  - Extended `GET /health/data`'s freshness domains with `fixtureStatistics`
    (same once-daily-cadence policy as `teamStatistics`).
  - 20 new backend tests (provider mapping, the new sync job including its
    aggregation function, freshness/health wiring, `FootballDataProvider`'s
    now-eight-method interface satisfied by every fake provider in the test
    suite), plus fixing two real gaps this surfaced in the shared
    `FakeSupabase` test double that nothing had exercised before: `.insert()`
    only ever handled a single row, not an array (`generatePredictions.ts`
    inserts one row per market in one call), and `.update()` executed on the
    first `.eq()` instead of supporting a full filter chain
    (`generatePredictions.ts`'s `.eq("fixture_id", …).is("superseded_at",
    null)`) — see `testSupabaseFake.ts`'s comments on both.
  - **Not yet verified against a live API-Football key** — same caveat as
    the rest of `Data_Sources.md`. In particular, `"Corner Kicks"` as the
    vendor's exact `type` string for corner kicks in `/fixtures/statistics`
    is unconfirmed; if it differs, `mapFixtureStatistics` silently returns
    `corners: null` for every fixture rather than erroring, which would be
    easy to miss without checking a real response.
- [x] Populate `fixtures.home_score_ht`/`away_score_ht` — present in the
  schema since 0001, never parsed or written by any sync job until the
  `first_half_result`/`half_with_most_goals` markets (see "Model" below)
  needed a real data source to eventually check those predictions against.
  `ProviderFixture` gained `homeScoreHt`/`awayScoreHt`, mapped from the
  vendor's `score.halftime` object in `ApiFootballProvider.ts::mapFixture`;
  `syncFixtures.ts` writes both columns on every insert/update, same as the
  existing full-time score. 2 new tests. **Not yet verified against a live
  API-Football key** — the exact shape of `score.halftime` in a real
  response is unconfirmed, same caveat as every mapping in this file.
- [x] Player-level statistics ingestion, for the anytime-goalscorer markets
  (see "Model" below) — the biggest single build this session, since
  nothing in this schema tracked goals-per-player before it (`players` only
  ever had name/position/team). New: `player_statistics` table (0006,
  `player_id, team_id, season_id, player_name` (denormalized — see the
  migration's comment on why), `matches_played`, `goals_scored`,
  `minutes_played`); `PlayerStatsProvider`/`getPlayerStatistics`
  (api-football's `/players` endpoint, team/competition/season-scoped like
  `getTeamStatistics` — **single page only**, a documented limitation, not
  a bug, since the anytime-goalscorer market only ever surfaces a team's
  top 6 scorers anyway); `ApiFootballProvider.ts::mapPlayerStatistics`
  picks the stint matching the requested competition when a player has
  multiple (e.g. league + cup); `syncPlayerStatistics.ts` (mirrors
  `syncTeamStatistics.ts`'s combination-dedup shape exactly, reuses
  `upsertPlayer` from `syncLineups.ts`), wired into
  `POST /admin/player-statistics/sync` and the scheduler (daily, right
  after team-statistics). `GET /health/data` gained a `playerStatistics`
  freshness domain (same cadence as `teamStatistics`).
  New tests: `syncPlayerStatistics.test.ts` (7), 4 new
  `apiFootballProvider.test.ts` tests for the competition-stint-matching
  logic, plus 1 each for the new `playerStatistics` freshness domain in
  `freshness.test.ts`/`health.test.ts`. 179 backend tests total (was 166).
  **Not yet verified against a live API-Football key** — same caveat as
  every provider mapping in this file; in particular the exact shape of a
  multi-stint `/players` response (same team, two competitions) is
  unconfirmed.
- [ ] `upsertPlayer` (`referenceDataService.ts`) doesn't update an existing
  player's `players.team_id` on a repeat call — a transferred player's row
  can go stale. `player_statistics` itself is correctly keyed by
  `player_id, team_id, season_id` so a transfer gets its own row there;
  only direct reads of `players.team_id` are affected. See `Database.md`.

## Model

- [x] Added `double_chance` and `correct_score` markets to the Poisson
  model's output (`ml-service/app/main.py`,
  `ml-service/app/models/poisson.py`). Both are *derived* from the same
  score matrix as the existing 1X2/BTTS/O-U 2.5 markets, not separately
  modeled: double chance sums the relevant pair of 1X2 outcomes;
  correct_score surfaces the top 10 most probable exact scorelines plus one
  `"other"` selection covering the rest of the probability mass, so it
  still sums to 1. The backend/DB layer needed **no changes** —
  `predictions.market`/`selection` are free-text columns and
  `generatePredictionsForUpcomingFixtures` already relays whatever markets
  the ml-service returns. Frontend: `MatchDetail.tsx` now renders both as
  additional `PredictionCard`s; `PredictionCard.tsx` got human-readable
  selection labels (`Home or draw (1X)`, `Other scoreline`, etc.) and now
  sorts each card's rows by probability descending (with `"other"` always
  last). 8 new tests (4 ml-service, 4 frontend); ml-service suite now
  15/15, frontend suite now 20/20. **Not yet verified against a live
  Supabase/API-Football setup** — same caveat as the rest of this file.
  Odds ingestion (`syncOdds.ts`/`ApiFootballProvider.mapOdds`) still only
  covers `1x2`/`btts`/`over_under_2_5` — these two new markets have model
  probabilities only, no bookmaker price to value-compare against yet; see
  the new item below.
- [ ] Extend `ApiFootballProvider.mapOdds`/`syncOdds.ts` to also ingest
  `double_chance` and `correct_score` bookmaker odds (API-Football exposes
  both as bet types) now that the prediction engine produces matching
  markets — needed before Value Analysis (spec section 25) can compare
  either against a real price. Confirm the exact bet-name/value strings
  against a live API-Football response first; nothing in this environment
  has done that yet for any market.
- [x] Added `total_cards` and `total_corners` markets — a genuinely
  different, much simpler model from the goals one above, not a derivation
  of it (`ml-service/app/models/count_markets.py`). Each side's own
  historical average (cards or corners per match) is summed into one
  combined rate and modeled as a single Poisson variable against a fixed
  line (3.5 cards, 9.5 corners — `CARDS_LINE`/`CORNERS_LINE` in `main.py`,
  same "plausible, not calibrated" caveat as `over_under_2_5`). Reasoning:
  unlike goals, there's no attack-vs-opposing-defense relationship this
  platform has data to support for cards/corners — a card is mostly about a
  team's own discipline and the referee, not the opponent. Each market is
  only produced when **both** teams' averages are present in the request
  (`generatePredictions.ts` sends `undefined`, never `0`, for a team whose
  `team_statistics` row lacks the field) — so `total_corners` in particular
  will be silently absent from every fixture until
  `syncFixtureStatistics.ts` (see "Data" above) has actually populated
  `team_statistics.corners` for both teams. 8 new ml-service tests (21/21
  total), 2 new backend tests for the `generatePredictions.ts` wiring, 4 new
  frontend tests (22/22 total). **Not yet verified against a live
  Supabase/API-Football setup**, and the fixed lines are a starting point,
  not researched — see `ML_Model.md`.
- [x] Added `first_half_result`, `second_half_result`, and
  `half_with_most_goals` markets (`ml-service/app/models/half_markets.py`).
  Reuses `poisson.py`'s `score_matrix()` directly but is not a derivation of
  the full-match matrix (unlike double chance/correct score) — each half
  gets its own matrix, built from the full-match `lambda_home`/`lambda_away`
  split by a fixed `FIRST_HALF_FRACTION = 0.45` (empirically plausible, not
  fitted) and deliberately using `rho=0` rather than the full match's `RHO`
  (no basis for assuming Dixon-Coles' low-score correlation applies
  unadjusted to a 45-minute segment — compounding one unfitted constant onto
  another felt worse than just not applying it). Always computed, no
  optional-data gating like cards/corners. 7 new ml-service tests (28/28
  total), 1 new backend test asserting all 3 markets appear (part of the
  166/166 count above), 2 new frontend tests (24/24 total). **Not
  calibrated or backtested against anything** — see `ML_Model.md`'s
  caveat, and the `fixtures.home_score_ht`/`away_score_ht` item above for
  the data source that would eventually let that check happen.
- [x] "Player to score" (`home_anytime_goalscorer`/`away_anytime_goalscorer`)
  markets — the last item from the original market wishlist, and the
  biggest: it needed the whole `player_statistics` ingestion pipeline (see
  "Data" above) that didn't exist at all before this. The model itself
  (`ml-service/app/models/player_market.py`) is a genuinely different shape
  from every other market: independent per-player probabilities that are
  **not** mutually exclusive (don't sum to 1), and **not lineup-gated** — a
  stated, deliberate simplification (ranks a team's own top season
  scorers, doesn't check who's actually selected for this specific
  fixture; see `ML_Model.md` for the reasoning and the lineup-gated
  version this could become). 11 new ml-service tests (39/39 total —
  9 in `test_player_market.py`, 2 new `test_api.py` tests), extended
  `generatePredictions.test.ts`'s existing case rather than adding a new
  one (part of the 179/179 count above), 2 new frontend tests (26/26
  total, was 24). **Not calibrated, backtested, or verified against a
  live API-Football key** — see `ML_Model.md`'s caveats, plural, for this
  one; there are more open assumptions here than any other market built
  this session.
- [x] Added 8 more markets, requested directly by name: clean sheet
  (`home_clean_sheet`/`away_clean_sheet`), odd/even total goals
  (`odd_even_goals`), draw no bet (`draw_no_bet`), team total goals
  (`home_team_total_goals`/`away_team_total_goals`, line 1.5), a combined
  BTTS-and-result market (`btts_and_result`, 6-way joint), a combined
  result-and-total-goals market (`result_and_total_goals`, 6-way joint),
  a fixed-line handicap (`handicap`, home -1.5), and win-at-least-one-half
  (`home_wins_a_half`/`away_wins_a_half`). Unlike the last three rounds,
  every one of these needed **zero new data** — all derived from the same
  full-match matrix, half matrices, or `lambda_home`/`lambda_away` already
  computed for every other market (`poisson.py` gained
  `btts_and_result_probabilities`, `result_and_total_goals_probabilities`,
  `handicap_probabilities`, plus clean-sheet/odd-even/DNB added to
  `market_probabilities()`'s output; `half_markets.py` gained
  `wins_at_least_one_half_probabilities`; team total goals reuses
  `count_markets.total_over_under()` directly against a single side's own
  lambda). The two joint markets are genuine joint distributions (BTTS and
  match result are correlated through the same scoreline), not the product
  of two markets' marginals — tests assert the joint reduces to the right
  marginal when summed. `home_wins_a_half`/`away_wins_a_half` share
  anytime-goalscorer's "independent, doesn't sum to 1" shape, since both
  sides can win a half in the same match. 10 new ml-service tests (49/49
  total, was 39), 3 new frontend tests (29/29 total, was 26). Backend
  needed no changes at all this round — confirmed the existing 179/179
  suite passes unmodified. **Not calibrated, backtested, or verified
  against a live API-Football key** — same caveat as every fixed line in
  `ML_Model.md` (`TEAM_TOTAL_GOALS_LINE = 1.5`, `HANDICAP_HOME_LINE =
  -1.5` chosen for plausibility, not fitted).
- [x] Backtesting pipeline (`backend/src/jobs/runBacktest.ts`): walk-forward
  evaluation of the `1x2` market only (the other ~20 markets aren't
  backtested yet). The core design problem: `team_statistics` is a single
  current snapshot, not a time series, so using it to predict a historical
  fixture would leak future-season data into that "historical" prediction
  (lookahead bias) and make the backtest lie about how good the model
  actually is. Solved by `computePointInTimeStrength()`, which recomputes
  each team's strength directly from `fixtures`' own finished, non-synthetic
  match history strictly **before** the fixture being backtested — never
  from `team_statistics`. For each qualifying fixture (same
  `MIN_MATCHES_FOR_PREDICTION = 3` threshold as live predictions, now
  exported from `generatePredictions.ts` for reuse), calls the real
  `PredictionClient.predictPoisson()` and scores the result against what
  actually happened: accuracy (argmax match), log loss (clamped away from
  probability 0 so one bad forecast can't make a run's average infinite),
  and Brier score (standard multi-class form — summed over the three
  outcomes per fixture, averaged over fixtures). Writes one
  `model_evaluations` row per run — the first writer that table has ever
  had. `runLatestBacktestJob()` gets the same `ingestion_runs` bookkeeping
  every sync job has, but is **deliberately not wired into the scheduler**
  — this is an occasional, admin-triggered evaluation over a chosen date
  range, not ongoing ingestion. New admin routes: `POST
  /admin/backtest/run?from=&to=&competitionId=` (rate limited like every
  other trigger; 366-day range cap) and `GET /admin/backtest/results`. New
  `AdminDashboard.tsx` panel (from/to date pickers, "Run backtest" button,
  a results table) so this is never a curl-only capability. 5 new backend
  tests (184/184 total, was 179) — most importantly, a direct test proving
  `computePointInTimeStrength()` excludes a fixture at or after the target
  kickoff (a simultaneous result isn't "prior" data either), plus a test
  proving the accuracy/log-loss/Brier-score math against known synthetic
  predictions, and one proving fixtures below the match-count threshold are
  skipped and write no row. 3 new frontend tests (32/32 total, was 29).
  **The pipeline is real and tested against synthetic/fake data, but has
  never been run against real historical results** — no live API-Football
  key has ever been connected in this environment, so there is no real
  fixture history to backtest against; see `ML_Model.md`'s "Backtesting"
  section for the full caveat.
- [x] Added a second model — gradient boosting, 1x2 market only (same
  market-scope discipline as backtesting; not ported to all ~20 markets
  before this one is proven out). `ml-service/app/models/gradient_boosting.py`:
  `GradientBoostingOneXTwoModel` wraps sklearn's `GradientBoostingClassifier`,
  refuses to train on fewer than `MIN_TRAINING_ROWS` (20) rows or a
  single-outcome dataset, and `predict()` raises `NotTrainedError` (mapped
  to ml-service `409`, then to a `null` result by `PredictionClient` —
  same "unavailable, never fabricated" contract `predictPoisson()` already
  has) rather than guessing 1/3-1/3-1/3 before anyone has trained it.
  New endpoints `POST /train/gradient_boosting` and
  `POST /predict/gradient_boosting`. State is process-local, in-memory
  only — a restart loses the trained model; documented, not solved, since
  a real persistence layer is out of scope for a first cut.
  `backend/src/jobs/trainGradientBoosting.ts` builds training rows the same
  way `runBacktest.ts` builds backtest fixtures — reusing
  `computePointInTimeStrength()` so training never leaks a team's future
  results into its own historical training row (the identical lookahead-bias
  concern that motivated backtesting in the first place) — then calls
  ml-service and, on success, updates the `gradient-boosting`
  `model_versions` row's `trained_at`/`training_dataset_version`/`notes`.
  **The comparison mechanism**: `runBacktest.ts` was generalized to take a
  `predictFn` instead of hardcoding `predictPoisson()`, and
  `runLatestBacktestJob()` now takes a `modelName` (`poisson-baseline` or
  `gradient-boosting`, default the former) — running a backtest over the
  same date range once per model produces two directly comparable
  `model_evaluations` rows, which is what "compare... before calling
  anything an ensemble" actually requires. New admin routes:
  `POST /admin/backtest/run` gained a `model` query param;
  `POST /admin/model/gradient-boosting/train?from=&to=&competitionId=`;
  `GET /admin/backtest/results` now enriches each row with its model name.
  New `AdminDashboard.tsx` controls: a model selector next to the existing
  backtest date range, and a "Train gradient boosting" button showing
  in-sample accuracy (explicitly labeled as not a generalization metric).
  `gradient-boosting` got a `model_versions` row in the dev seed, same
  bootstrap pattern as `poisson-baseline`'s (no admin route creates these
  rows yet) — deliberately left untrained (`trained_at = null`), since the
  4 synthetic dev fixtures are nowhere near `MIN_TRAINING_ROWS` and
  synthetic data must never be used to fabricate a "trained" model.
  Test counts: ml-service 59/59 (was 49 — 7 new in `test_gradient_boosting.py`,
  3 new in `test_api.py`), backend 194/194 (was 184 — 4 new in
  `trainGradientBoosting.test.ts`, 5 new in `predictionClient.test.ts`, 1
  new in `runBacktest.test.ts` for the model-lookup generalization),
  frontend 35/35 (was 32). `tsc`/`eslint`/`npm run build` clean across all
  three. **Like backtesting, this has never been run against real data** —
  no live API-Football key exists in this environment, so there's no real
  fixture history to train the model on; it stays untrained until someone
  does. See `ML_Model.md`'s "Gradient boosting model" section for the full
  caveat list (including: no `factors` explanation, unlike Poisson's
  `explain_factors()` — there's no honest plain-language story for what a
  gradient-boosted ensemble weighted).
- [ ] Fit the Dixon-Coles `RHO` parameter from real data instead of using
  the current fixed approximation (`ml-service/app/models/poisson.py`).
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
