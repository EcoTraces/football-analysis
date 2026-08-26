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
- [ ] No signup or role-assignment UI exists — the only way to create an
  admin today is the manual SQL step in README.md → "Creating the first
  admin user." Fine for one operator, not for a real admin team.
- [ ] Add request logging/audit trail for admin actions (who ran
  `/admin/sync`, when, with what result) — `requireAdmin` knows the
  authenticated user id at that point but nothing persists it yet.
- [ ] Consider token revocation/expiry edge cases explicitly: `auth.getUser()`
  should reject an expired or revoked token, but this hasn't been verified
  against Supabase's actual token lifecycle (only against the test fake,
  which has no concept of expiry).

## Data

- [x] Implement a real `FixtureProvider` — `ApiFootballProvider`
  (`backend/src/providers/ApiFootballProvider.ts`), registered in
  `providers/registry.ts`. **Not yet verified against a live API key** —
  see `Data_Sources.md`'s caveat. Get a real key and run `POST
  /api/admin/sync?days=1` against a real Supabase project before trusting it.
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
- [ ] None of the scheduler's cron timing has been observed running for
  real over multiple days (only unit-tested against fake timers/providers
  and smoke-tested for a few seconds at boot) — same "not yet verified
  against live infrastructure" caveat as the rest of the ingestion
  pipeline.
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

- [ ] Dashboard, search, notifications, and admin UI — none exist yet.
- [ ] Daily analysis and accumulator research pages.
- [ ] User accounts (Supabase Auth) — schema (`user_profiles`) is ready,
  frontend has no auth flow yet.

## Infra

- [ ] CI: add a security-scanning step (e.g. `npm audit` gate, `pip-audit`)
  before deployment.
- [ ] Production deployment target and config (frontend hosting, backend
  hosting, ML service hosting) — currently Dockerfiles/compose only.
- [ ] Caching layer for fixtures/standings once there's a real provider
  worth caching.

## Housekeeping

- [ ] `npm audit` reported vulnerabilities in dev dependencies (eslint 8
  chain) for both `backend` and `frontend` — track and upgrade to ESLint 9
  when the flat-config migration is scheduled.
