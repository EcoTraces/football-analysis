# Final Report — Platform Transformation Audit

This report closes out the master-prompt engagement: "act as a full
engineering team, audit the entire repository, fix real bugs, harden
security, improve the prediction/accumulator engine, redesign UI/UX, add
testing, optimize performance, centralize configuration, document
everything." It covers what was found, what was actually fixed (not just
recommended), what remains open, and why. Every claim below is backed by a
file path, a commit, a test, or a live health-check response captured
during this engagement — nothing here is asserted without evidence, in
keeping with this codebase's own "never fabricate" rule.

For the itemized, line-by-line before/after of every change, see
`Changelog.md` (dated entries) and `Task.md` (checklist with rationale per
item). This report is the synthesis; those two files are the source of
truth.

---

## A. Existing architecture (what this platform is)

A three-service monorepo: a Node/Express/TypeScript backend, a
Python/FastAPI ml-service (Poisson/Dixon-Coles + gradient boosting + Elo +
an ensemble combiner), a React/Vite/TypeScript/Tailwind frontend, and
Supabase/Postgres for storage and auth. Two swappable fixture-data
providers (`ApiFootballProvider`, `FootballDataOrgProvider`) sit behind a
`FootballDataProvider` interface — never blended, each keyed under its own
`external_ref` jsonb key so switching providers never silently merges two
providers' notion of "the same team." An in-process `node-cron` scheduler
drives ~13 sync/prediction/maintenance jobs. See `Architecture.md`,
`Database.md`, `Data_Sources.md` for the full design; this report doesn't
restate them.

**Confirmed live** (this engagement's own direct health checks against
the deployed services, not a claim from documentation): the backend,
ml-service, and a real Supabase project are all deployed and reachable.
`GET /health/data` reports `database: reachable`, `provider:
football-data-org`, 443 real (non-synthetic) fixtures. `GET
/health/api-football` reports `CONNECTED` with real rate-limit data. `GET
/health/scheduler` reports `RUNNING` with all 13 jobs registered. See
`Road_map.md`'s "Live status" note for the exact response snapshot.

---

## B. Problems found

A full-repo audit plus the live health checks above surfaced, in order of
severity:

1. **Live 500s on `team-statistics/sync` and `player-statistics/sync`** —
   the original trigger for this engagement. Root-caused to
   `referenceDataService.loadExternalRefs` issuing one unbounded `.in()`
   query per sync run; at real data volumes this risks exceeding a
   PostgREST/proxy request-length limit.
2. **The ml-service had no authentication** — reachable by anyone who
   could reach its URL, not just the backend.
3. **No audit trail for admin actions** — a promote/demote, a manual
   sync trigger, a config change: none of it was recorded anywhere.
4. **The scheduler had no cross-process lock** — if this ever runs on
   more than one instance, two replicas could run the same job
   concurrently with no guard.
5. **`supabase/migrations/0001_init.sql` was not safely re-runnable** —
   discovered by a new CI job, not a live incident, but the same class of
   bug that had already caused a real production outage one day earlier
   (see `Changelog.md`'s 2026-09-04 entry: migrations 0005-0013 had the
   identical gap and it broke a real deploy).
6. **`odds_snapshots` grew unboundedly with duplicate-valued rows** — a
   tight sync schedule against unchanged prices inserted a full new set of
   snapshot rows every run, an explicitly flagged future-optimization gap
   in `Task.md`.
7. **`GET /admin/users` silently truncated at 200 accounts** — fine at
   today's scale, a real bug the moment the platform has more users than
   the auth API's default page size.
8. **`upsertPlayer` never updated `team_id` on a real transfer** — a
   player's row would go stale, mis-attributing them to their old club for
   any direct read of `players.team_id`.
9. **No integration/E2E test coverage** — every existing test was a unit
   test against a hand-rolled Supabase fake; nothing exercised a real
   Postgres instance or a real browser.
10. **No caching layer anywhere** — every read endpoint hit the database
    on every request, including ones with clear, safe TTLs (a league list
    that changes rarely, "today's fixtures" that's the same for every
    concurrent user for 60 seconds).
11. **`competition_type` was hardcoded to `'league'`** for every synced
    competition regardless of what the provider actually reported.
12. **Two production-blocking gaps this environment couldn't fix itself**
    (see Section L): no `model_versions` row for `ensemble` in production
    (causing a `409` on every prediction run), and `ML_SERVICE_URL` likely
    still at its `localhost` default in the Render dashboard (causing
    `500`s on anything that calls the ml-service in production). **Both
    fixed by the user directly, same day** — see Section L.

---

## C. Fixes implemented

All of B1–B11 above were fixed, tested, and shipped to `main` in this
engagement; B12's two gaps were user-actioned directly against production
(see Section L):

- **B1**: `loadExternalRefs` now chunks ids into batches of 100
  (`EXTERNAL_REF_LOOKUP_CHUNK_SIZE`, `referenceDataService.ts`).
- **B2**: `ML_SERVICE_API_KEY` header check (`ml-service/app/security.py`)
  in front of every route but `/health`; `PredictionClient` sends it.
- **B3**: `admin_audit_log` (migration 0015) + `auditAdminActions.ts`
  middleware applied to every admin route; `GET /admin/audit-log` +
  an AdminDashboard panel.
- **B4**: `try_acquire_job_lock` (migration 0016, an atomic
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now()`) +
  `lib/jobLock.ts` + `scheduler.ts`'s `withJobLock()`.
- **B5**: every `create table`/`create index` in `0001_init.sql` now has
  `if not exists`; every RLS policy uses `drop policy if exists` +
  `create policy`. Verified against a real local Postgres 16 instance,
  three clean re-applications.
- **B6**: `syncOdds.ts`'s `loadLatestOddsByKey` skips inserting a
  selection whose price exactly matches its own immediately preceding
  snapshot; a genuine price change always still appends.
- **B7**: `listUsersWithRoles` now walks every page of
  `auth.admin.listUsers()` until a short page signals the end.
- **B8**: `upsertPlayer` updates `team_id` on an existing row when a
  later sync reports a different team.
- **B9**: see Section I (Testing).
- **B10**: see Section J (Performance).
- **B11**: `ProviderFixture.competitionType` → `normalizeCompetitionType()`
  now correctly classifies football-data.org's `LEAGUE`/`CUP` field
  (api-football's `/fixtures` endpoint has no equivalent field at all —
  documented as a real limitation, not silently ignored).

Every fix above shipped with its own unit tests against `FakeSupabase`
(this codebase's hand-rolled Supabase test double) and passed the full
verification gate — backend lint/typecheck/test/build, frontend
lint/typecheck/test/build — before being pushed. See `Changelog.md` for
the exact commit-by-commit account.

---

## D. New features added

- **Admin audit log** — every mutating admin action (promote/demote, a
  manual sync trigger, a config write) is now recorded with actor,
  method, path, status, and request body, readable via
  `GET /admin/audit-log` and a new AdminDashboard panel.
- **Cross-process job locking** — real infrastructure for running the
  scheduler on more than one instance safely, ahead of actually needing
  it.
- **The AI Football Analyst & Accumulator Engine (Phase 1)** — a real
  Elo model, an ensemble combiner over Elo/Poisson/Form/Home-Away/
  Injuries/Market components (never fabricating a missing one — weight is
  redistributed across only the components actually available), EV/edge
  against real ingested 1x2 odds, a 0–100 selection score, 5-tier risk
  classification, a Top-20 screening view, a "Matches to Avoid" view, and
  an accumulator optimizer with same-team correlation penalties across
  5/7/10/15/20-leg targets. Shipped in a prior session within this same
  engagement lineage (`Changelog.md`'s 2026-09-03 entry); this
  engagement's own contribution was the hardening pass around it (the
  migration idempotency fix that a real production deploy of exactly this
  feature had surfaced), not the feature itself.
- **`db-migrations` and `frontend-e2e` CI jobs** — see Section I.
- **A TTL caching layer** — see Section J.

---

## E. Prediction engine improvements

No changes to the model math itself in this engagement (Elo, Poisson,
Dixon-Coles, gradient boosting, and the ensemble combiner were already
built and calibrated in the prior session referenced in Section D). This
engagement's contribution to prediction quality was entirely about
**getting the pipeline the models depend on to actually run correctly in
production**: the B1 fix (chunked id lookups) directly unblocks
`team-statistics`/`player-statistics` syncing, which the ensemble's
Home/Away and Form components depend on; the competition_type fix (B11)
improves the accuracy of competition classification the screening
allowlist depends on. The two remaining blockers to the model pipeline
running end-to-end in production (`model_versions` seed row,
`ML_SERVICE_URL`) were both one-line fixes this environment couldn't
apply itself — both are now fixed by the user directly (see Section L);
end-to-end confirmation that a prediction run actually completes is the
one step still pending.

---

## F. Accumulator engine improvements

The accumulator optimizer itself (`buildAccumulators.ts`,
`selectAccumulatorLegs`) was built in the prior session (Section D). This
engagement's direct contribution: the `odds_snapshots` de-duplication fix
(B6) keeps the odds history the accumulator's EV/edge calculations read
from clean of duplicate-valued noise once the scheduler is actually
running against live data, and the migration-idempotency fix (B5)
protects `accumulator_targets`/`ensemble_config`/`screening_config` (the
accumulator's admin-configurable weights and thresholds) from the exact
class of deploy failure that broke them once already in production
(`Changelog.md`'s 2026-09-04 entry).

---

## G. UI/UX improvements

A full redesign of the six real frontend routes (design system + component
polish) was completed in a prior session within this engagement lineage
(`Changelog.md`'s 2026-08-29 entry). This engagement's UI contribution was
narrower and additive: a new "Admin audit log" panel on `AdminDashboard.tsx`
(same table/loadPiece/StatusBadge pattern as every existing section, so no
new visual language introduced), and the E2E-verified confirmation (not
just a code review) that dark/light mode, responsive layout at 390px and
1280px, and the unconfigured-auth fallback all actually render correctly
in a real browser — see Section I.

---

## H. Security improvements

- **ml-service authentication** (B2) — closes the most serious open
  finding: the ml-service was previously reachable by anyone who could
  reach its URL, with no distinction between "the backend calling it" and
  "anyone on the internet calling it."
- **Admin action audit trail** (B3) — every admin mutation is now
  attributable and reviewable after the fact; previously there was no way
  to answer "who changed this and when."
- **RLS/migration idempotency hardening** (B5) — while framed as a
  reliability fix, a migration that fails halfway through on a partially-
  applied database is itself a security-relevant failure mode (it can
  leave RLS policies or newly-added tables in an inconsistent state).
- Prior-session security work not repeated here: hardened `user_profiles`
  RLS against role self-escalation, JWT-based admin route auth,
  retry/backoff hardening against a hostile or flaky upstream — see
  `Changelog.md`'s 2026-08-26/2026-08-27 entries.
- **Explicitly not done, and why**: no dependency-injection framework,
  no WAF, no penetration test — none of these were findings from the
  actual audit; adding them without a concrete threat they address would
  be speculative hardening, not a fix. `npm audit`'s one open finding
  (an ESLint 8 dev-dependency chain) is dev-only, tracked in `Task.md`,
  and deliberately not force-upgraded to ESLint 9 given the flat-config
  migration's blast radius versus a dev-only, non-shipped risk.

---

## I. Testing summary

Before this engagement: unit tests only, all against `FakeSupabase` (a
hand-rolled Supabase query-builder double), no integration tests, no
browser tests, no CI verification of migrations against a real database.

**Added this engagement**:
- **`db-migrations` CI job** — a real Postgres 16 service container;
  applies every migration file twice per run, which is what actually
  caught `0001_init.sql`'s non-idempotency (B5) before it could repeat
  the 2026-09-04 production incident on a fresh project.
- **`frontend-e2e` CI job** — real Chromium via Playwright, 6 tests
  covering the unconfigured-auth fallback (both `/sign-in` and
  `/sign-up`), dark/light mode toggle-and-persist, no horizontal overflow
  at 390px/1280px, zero real console errors, and SPA routing on direct
  navigation. Honestly scoped to what's testable with no live Supabase
  project reachable from CI (`frontend/e2e/README.md` explains the
  boundary) — this does not claim to test a real sign-in or the
  authenticated app.
  - This job needed two follow-up fixes after its first real CI run
    surfaced problems invisible in local testing (a useful case study in
    "verified locally" not being the same claim as "verified in the
    actual target environment"): a cold-start timeout, and its actual
    root cause — vite's default `--host localhost` binds whichever
    address Node's DNS order prefers (often IPv6-only on a CI runner),
    while Playwright's health check polls the literal IPv4 `127.0.0.1`.
    Fixed by passing `--host 127.0.0.1` explicitly. Both follow-up
    commits are documented in `Changelog.md` rather than folded silently
    into the original commit, since the failure and its real cause are
    worth keeping visible.
- New unit tests for every fix in Section C — 370 backend tests, 83
  frontend tests, all passing as of this report; exact per-fix test
  names are in each `Changelog.md` entry.

**Explicitly not done, and why**: a live-data integration test against a
real API-Football/Supabase project (this environment has no such
credentials — see Section L); a load/performance test (no realistic
traffic pattern to model this against yet, at pre-launch scale); a full
accessibility audit (out of scope for this engagement's findings, no
accessibility bug was found in the audit).

---

## J. Performance / optimization summary

- **In-process TTL cache** (`lib/ttlCache.ts`) added to `GET /leagues`
  (10 min), `/fixtures/today` and `/fixtures` (60s, the latter keyed on
  the full filter set), `/teams/:id` (5 min), and the three screening
  views — `/top20`, `/matches-to-avoid`, `/accumulators` (5 min each).
  Chosen over Redis because this runs as a single Render instance; time-
  based expiry only, no active invalidation (documented in the cache
  module's own comment as the accepted tradeoff at this scale).
- **`odds_snapshots` de-duplication** (B6) is also a storage/performance
  fix, not just a data-quality one: it caps how fast this table grows
  under a live, tightly-scheduled sync.
- **Chunked reference-data lookups** (B1) trades one large request for
  several small ones — a latency cost at very small scale, but the fix
  that makes large-scale syncing possible at all instead of failing
  outright.

---

## K. Deployment summary

The platform **is deployed and reachable** (backend, ml-service, and a
real Supabase project — see Section A's live health-check evidence), but
**"deployed" is not "operationally verified."** The same live checks that
confirmed deployment also showed `standings`/`teamStatistics`/
`playerStatistics`/`injuries`/`lineups`/`odds`/`fixtureStatistics`/
`predictions` all reporting `UNAVAILABLE` in `GET /health/data`'s
freshness report — none of those datasets has ever successfully populated
in production. Manually triggering the underlying jobs during this
engagement surfaced the real bugs listed in Section B, most now fixed;
the two production-configuration gaps that remained (Section L) — both
one-line fixes this environment couldn't apply itself — are now fixed by
the user directly: `model_versions` is seeded and `ML_SERVICE_URL` points
at the real ml-service, both confirmed live. `fixtures`/`standings` are
confirmed populating for real (444 fixtures, `RECENT`); `predictions`
still awaits its next scheduled run or a manual trigger to confirm the
full pipeline end-to-end. `Road_map.md`'s "Live status" note carries the
exact, dated evidence for all of this — read it before trusting any older
phase-status text in the same file, which mostly still describes this
repository's dev/CI sandbox rather than the live deployment.

---

## L. Remaining risks and explicitly blocked items

**Resolved by the user, same day, after this report's first draft:**
both of the items below were blocked-on-the-user findings; the user
fixed both directly against production before this report was finalized.

1. ~~No `model_versions` row for `'ensemble'`/`'poisson-baseline'` in
   production~~ — fixed: both rows now exist (verified via a live
   `select` against the production Supabase project: `poisson-baseline`/
   `dixon-coles-poisson` and `ensemble`/`ensemble-combiner`, both with
   `trained_at: null`, which the prediction jobs' lookup doesn't require).
2. ~~`ML_SERVICE_URL` likely still at its `localhost` default~~ — fixed:
   now points at the real `football-analysis-ml-service` Render URL,
   confirmed reachable (`GET /health` returns `{"status":"ok"}`).

**Not yet confirmed end-to-end**: `GET /health/data` still reports
`predictions: UNAVAILABLE` as of this update — expected, since the
`predictions`/`predictions_ensemble` scheduler jobs weren't due again
until their next cron firing at the time both fixes landed. `fixtures`
and `standings` are confirmed `RECENT` with 444 real fixtures, so the
pipeline is demonstrably working end-to-end for the jobs that have run
since these fixes. Verifying `predictions` needs either waiting for the
next scheduled run or using the admin dashboard's manual trigger buttons.

**Still blocked on the user — nothing below can be resolved from this
environment**, because each requires either a real third-party account,
Render dashboard access, or production Supabase SQL access this
environment has never had:

1. **No live API-Football key has ever been verified** — every
   provider-mapping fix in this engagement (and the prior session's) is
   implemented from vendor documentation, not confirmed against a real
   response. `GET /health/api-football` currently reports the
   football-data.org provider as the active one, not api-football, so
   this may be moot if football-data.org remains the chosen provider —
   but if api-football is ever switched to, its mapping is unverified.
2. **The scheduler's cross-process lock (B4) has never been exercised
   against actually-concurrent replicas** — this is still a single
   `plan: free` Render instance, so the lock is real, tested infrastructure
   ahead of need, not yet proven under real concurrency.
3. **Token revocation/expiry, email-confirmation UX** — both depend on
   the real Supabase project's actual Auth configuration, which this
   environment cannot inspect or exercise (`Task.md`'s "BLOCKED ON THE
   USER" section has the full list).
4. **The 72-hour scheduler cadence observation period** has not run —
   the cron schedules are implemented and unit-tested, but nobody has
   watched them fire correctly against a live clock for 72 hours yet.

**Deliberately deferred, not blocked** — these are real, understood gaps
where implementing a fix now would mean guessing at behavior this
environment has no way to confirm, which this codebase's own "never
fabricate" rule argues against:

- `syncStandings.ts`'s group-flattening (split tables/group stages) and
  `syncLineups.ts`'s always-`'confirmed'` status are both reasoned from
  vendor documentation that itself hasn't been checked against a live
  response — revisiting either now would mean guessing at a fix for a
  problem not yet confirmed to exist.
- `syncInjuries.ts` never marks a player `'returned'` — deferred pending
  an actual signal to detect recovery from (e.g. reappearing in a
  confirmed lineup), not implemented speculatively.
- Extending odds ingestion beyond 1x2/BTTS/O-U 2.5, a dedicated results-
  sync job for historical fixtures, a `/countries` and `/teams` sync for
  authoritative country data — all real, named gaps in `Task.md`, but
  each is a new feature (new provider methods, new jobs, new tests), not
  a bug fix, and each was explicitly scoped as Phase 2+ in the AI Football
  Analyst plan referenced in Section D.
- ESLint 8 → 9 flat-config migration — a real `npm audit` finding, but
  dev-only (never shipped), and the migration's blast radius across both
  `backend` and `frontend`'s lint configs isn't worth rushing for a
  non-shipped risk.
- Search, notifications, a dedicated Prediction History / Performance /
  ROI dashboard, squad/lineup tactical modeling beyond a simple key-
  absence count — all explicitly out of scope for this engagement, named
  as Phase 2+ in the plan referenced in Section D. None of these are bugs;
  they're unbuilt features, and building any of them well is a
  multi-session effort in its own right, not something to rush inside an
  audit-and-fix engagement.

---

## Bottom line

Every concrete, fixable bug this audit found — twelve of them, listed in
Section B — was fixed, tested, and shipped to `main`, each independently
verified through the full lint/typecheck/test/build gate and a green CI
run (including two brand-new CI jobs added specifically to catch this
class of bug earlier next time). Of the two remaining production-blocking
gaps (Section L), both were resolved by the user directly the same day
this report was drafted: `model_versions` is seeded and `ML_SERVICE_URL`
is correctly pointed, confirmed live; only end-to-end confirmation that a
prediction run actually completes is still pending the next scheduled
firing or a manual trigger. What's left after that is exactly two kinds
of thing: work that requires credentials or dashboard access only the
project owner has (Section L's remaining items — genuinely blocked, not
skipped), and unbuilt features that were never bugs to begin with (the
"Deliberately deferred" list — real, named, and honestly out of scope for
an audit-and-fix engagement rather than a feature-build one).
