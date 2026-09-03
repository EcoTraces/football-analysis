# Changelog

## 2026-09-03 — AI Football Analyst & Accumulator Engine (Phase 1)

The user submitted a 38-section spec for a full quant-style prediction/
accumulator platform. A repo audit surfaced two real gaps that shaped
scope: this platform has no xG/xGA/shots/possession data anywhere (the
spec's largest-weighted ensemble component), and production has never run
live (scheduler off, no verified key, minimal real ingested history). Per
the user's own explicit choices (asked via `AskUserQuestion` before writing
any code), Phase 1 drops xG and redistributes its weight across the real
components, and is built now against the existing manual-sync/demo-data
capability rather than waiting on the scheduler/live key. See
`ML_Model.md`'s "Ensemble model" section for the full design and its
explicitly-named Phase 2+ deferrals (settling + P&L + a Performance
dashboard, live odds-movement/CLV, a second xG-capable provider, dedicated
Prediction History/Settings pages, turning the scheduler on).

- **Database** (`0009`–`0013`): `team_elo_ratings`; `competition_allowlist`
  (ships empty by design); `ensemble_config`/`screening_config`/
  `accumulator_targets` (the first genuinely admin-*edited*, not
  admin-computed, config in this schema); `ensemble_predictions` (a full
  prediction-history table, versioned like `predictions`); and
  `accumulator_recommendations`. Applied and smoke-tested against a local
  Postgres 16 instance with a stubbed `auth` schema.
- **ml-service**: `models/elo.py` (`/predict/elo` — Elo ratings with a
  Gaussian draw-probability carve-out) and `models/ensemble.py`
  (`/predict/ensemble` — weighted combination of whichever of six
  components are actually present, de-vigged market odds, an
  explicitly-unvalidated injuries nudge, consensus-level grading, EV/edge,
  the 0-100 selection score, and the 5-tier elite/strong/medium/high_risk/
  avoid risk classification). 36 new tests.
- **Backend**: `computeEloRatings.ts` (chronological Elo replay);
  `adminConfigService.ts` + new admin config routes;
  `generateEnsemblePredictions.ts` (gathers Elo/Poisson/Form/Home-Away/
  Injuries/Market per fixture, freshness-gates injuries, picks a single
  bookmaker's complete odds triple, never mixes prices across
  bookmakers); `screeningService.ts` + `GET /top20` / `GET
  /matches-to-avoid` / `GET /accumulators`; `buildAccumulators.ts` (greedy
  leg selection within the spec's own leg-count bands per target,
  same-team correlation penalty, a `usedFixtureIds` safeguard against
  double-booking a fixture, "best overall" flagged across all targets in
  one run). Three new scheduler stages, in dependency order:
  `compute_elo_ratings` → `predictions_ensemble` → `build_accumulators`.
- **Frontend**: `Top20.tsx`, `MatchesToAvoid.tsx`, `Accumulators.tsx`
  (three new sign-in-gated pages); `RiskTierBadge`; five new
  `AdminDashboard.tsx` config sections; `lib/bannedPhrases.ts` — extends
  the existing No Guarantee Policy phrase list with accumulator-specific
  hype terms, and every new page's rendered copy is scanned against it in
  its own test suite. All three empty states are honest, never a forced
  pick: "No high-confidence opportunities today," "Nothing flagged right
  now," and the spec's own explicit "No high-confidence accumulator
  today."
- A couple of real bugs caught by tests along the way: a
  `ZeroDivisionError` in `devig_market_probabilities` on degenerate
  `{0,0,0}` odds (now a proper `422`), and `selectAccumulatorLegs`
  originally trusting its caller to never pass two candidates for the same
  fixture rather than actually enforcing it — both fixed.
- Test counts: backend 292/292, frontend 81/81, ml-service 104/104.
  `tsc`/`eslint`/build clean across all three. Not exercised against real,
  non-synthetic match or odds history — every new fixed constant (Elo's
  `HOME_ADVANTAGE`, the accumulator's `TEAM_OVERLAP_PENALTY`, every
  default weight/threshold) is a documented placeholder, same "plausible,
  not fitted" honesty as this project's existing `RHO`/`CARDS_LINE`-style
  constants.

## 2026-08-29 — Favicon, /matches/:id test coverage, CI security-scanning gate

Three smaller, independent follow-ups after the redesign above.

- **Favicon**: `frontend/public/favicon.svg` — the same brand mark (green
  rounded square, pitch-line strokes) already used in the header, so the
  browser tab and the header are visually consistent instead of the tab
  showing Vite's default icon.
- **`/matches/:id` test coverage**: this route had zero direct tests
  (its logic lived entirely inline in the Express handler). Extracted
  into a new exported `getMatchDetail()` — same pattern `routes/me.ts`'s
  `getOrCreateProfile` already established — and added 5 tests covering
  the 404 path, team-name enrichment, the null-fallback when a team has
  no name, and that a superseded prediction is correctly excluded in
  favor of the current one. Along the way, `FakeSupabase` gained `.is()`
  support (it was missing entirely — `predictionsService.ts`'s
  `.is("superseded_at", null)` had apparently never been exercised
  against the fake before this).
- **CI security-scanning gate**: `npm audit --omit=dev` (backend,
  frontend) and `pip-audit -r requirements.txt` (ml-service), scoped to
  production dependencies only so dev-tooling advisories that never ship
  in a deployed build don't generate noise. Found and fixed two real,
  pre-existing production vulnerabilities in the process: `react-router-dom`
  (two moderate CVEs, fixed by bumping to `^7.18.3` — carefully, after an
  initial `npm audit fix --force` dragged `vite`/`vitest` along too and
  broke 9 tests, reverted and redone with only the one package pinned)
  and `fastapi`'s transitive `starlette` dependency (**9 known CVEs** on
  the version this actually-deployed service was running, fixed by
  bumping `fastapi` to `0.141.1`). Full detail in `Task.md`'s "Infra"
  section.
- Test counts: backend 225/225 (was 220), frontend 55/55 (unchanged
  count, but now passing against the patched `react-router-dom`),
  ml-service 68/68 (unchanged count, passing against the patched
  `fastapi`/`starlette`). `tsc`/`eslint`/`npm run build` clean across all
  three, plus a live smoke test of the running ml-service and a
  Playwright check that frontend routing still works post-upgrade.

## 2026-08-29 — UI/UX redesign of the 6 real frontend routes

Requested as a full platform redesign (dashboard, match cards, an
accumulator, team/league pages, search, filters, charts, a landing page).
Scoped down, with the requester's confirmation, to the 6 routes and APIs
that actually exist — the rest has no backend support (no `/teams/:id` or
`/leagues/:id`, no accumulator concept in the schema, no search endpoint),
and building UI for it would mean fabricating data or silently adding
scope, either of which this project's own rules rule out. See `Design.md`
for the full writeup.

- New shared primitives (`frontend/src/components/`): `Badge` (a single
  semantic `success|info|warning|danger|neutral` mapping, consolidating
  what used to be two separate copies of the same five colors in
  `FreshnessBadge` and `AdminDashboard`'s `StatusBadge`), `Skeleton`,
  `EmptyState`, `ErrorState` — every one of the 6 pages now has an
  explicit loading/empty/error(+retry) state.
- `tailwind.config.ts`: extended the existing `pitch` green (kept, not
  replaced) with `400`/`700`/`800` hover/active/pressed shades; added
  Inter (UI text, via a Google Fonts `<link>` in `index.html`) and
  JetBrains Mono (prediction percentages and other tabular figures).
- **Fixed real team names showing as raw UUIDs** — the single most
  "unfinished-looking" thing this redesign's own audit found.
  `fixturesService.ts` and `/matches/:id` never joined `teams`. New
  `backend/src/services/teamsService.ts` (`getTeamNamesById`, batched via
  `.in()`, same "fetch raw rows, join in JS" pattern this backend already
  uses everywhere `FakeSupabase` can't do a real join) adds
  `homeTeamName`/`awayTeamName: string | null` to both responses — `null`,
  never a fabricated name, when a team has none yet; the UI falls back to
  the id in that case.
- **Fixed the information-hierarchy problem**: `MatchDetail` rendered all
  ~20 prediction markets with equal visual weight. `PredictionCard`
  gained a `variant?: "primary" | "secondary"` prop (one reusable
  component) — 1x2 now renders large and prominent up front, everything
  else lives behind a native `<details>`/`<summary>` disclosure.
- **Fixed a real mobile overflow risk**: the header nav (Admin link +
  full email + Sign out + theme toggle, no wrap) could overflow on narrow
  phones. Now wraps, with the email truncated responsively.
- Small inline-SVG brand mark next to the wordmark; password show/hide
  toggle added to sign-in/sign-up.
- Verified with a live Playwright render of `/sign-in` at 390px/1280px,
  light and dark, confirming fonts load, the nav wraps correctly, and
  dark-mode contrast holds. The other real routes were verified through
  their test suites (10 new frontend tests, 6 new backend tests) rather
  than a live render, since they need a real signed-in session this
  environment has no credentials for.
- Test counts: backend 220/220 (was 218), frontend 55/55 (was 45),
  ml-service 68/68 (untouched — confirms no cross-service breakage).
  `tsc`/`eslint`/`npm run build` clean across all three services.

## 2026-08-28 — Per-competition Dixon-Coles rho fitting

Follow-up requested after the four original wishlist items landed. The
existing global rho fit answers "what's the single best rho across every
competition?" — this lets an admin fit rho scoped to just one
competition's own matches, storing it *alongside*, never overwriting, the
global fallback every other competition still relies on.

- `ml-service/app/schemas.py`: `PoissonPredictionRequest` gained an
  optional `rho` field — an explicit per-request override that
  `_effective_rho()` checks before its existing global-fit-or-default
  chain. `DixonColesRhoFitRequest` gained `apply_globally: bool = True`;
  `fit_dixon_coles_rho()` only mutates the process-local `_fitted_rho`
  when it's `True`, so a competition-scoped fit computes the identical MLE
  without ever touching the global fallback.
- New migration `0008_competition_rho.sql`: `competition_rho`, shaped like
  `model_evaluations` (`model_version_id` + `competition_id` +
  `evaluation_window` + fit diagnostics), not like `league_calibration`'s
  plain-average shape — a rho fit is a model-calibration record tied to a
  specific model version, not a model-agnostic observational stat.
- `backend/src/jobs/fitDixonColesRho.ts`'s `runLatestDixonColesRhoFitJob()`
  now branches on `competitionId`: omitted → unchanged global-fit
  behavior (updates `poisson-baseline`'s `model_versions` row,
  `applyGlobally: true`); present → builds rows from just that
  competition's matches, calls ml-service with `applyGlobally: false`, and
  upserts `competition_rho` (`unique(model_version_id, competition_id)`)
  instead of touching `model_versions`. `ingestion_runs.job_name`
  distinguishes the two paths.
- `getCompetitionRho()` deliberately lives in `calibrateLeagues.ts`, not
  `fitDixonColesRho.ts`, to avoid a circular import back into
  `generatePredictions.ts` — same relocation pattern
  `LEAGUE_AVG_HOME_GOALS`/`AWAY_GOALS` used for the identical reason in
  the league-calibration task. `generatePredictionsForUpcomingFixtures`
  now resolves each fixture's rho as: this competition's own fit, if any
  → the global fit, if one has ever run → the fixed `-0.1` default —
  forwarding `undefined` (never a resolved fallback value) when a
  competition has no fit of its own, so ml-service's own chain resolves
  it.
- `POST /admin/model/poisson/fit-rho` keeps its existing signature
  (`competitionId` was already an optional query param) but its response
  now includes `competitionId` (`null` for a global fit, the id for a
  scoped one). New route `GET /admin/model/poisson/competition-rho`
  (same list-and-join-competition-name pattern as
  `/admin/league-calibration/results`). New `AdminDashboard.tsx`
  controls: a "Competition ID (optional)" text field (the fit button's
  label switches between "...(global)" and "...(this competition)"), and
  a "Per-competition rho fits" results table.
- **Deliberately NOT wired into backtesting/training**, for the identical
  lookahead-bias reason league-specific calibration's own gap states:
  those pipelines already do a genuine point-in-time walk-forward, and
  reading `competition_rho`'s *current* value for a historical fixture
  would leak future knowledge into a "historical" evaluation.
- Test counts: ml-service 68/68 (was 66), backend 218/218 (was 212),
  frontend 45/45 (was 42). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Like every real-data-dependent pipeline in this project, never run
  against real data.** No live API-Football key has ever been connected
  in this environment, and a per-competition sample is necessarily
  smaller than the global one — harder to clear
  `MIN_INFORMATIVE_MATCHES`, not easier — so `competition_rho` stays
  empty in practice and every live prediction still falls back to the
  (itself never actually fit) global rho or the fixed default. See
  `ML_Model.md`'s new "Per-competition rho" section.

## 2026-08-28 — League-specific calibration (real per-competition goal averages)

Fourth and final item off the original model wishlist in Task.md. The
fixed `LEAGUE_AVG_HOME_GOALS = 1.5` / `LEAGUE_AVG_AWAY_GOALS = 1.1`
constants were used for every fixture regardless of league — directly the
"no league-specific home-advantage effect is modeled" gap ML_Model.md's
known limitations already called out, since those two inputs are where a
league's scoring rate and home advantage enter `expected_goals()`.

- New migration `0007_league_calibration.sql`: one row per competition.
- `backend/src/jobs/calibrateLeagues.ts`: `runLeagueCalibration()` fetches
  every real, finished fixture's `(competition_id, home_score,
  away_score)` in one pass and groups by competition in application code
  — same "fetch raw rows, aggregate in JS" style
  `computePointInTimeStrength()`/`refreshTeamCornersAverage()` already
  use (`FakeSupabase` has no database-side aggregation support). A
  competition needs `MIN_FIXTURES_FOR_LEAGUE_CALIBRATION` (20) real
  fixtures before it gets a row; `getLeagueAverages()` — the new read path
  live predictions go through — falls back to the fixed cross-league
  default below that.
- **Wired into live predictions, deliberately not into
  backtesting/training/rho-fitting.** Those three already do a genuine
  point-in-time walk-forward for team strength; reading
  `league_calibration`'s *current* value for a historical fixture would
  reintroduce a lookahead-bias risk of the same kind that motivated that
  point-in-time computation (smaller in magnitude — a whole competition's
  average drifts far more slowly than one team's form — but real). A
  genuinely point-in-time per-competition average is a stated,
  unimplemented follow-up, not glossed over.
- **Runs daily on the scheduler**, unlike backtesting/training/rho-fitting
  — this job is DB-only (no ml-service call, no admin-chosen date range),
  cheap enough to treat like a regular sync job rather than gating it
  behind an admin's explicit trigger. A manual-trigger admin route still
  exists for an out-of-cycle recalibration.
- New admin routes: `POST /admin/league-calibration/run`,
  `GET /admin/league-calibration/results`. New `AdminDashboard.tsx`
  "League calibration" panel.
- Test counts: backend 212/212 (was 202), frontend 42/42 (was 39).
  ml-service untouched — this is a plain average, not a model fit, so no
  math needed there. `tsc`/`eslint`/`npm run build` clean across the
  touched services.
- **Like every real-data-dependent pipeline in this project, never run
  against real data.** No live API-Football key has ever been connected
  in this environment, so no competition has anywhere near 20 real
  fixtures — every live prediction still uses the fixed cross-league
  default in practice, and `league_calibration` stays empty. See
  `ML_Model.md`'s "League-specific calibration" section.

## 2026-08-28 — Fit the Dixon-Coles rho parameter from real data

Third wishlist item off Task.md: `RHO` (the Dixon-Coles low-score
correlation parameter) has been a fixed `-0.1` approximation since the
Poisson model's first commit. `ml-service/app/models/rho_fitting.py`
fits it by maximum likelihood instead.

- **Why only four scorelines matter**: `dixon_coles_tau(x, y, lam, mu,
  rho)` is exactly `1.0` — no `rho` dependence at all — for every
  scoreline except `(0,0)`, `(0,1)`, `(1,0)`, `(1,1)`. That's the entire
  Dixon-Coles adjustment, by construction. Only matches finishing one of
  those four scorelines carry any information about `rho`; `fit_rho()`
  refuses (`422`) below `MIN_INFORMATIVE_MATCHES` (30) of those
  specifically, not below some raw row count.
- **The fit**: maximizing the log-likelihood over `rho` reduces to
  maximizing `sum(log(tau_i(rho)))` (the independent-Poisson terms don't
  depend on `rho`), via `scipy.optimize.minimize_scalar`, bounded to
  whatever range keeps every informative match's `tau` strictly positive —
  derived directly from `tau`'s own formulas, not guessed.
- **Tested against a genuine parameter-recovery case**: synthetic
  scorelines sampled from `poisson.py`'s own `score_matrix()` at a known
  `true_rho`, and `fit_rho()` is asserted to recover it within 0.03 — the
  strongest test in this codebase that an optimization actually works, not
  merely that it runs without error.
- New ml-service endpoints: `POST /fit/dixon_coles_rho`,
  `GET /rho_status`.
- `backend/src/jobs/fitDixonColesRho.ts` reuses the identical
  `computePointInTimeStrength()` walk-forward computation
  training/backtesting already use (same lookahead-bias avoidance as
  those), but each row carries the *exact final score*, not gradient
  boosting's win/draw/loss label — rho fitting is sensitive to the precise
  scoreline.
- Like gradient boosting's trained model, `main.py` keeps the fitted rho
  as process-local, in-memory state, used by every `/predict/poisson` call
  after a successful fit. That means a fit takes effect for **every market
  derived from the full-match score matrix** — 1x2, correct score, BTTS,
  over/under, double chance, clean sheet, odd/even, draw no bet, the two
  joint markets, and the handicap market — not just 1x2. The half-based
  markets are the one exception: they deliberately use `rho=0` regardless.
- On success, updates `poisson-baseline`'s **existing** `model_versions`
  row (`trained_at`/`training_dataset_version`/`notes`) — this refines
  that model, it doesn't create a new one, unlike gradient boosting's
  separate row.
- New admin routes: `POST
  /admin/model/poisson/fit-rho?from=&to=&competitionId=` and
  `GET /admin/model/poisson/rho-status`. The admin dashboard's "Backtest &
  models" panel shows the currently-effective rho and a "Fit Dixon-Coles
  rho" button — never on the scheduler, same as backtesting/training.
- Test counts: ml-service 66/66 (was 59), backend 202/202 (was 194),
  frontend 39/39 (was 35). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Like everything else on this list, never run against real data.** No
  live API-Football key exists in this environment, so there's no real
  fixture history with enough 0-0/1-0/0-1/1-1 results to fit against —
  `poisson-baseline`'s `model_versions` row stays at its dev-seeded,
  unfit state in practice. See `ML_Model.md`'s "Rho fitting" section.

## 2026-08-28 — Second model: gradient boosting (1x2 market) + baseline comparison

First item off the model wishlist in Task.md: "add at least one additional
model... and compare against the Poisson baseline before calling anything
an ensemble." Both halves — the model and the comparison mechanism — land
together.

- `ml-service/app/models/gradient_boosting.py`: `GradientBoostingOneXTwoModel`
  wraps sklearn's `GradientBoostingClassifier`, scoped to the `1x2` market
  only (same discipline as backtesting — not ported to all ~20 markets
  before this one is proven out). Refuses to train on fewer than
  `MIN_TRAINING_ROWS` (20) rows or a single-outcome dataset. Unlike
  `poisson.py`, this model has no closed-form fallback — `predict()` raises
  `NotTrainedError` before training rather than fabricating a 1/3-1/3-1/3
  guess; the ml-service endpoint maps that to `409`, and
  `PredictionClient.predictGradientBoosting()` maps `409` to `null`, the
  same "unavailable, never fabricated" contract `predictPoisson()` already
  has. State is process-local, in-memory only — a restart loses whatever
  was trained; a real persistence layer is documented as out of scope, not
  silently assumed.
- New ml-service endpoints: `POST /train/gradient_boosting`,
  `POST /predict/gradient_boosting`.
- `backend/src/jobs/trainGradientBoosting.ts`: builds training rows from
  real, finished, non-synthetic fixtures the same way `runBacktest.ts`
  builds backtest fixtures — reusing `computePointInTimeStrength()` so a
  team's future results never leak into its own historical training row
  (the identical lookahead-bias concern that motivated backtesting).
  Updates the `gradient-boosting` `model_versions` row's
  `trained_at`/`training_dataset_version`/`notes` on success.
- **The comparison mechanism**: `runBacktest.ts` was generalized to accept
  a `predictFn` instead of hardcoding `predictPoisson()` — it never knows
  or cares which model it's scoring. `runLatestBacktestJob()` now takes a
  `modelName` (`poisson-baseline` default, or `gradient-boosting`), so
  running a backtest over the same date range once per model produces two
  directly comparable `model_evaluations` rows.
- New admin routes: `POST /admin/backtest/run` gained a `model` query
  param; new `POST /admin/model/gradient-boosting/train?from=&to=&competitionId=`;
  `GET /admin/backtest/results` now enriches each row with its model name.
- New `AdminDashboard.tsx` controls: a model selector next to the existing
  backtest date range, and a "Train gradient boosting" button showing
  in-sample accuracy — explicitly labeled as not a held-out/generalization
  metric, with a pointer to backtesting for that.
- `gradient-boosting` got a `model_versions` row in the dev seed (same
  manual-bootstrap pattern as `poisson-baseline`'s — there's still no
  admin route that inserts these), deliberately left untrained
  (`trained_at = null`): the 4 synthetic dev fixtures are nowhere near
  `MIN_TRAINING_ROWS`, and synthetic data must never be used to fabricate
  a "trained" model.
- Test counts: ml-service 59/59 (was 49), backend 194/194 (was 184),
  frontend 35/35 (was 32). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Like backtesting, this has never been run against real data.** No live
  API-Football key has ever been connected in this environment, so there's
  no real fixture history to train the model on — it stays untrained until
  someone does. No `factors` explanation either, unlike Poisson's
  `explain_factors()` — there's no honest plain-language story for what a
  gradient-boosted ensemble weighted; that's real future work, not an
  oversight. See `ML_Model.md`'s "Gradient boosting model" section.

## 2026-08-28 — Backtesting pipeline (walk-forward, 1x2 market)

`model_evaluations` has had a schema since the very first migration and no
writer until now. `backend/src/jobs/runBacktest.ts` adds one, scoped
deliberately to the `1x2` market only.

- The core design problem this pipeline exists to solve: `team_statistics`
  is a single current snapshot, not a time series, so predicting a
  historical fixture from it would leak future-season data into that
  "historical" prediction (lookahead bias) and make the backtest lie about
  how good the model actually is. Solved with `computePointInTimeStrength()`
  — recomputes a team's strength directly from `fixtures`' own finished,
  non-synthetic match history strictly **before** the fixture being
  backtested, never from `team_statistics`.
- For each qualifying fixture in an admin-chosen `[from, to]` range (same
  `MIN_MATCHES_FOR_PREDICTION = 3` gate as live predictions, now exported
  from `generatePredictions.ts`), calls the real
  `PredictionClient.predictPoisson()` — the live-prediction code path, not
  a shortcut — and scores the `1x2` result against what actually happened:
  accuracy (argmax match), log loss (clamped away from probability 0),
  and Brier score (standard multi-class form, summed over the three
  outcomes per fixture, averaged over fixtures). Writes one
  `model_evaluations` row per run.
- `runLatestBacktestJob()` gets the same `ingestion_runs` bookkeeping every
  sync job has, but is **deliberately not on the scheduler** — this is an
  occasional, admin-triggered evaluation over a chosen window, not ongoing
  ingestion.
- New admin routes: `POST /admin/backtest/run?from=&to=&competitionId=`
  (rate limited, 366-day range cap) and `GET /admin/backtest/results`.
- New `AdminDashboard.tsx` panel: from/to date pickers, a "Run backtest"
  button, and a results table — so this is never a curl-only capability.
- `testSupabaseFake.ts` gained `.lt()` (strict less-than), needed for the
  point-in-time query — a fixture at exactly the target's kickoff isn't
  "prior" data either, so `.lte()` would have been wrong here.
- Test counts: backend 184/184 (was 179) — most importantly, a direct test
  proving `computePointInTimeStrength()` excludes a fixture at or after the
  target kickoff, and a test proving the accuracy/log-loss/Brier-score math
  against known synthetic predictions; frontend 32/32 (was 29). ml-service
  untouched (no changes needed — this is entirely a backend job reusing the
  existing `/predict/poisson` endpoint). `tsc`/`eslint`/`npm run build`
  clean on both.
- **The pipeline is real and tested against synthetic/fake data, but has
  never been run against real historical results.** No live API-Football
  key has ever been connected in this environment, so there is no real
  fixture history to backtest against — `model_evaluations` remains empty
  in practice. See `ML_Model.md`'s "Backtesting" section.

## 2026-08-28 — 8 more markets: clean sheet, odd/even, DNB, team totals, two joint markets, handicap, win-a-half

Requested by name, all in one round. Unlike the last three entries, every
one of these needed **zero new data** — pure functions of the same
full-match matrix / half matrices / `lambda_home`/`lambda_away` every
other market already computes. Backend needed no changes at all this
time; confirmed by re-running its suite unmodified.

- `home_clean_sheet`/`away_clean_sheet`: were already computed as
  intermediate values inside `poisson.py::market_probabilities()`
  (`p_home_0`/`p_away_0`) and just weren't exposed as their own market.
- `odd_even_goals`: parity of `i + j` summed across the matrix.
- `draw_no_bet`: `home_win`/`away_win` renormalized over the non-draw
  outcomes only — "what 1X2 would be if the draw didn't exist."
- `home_team_total_goals`/`away_team_total_goals` (line 1.5): reuses
  `count_markets.total_over_under()` directly, but against a single
  side's own lambda rather than the summed rate cards/corners use.
- `btts_and_result` and `result_and_total_goals`: two new **genuinely
  joint** functions (`btts_and_result_probabilities`,
  `result_and_total_goals_probabilities`), 6 selections each, summing
  matrix cells directly rather than multiplying two markets' marginals —
  BTTS and match result are correlated through the same scoreline (a 1-0
  home win can never be BTTS=yes). Tests assert the joint reduces to the
  right marginal when summed over one axis.
- `handicap` (home -1.5): a new `handicap_probabilities()`, using a
  half-integer line deliberately so there's no push/tie case — clean
  2-way split like every O/U-style market here.
- `home_wins_a_half`/`away_wins_a_half`: new
  `half_markets.wins_at_least_one_half_probabilities()`. Same shape as
  anytime-goalscorer — independent per-side probabilities that do **not**
  sum to 1, since both teams can win a half in the same match (home takes
  the first, away the second). `P(wins >= 1) = 1 - P(wins neither)`,
  reusing the half-independence assumption `half_with_most_goals` already
  relies on.
- Frontend: 11 more `PredictionCard`s in `MatchDetail.tsx`; label maps
  extended for all 8, including spelled-out combo labels for the two
  joint markets ("BTTS & home win", "Home win & over 2.5", etc.) so their
  selection keys (`yes_home`, `home_over`, ...) never leak into the UI.
- Test counts: ml-service 49/49 (was 39), frontend 29/29 (was 26), backend
  unchanged at 179/179. `tsc`/`eslint`/`npm run build` clean.
- **Not calibrated, backtested, or verified against a live API-Football
  key** — `TEAM_TOTAL_GOALS_LINE = 1.5` and `HANDICAP_HOME_LINE = -1.5`
  are chosen for plausibility, not fitted to this platform's own data,
  same category of simplification as every other fixed line in this
  project (`over_under_2_5`, `CARDS_LINE`, `CORNERS_LINE`).

## 2026-08-28 — Anytime goalscorer markets

Closes out the market wishlist from the last three entries — this is the
last one, and by far the biggest: it needed a whole new data pipeline this
schema never had at all (no goals-per-player anywhere), and the market
itself is a genuinely different shape from every other one built so far.

- **New data pipeline.** `player_statistics` table (migration 0006 —
  `player_id, team_id, season_id`, a denormalized `player_name` to avoid
  needing a relational-embed `select` the shared `FakeSupabase` test double
  can't do, `matches_played`, `goals_scored`, `minutes_played`).
  `PlayerStatsProvider`/`ApiFootballProvider.getPlayerStatistics`
  (api-football's `/players` endpoint, team/competition/season-scoped —
  **single page only**, documented, not fixed, since the market only ever
  surfaces a team's top 6 scorers anyway). `mapPlayerStatistics` picks the
  stint matching the requested competition when a player has multiple
  (e.g. league + cup for the same team). `syncPlayerStatistics.ts` mirrors
  `syncTeamStatistics.ts`'s combination-dedup shape exactly, reusing
  `upsertPlayer` from the lineups job. Wired into
  `POST /admin/player-statistics/sync` and the scheduler (daily, right
  after team-statistics). `GET /health/data` gained a `playerStatistics`
  freshness domain.
- **The model** (`ml-service/app/models/player_market.py`) is not a
  derivation of anything else in this service:
  - Selections are **not mutually exclusive** — "will player X score" and
    "will player Y score" are independent events, so a market's rows don't
    sum to 1 the way every other market's does. Tests deliberately don't
    assert that they do.
  - **Not lineup-gated**, stated as a real, deliberate simplification: it
    ranks a team's own historical top scorers (`top_scorers()`: ≥3
    appearances, ≥1 goal, top 6 by season goals) and assumes each is as
    likely to play as their record suggests, rather than checking who's
    actually selected for the specific fixture. This platform already has
    `lineups` data close to kickoff, so a more accurate version is
    possible — not built here, since gating on confirmed lineups would
    mean the market doesn't exist until shortly before kickoff, unlike
    every other prediction (available days out). See `ML_Model.md`.
  - The probability itself: a player's own share of their team's season
    goals scales the team's match-level expected-goals rate down to a
    player-level Poisson rate (`P(scores) = 1 - e^-lambda`).
  - Two separate markets, `home_anytime_goalscorer`/`away_anytime_goalscorer`
    — `predictions` has no team-side column, and mixing both squads' names
    into one flat list would be ambiguous about whose player is whose.
  - Per-side optional gating (unlike cards/corners' per-pair gating):
    `generatePredictions.ts` sends `undefined`, not `[]`, when nothing's
    been synced for that team's season yet.
- Backend/DB needed no new schema for the predictions themselves (same
  free-text `market`/`selection` columns as every other market) — all new
  schema surface is for the underlying player data.
- Frontend: two more `PredictionCard`s. Player names render as-is rather
  than through the usual CSS-capitalize styling — capitalize would mangle
  a real name like "de Bruyne" into "De Bruyne".
- Test counts: backend 179/179 (was 166), ml-service 39/39 (was 28),
  frontend 26/26 (was 24). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Not calibrated, backtested, or verified against a live API-Football
  key** — more open assumptions here than any other market built this
  session: the historical-share-based probability model itself, the
  not-lineup-gated simplification, the single-page `/players` pagination
  gap, and the usual unverified-vendor-response-shape caveat that applies
  to every mapping in this project.

## 2026-08-28 — First-half/second-half result and half-with-most-goals markets

Third round of market build-out. Unlike cards/corners, these don't need any
new data ingestion for the *predictions* themselves — they're computed from
the same `lambda_home`/`lambda_away` every other goals-based market already
uses. Did pick up one real data-completeness fix along the way, though.

- `ml-service/app/models/half_markets.py` (new file): reuses
  `poisson.py::score_matrix()` for each half separately — full-match
  lambdas are split by a fixed `FIRST_HALF_FRACTION = 0.45` (the
  well-documented tendency for more goals in the second half, chosen for
  plausibility, not fitted to this platform's own data — same category as
  `RHO` and the count-markets' fixed lines), and each half's matrix uses
  `rho=0` rather than the full match's `RHO` — deliberately not reusing a
  constant calibrated (loosely) for full matches on a 45-minute segment
  with zero evidence either way.
- `first_half_result`/`second_half_result`: plain home/draw/away from each
  half's own matrix. `half_with_most_goals`
  (`first_half`/`second_half`/`equal`): compares each half's total-goals
  marginal distribution — exact under the model's own independence
  assumption between halves, no joint scoreline computation needed.
- All three are always computed (no optional-data gate like cards/corners)
  and wired into `/predict/poisson` alongside the existing markets.
- **Data-completeness fix, not required for the markets above but same area
  of code:** `fixtures.home_score_ht`/`away_score_ht` have existed in the
  schema since the very first migration and were never once written by any
  sync job. `ProviderFixture` gained `homeScoreHt`/`awayScoreHt`,
  `ApiFootballProvider.ts::mapFixture` now parses the vendor's
  `score.halftime` object, and `syncFixtures.ts` writes both columns on
  every insert/update. This doesn't feed the model (which has no
  backtesting pipeline to consume it yet) — it just means there's now a
  real data source to eventually check `first_half_result`/
  `half_with_most_goals` predictions against, which there wasn't before.
- Frontend: `MatchDetail.tsx` renders three more `PredictionCard`s;
  `PredictionCard.tsx`'s label maps got all three markets plus the
  `first_half`/`second_half` selection labels.
- Test counts: backend 166/166 (was 165), ml-service 28/28 (was 21),
  frontend 24/24 (was 22). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Not calibrated or backtested against anything.** `FIRST_HALF_FRACTION`
  and the choice of `rho=0` are both reasoned defaults, not measured
  results — see `ML_Model.md` for the full caveat. Also not verified
  against a live API-Football key, same as everything else in this project
  — in particular, the vendor's exact `score.halftime` response shape is
  unconfirmed.
- **What's left from the original market wishlist:** only "player to
  score" (anytime goalscorer), which is a substantially bigger build than
  anything done in this round or the two before it — there is currently no
  player-level scoring data anywhere in this schema at all. Scoped as its
  own item in `Task.md` rather than started here.

## 2026-08-28 — Corners and cards (bookings) prediction markets

Continues down the market wishlist from the double-chance/correct-score
entry below — corners and cards this time. Unlike those two, neither is
derivable from the existing Poisson goals model, and the two turned out to
be very differently sized pieces of work.

- **Cards (`total_cards`), the cheap one:** api-football's
  `/teams/statistics` response — already fetched by `syncTeamStatistics.ts`
  — includes a `cards.yellow`/`cards.red` breakdown by minute interval that
  nothing had ever parsed. `ApiFootballProvider.ts::mapTeamStatistics` now
  sums it into a season total (`ProviderTeamStatistics.yellowCards`/
  `redCards`); `team_statistics` gained matching columns (migration 0005,
  `overall` scope only — the vendor doesn't split cards by home/away like
  it does goals). No new provider call, no new sync job.
- **Corners (`total_corners`), the real build:** api-football simply
  doesn't expose corners in `/teams/statistics` at any level — the only
  source is `/fixtures/statistics`, per finished fixture. Added: a new
  `fixture_statistics` table (migration 0005); `FixtureStatisticsProvider`/
  `ApiFootballProvider.getFixtureStatistics`, mapping only `"Corner Kicks"`
  out of the vendor's much larger per-fixture stat list (same "map only
  what's used" policy as odds); a new `syncFixtureStatistics.ts` job
  (windowed to the last 72h of finished fixtures, like lineups/odds are
  windowed around kickoff, to bound provider-call growth) wired into the
  scheduler (daily, right before predictions) and
  `POST /admin/fixture-statistics/sync?hours=N`; and an aggregation step,
  `refreshTeamCornersAverage`, that averages a team's per-fixture corners
  into `team_statistics.corners` (present in the schema since day one,
  unpopulated until now) via a column-scoped upsert that can't clobber the
  goals/cards fields the team-statistics job writes to the same row.
- `ml-service/app/models/count_markets.py` (new file, not an extension of
  `poisson.py`): both markets are modeled the same simple way — each side's
  own average (cards or corners per match) summed into one combined rate,
  treated as a single Poisson variable against a fixed line (3.5 cards, 9.5
  corners). Deliberately simpler than the goals model — there's no
  attack-vs-opposing-defense relationship this platform has data to support
  for cards/corners the way there is for goals. `/predict/poisson` only
  includes either market when **both** teams' averages are present in the
  request; `generatePredictions.ts` sends `undefined`, never `0`, when a
  team's `team_statistics` row doesn't have the field yet — so
  `total_corners` will be silently absent from every fixture's predictions
  until `syncFixtureStatistics.ts` has actually run.
- Backend/DB layer needed no schema change for the *predictions* themselves
  (same free-text `market`/`selection` columns as every other market) — all
  the new schema surface here is for the underlying cards/corners *data*,
  not the predictions built from it.
- `GET /health/data` gained a `fixtureStatistics` freshness domain (same
  once-daily-cadence policy as `teamStatistics`), so corners data shows up
  in the admin dashboard's freshness view like everything else.
- Frontend: `MatchDetail.tsx` renders two more `PredictionCard`s (both
  render nothing when a fixture has no such prediction yet, same as any
  other market); `PredictionCard.tsx`'s market-label map got both.
- Fixed two real gaps in the shared `FakeSupabase` test double that nothing
  had exercised until this work needed them:
  `.insert()` only ever handled a single row, never an array
  (`generatePredictions.ts` inserts one row per market in a single call —
  this had apparently never been unit-tested before; see below);
  `.update()` executed as soon as the first `.eq()` was chained instead of
  accumulating a full filter chain, breaking
  `generatePredictions.ts`'s `.eq("fixture_id", …).is("superseded_at",
  null)`. Both are now deferred/thenable builders, matching `select()`'s
  existing pattern.
- Added the first-ever direct test coverage for `generatePredictions.ts`
  (`generatePredictions.test.ts`, 2 tests) as a natural consequence of
  wiring the new fields through it and hitting the `FakeSupabase` gaps
  above — it had only ever been exercised indirectly, and only along an
  empty-fixtures path, via `scheduler.test.ts`.
- Test counts: backend 165/165 (was 145), ml-service 21/21 (was 15),
  frontend 22/22 (was 20). `tsc`/`eslint`/`npm run build` clean across all
  three.
- **Not yet verified against a live Supabase or API-Football setup** — same
  caveat as everything else in this project. Specifically unverified:
  whether `"Corner Kicks"` is actually the vendor's exact `type` string in
  `/fixtures/statistics` (if it's wrong, `mapFixtureStatistics` silently
  returns `corners: null` for every fixture rather than erroring — easy to
  miss without checking a real response), and the 3.5/9.5 lines are chosen
  for plausibility, not fitted to any real data.

## 2026-08-28 — Double chance and correct score prediction markets

Adds two of the markets requested for the prediction engine (out of a
longer wishlist — corners, bookings, half-time/full-time, player-to-score,
etc. remain unbuilt; see `Task.md` → "Frontend"/"Model" for the full gap
list). Chose these two first because both are derivable from the Poisson
model's existing score matrix — no new data source, model, or DB schema
change required.

- `ml-service/app/models/poisson.py`: `market_probabilities()` now also
  returns `home_or_draw`/`home_or_away`/`draw_or_away` (each the sum of the
  two 1X2 outcomes it covers). New `top_correct_scores(matrix, n=10)`
  returns the n most probable exact scorelines, sorted descending.
- `ml-service/app/main.py`: `/predict/poisson` now includes `double_chance`
  (3 selections) and `correct_score` (top 10 scorelines + one `"other"`
  selection covering the remaining probability mass, so the market's
  probabilities still sum to 1). 5 new tests across `test_poisson.py`/
  `test_api.py`; ml-service suite now 15/15 (was 10/10).
- Backend needed **no changes** — `predictions.market`/`selection` are
  free-text columns with no CHECK constraint, and
  `generatePredictionsForUpcomingFixtures` already writes whatever markets
  the ml-service response contains. This was true before today but is
  worth stating plainly: the pipeline was already market-agnostic by
  design.
- Frontend: `MatchDetail.tsx` renders two more `PredictionCard`s.
  `PredictionCard.tsx` gained a selection-label map (`home_or_draw` →
  "Home or draw (1X)", `other` → "Other scoreline", correct-score
  scorelines like `2-1` render as-is) and now sorts each card's rows by
  probability descending, with `"other"` always pinned last regardless of
  its own probability (it's a catch-all bucket, not a specific outcome, so
  ranking it by probability would be misleading). 3 new tests; frontend
  suite now 20/20 (was 17/17).
- Documented in `ML_Model.md` that both are *derived*, not independently
  modeled — same `RHO`/league-agnostic caveats as the original three
  markets apply, and correct_score explicitly cannot represent a scoreline
  outside its top 10 as anything other than `"other"`.
- Updated `API.md`/`Data_Sources.md`/`README.md`, which previously said (now
  incorrectly) that odds ingestion covers "the markets the prediction
  engine produces" — that was true when there were only three; it no
  longer is. Odds ingestion (`syncOdds.ts`/`ApiFootballProvider.mapOdds`)
  still only covers `1x2`/`btts`/`over_under_2_5`; extending it to these
  two new markets is now tracked as its own item in `Task.md`.
- Verified: `pytest` (ml-service) and `vitest`/`tsc`/`eslint`/`npm run
  build` (frontend) all clean. **Not verified against a live Supabase or
  API-Football setup** — same caveat as everything else in this project;
  only the ml-service's own math and the frontend's rendering of
  hand-constructed fixture data have actually been exercised.

## 2026-08-28 — Manual security review + fixes

The `/security-review` automated skill could not be run in this environment
— its git-diff hook is fixed to a different, unrelated repository's working
directory and this could not be redirected from within the session — so
this was a manual read-through of the changes made since the last review,
using `grep`/direct file reads and the same rigor, reported via the same
findings format. No critical or high-severity issues found. 3 fixed:

- Added a stricter per-route rate limiter (`syncTriggerLimit` in
  `backend/src/routes/admin.ts`: 10 requests / 15 minutes, keyed by
  authenticated user id) to all 7 admin routes that call a third-party API
  or run predictions (`/admin/sync`, `/admin/team-statistics/sync`,
  `/admin/injuries/sync`, `/admin/standings/sync`, `/admin/lineups/sync`,
  `/admin/odds/sync`, `/admin/predictions/run`) — previously only the
  app-wide global rate limit covered these, so a compromised or careless
  admin token could burn the API-Football quota by hammering them.
  `/admin/users/:id/role` deliberately left at just the global limit — it
  doesn't call a third-party API.
- `backend/src/routes/me.ts` now applies `createRequireAuth` via
  `router.use()` instead of inline on its single route, matching every
  other router in this codebase. Not exploitable today (there was only one
  route), but a future second route could otherwise ship unauthenticated
  without the pattern making that obvious.
- `backend/src/services/fixturesService.ts`'s `teamId` filter added a
  defensive UUID-format check before building the raw PostgREST `.or()`
  filter string it passes to supabase-js. `.eq()` calls are always safely
  parameterized regardless of value, but `.or()` takes a raw string —
  interpolating an unvalidated `teamId` into it could inject additional OR
  conditions via commas/dots/operators in the value. The only current
  caller (`GET /fixtures`) already validates `teamId` as a UUID with zod,
  but `fixturesService.ts` couldn't see or rely on that from its own
  function boundary, so it checks again itself. Added first-ever test
  coverage for this file (`fixturesService.test.ts`, 4 tests, including one
  asserting a filter-syntax `teamId` throws instead of being accepted),
  which required adding `.or()` support to the shared `FakeSupabase` test
  double.
- Verified: `tsc --noEmit`, `eslint src`, and `npm run build` all clean;
  full backend test suite passes, 145/145 across 19 files (up from
  141/18). **Not a substitute for a real automated or third-party security
  audit** — this was one person(+AI) reading the diff, not a tool-driven
  scan or a professional pen test.

## 2026-08-27 — Render deployment config for the backend

- Added `render.yaml` (Render Blueprint spec, repo root): a Docker web
  service built from the existing `backend/Dockerfile`, `PORT` left for
  Render to inject (the app already reads `process.env.PORT` with a sane
  default, no code change needed), `healthCheckPath: /api/health`, and
  every secret (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `FOOTBALL_DATA_API_KEY`, `ML_SERVICE_URL`, `ALLOWED_ORIGINS`) marked
  `sync: false` so Render prompts for them at Blueprint-creation time
  instead of them ever being written into this committed file.
- Added `backend/.dockerignore` (didn't exist before) — excludes
  `node_modules`, `dist`, and any `.env*` file, so a local `docker build`
  can never accidentally bake a real credential into an image layer.
- Rewrote `Deployment.md`'s backend section with the actual click-through
  steps for Render specifically (Blueprint creation, which env vars need
  filling in vs. which are safe to leave at their default, how to verify
  the deploy with `curl .../api/health`, and the free-tier
  spin-down-on-idle caveat interacting with `SCHEDULER_ENABLED=true`).
  Also fixed a stale line in the same file that still said "no auth exists
  on `/api/admin/*` yet" — auth has existed since earlier this week; the
  accurate caveat is "unverified against a real Supabase project," not
  "absent."
- **Not done, and cannot be done from here**: no Render account is
  connected to this environment, so nothing has actually been deployed —
  this is configuration only. The user connects their own GitHub repo to
  Render and clicks deploy themselves (entirely from a browser, phone or
  computer — see `Deployment.md`).

## 2026-08-27 — Admin sync/jobs dashboard

Closes the last "deliberately deferred" item from `Architecture.md`: the
observability/job-history/health endpoints built earlier this week
(`GET /health/*`, `GET /admin/jobs*`) had no frontend at all — every admin
action was curl-only. Now `/admin` is a real dashboard.

- New `/admin` page: provider connectivity (`GET /health/api-football`,
  including rate-limit remaining), scheduler status and each job's next
  run time (`GET /health/scheduler`), database reachability and per-dataset
  freshness badges reusing the existing `FreshnessBadge` component
  (`GET /health/data`), a job summary (last run / last succeeded per job,
  `GET /admin/jobs/summary`), a scrollable recent-runs table
  (`GET /admin/jobs`), and manual trigger buttons for all seven jobs
  (fixtures/team-statistics/injuries/standings/lineups/odds/predictions),
  each showing its own success result or error message inline and
  refreshing the job tables afterward.
- Restructured `/admin` routing into a shared `AdminLayout` (a Dashboard/
  Users sub-nav under one `<RequireAdmin>`) instead of gating `/admin/users`
  on its own — adding a second admin page no longer means repeating the
  route guard.
- Each dashboard section loads and fails independently (`Promise.all` over
  per-section try/catch, not one big call) — a database outage doesn't
  blank the scheduler/provider cards, and vice versa, matching this app's
  existing "explicit unavailable state per section" convention rather than
  an all-or-nothing loading screen.
- 4 new tests (`AdminDashboard.test.tsx`): loading state, successful render
  of all three health cards, one section's error rendering independently of
  the others, and a sync trigger showing its result and refreshing job
  history — 17 frontend tests passing in total (unchanged backend count),
  clean lint/typecheck/build on both.
- Manually verified in a real browser (Playwright, mocked network
  responses — no live provider or Supabase project in this environment):
  every card, badge, and table renders correctly with realistic mocked
  data; a real backend error (`409 no_provider_configured`, matching what
  this environment's actual unconfigured provider would return) surfaces
  correctly under its button; the Dashboard/Users sub-nav navigates
  correctly in both directions.

## 2026-08-27 — Require sign-in for the whole app, not just admin routes

Follow-up to the same day's access-control work: until now, only
`/api/admin/*` required a signed-in user — fixtures, matches, teams,
leagues, and standings were publicly readable by design (a public sports
site). Changed on request: the app now has no anonymous read-only mode.

- Applied `requireAuth` (any signed-in user, no role check) to
  `createFixturesRouter`, `createMatchesRouter`, `createTeamsRouter`, and
  `createCompetitionsRouter` — every backend route except `/api/health*`
  now requires `Authorization: Bearer <supabase-jwt>`.
- Wrapped the frontend's `/` (`FixturesToday`) and `/matches/:id`
  (`MatchDetail`) routes in `<RequireAuth>`; an unauthenticated visitor is
  redirected straight to `/sign-in`. `getTodayFixtures`/`getMatch` in
  `lib/api.ts` now require and send the session's access token, matching
  the pattern already used for `/me` and the admin endpoints.
- This closes the gap deliberately: the backend enforcement is independent
  of the frontend's route guards, so a direct API call bypassing the UI
  gets the same `401 unauthenticated` a browser would.
- 5 new tests (`requireAuth.test.ts`, mirroring `requireAdmin.test.ts`'s
  structure: missing/malformed header, unrecognized token, and a valid
  token accepted regardless of role) — 141 backend / 13 frontend tests
  passing, clean lint/typecheck/build on both.
- Manually verified live: `GET /api/health` still `200` with no token;
  `GET /api/fixtures/today` and `GET /api/leagues` now `401` without one.
  In a real browser (Playwright against the dev server, dummy-but-valid
  Supabase credentials, no live project available in this environment),
  visiting `/` or `/matches/:id` while signed out lands on `/sign-in`.
- Updated API.md (moved fixtures/matches/teams/leagues/standings from
  "Public" to "Authenticated"), README.md, Architecture.md, Road_map.md,
  and Task.md accordingly. Same "not yet verified against a real Supabase
  project's JWTs" caveat as every other auth claim in this repo.

## 2026-08-27 — User access control: signup, sign-in, and an admin Users panel

- Added real frontend authentication: `/sign-in` and `/sign-up` pages
  (Supabase Auth, email+password), an `AuthProvider`/`useAuth()` context
  tracking session + own profile/role, and header UI showing signed-in
  state (email, an "Admin" nav link for admins, sign-out). New accounts
  always start as `role: 'user'`.
- Added `GET /api/me` (any signed-in user, no role check): returns the
  caller's own profile, auto-provisioning the `user_profiles` row on first
  call. Added admin-only `GET /admin/users` (every real account joined with
  its role) and `POST /admin/users/:id/role` (promote/demote), backing a
  new `/admin/users` frontend page. The endpoint refuses to demote the only
  remaining admin (`409 last_admin`) — no recovery from zero admins short
  of direct database access.
- **Found and fixed a real security gap while building this**: 0001's RLS
  policies on `user_profiles` restricted which row a signed-in user could
  touch, but not which columns — a user could PATCH their own `role` to
  `'admin'` directly. Nothing exploited this before now (the frontend had
  no direct Supabase client at all until this change), but it would have
  been live the moment one was added, which is exactly what happened here.
  Fixed in `supabase/migrations/0004_user_profiles_role_guard.sql`: the
  INSERT policy now pins new rows to `role = 'user'`, and a `before update`
  trigger blocks any `role` change unless the request is running as the
  service role — which is what the backend's role-management endpoint and
  the first-admin SQL bootstrap always are, so neither is affected.
- Refactored `requireAdmin.ts`'s JWT-verification logic into a shared
  `getAuthenticatedUser` (`middleware/auth.ts`), also used by the new
  `requireAuth` (any signed-in user, no role check) — `req.authUser` is now
  attached by both instead of the admin check duplicating it.
- Renamed README.md's "Creating the first admin user" section to "User
  access control," rewritten around the new sign-up flow: users self-serve
  sign up, admins promote from the `/admin/users` panel, and only the very
  first admin still needs a one-time manual SQL bootstrap (unavoidable —
  there's no admin yet to promote you).
- 21 new tests (8 backend: `me.test.ts`, `adminUsers.test.ts`; 8 frontend:
  `RequireAuth.test.tsx`, `RequireAdmin.test.tsx`, exercising every auth
  state — not-configured, loading, signed-out, signed-in non-admin,
  signed-in admin — via a directly-injected `AuthContext` rather than
  mocking the Supabase SDK) — 137 backend / 13 frontend tests passing in
  total, clean lint/typecheck/build on both. Manually verified in a real
  browser (Playwright against the dev server, no live Supabase project
  available in this environment): `/sign-in`, `/sign-up`, and
  `/admin/users` all show an explicit "Authentication is not configured"
  message with real (unset) env vars rather than crashing or rendering a
  broken form; with dummy-but-syntactically-valid Supabase credentials, the
  real sign-in/sign-up forms render correctly and `/admin/users` correctly
  redirects an unauthenticated visitor to `/sign-in`.
- **Not done, and cannot be done from here**: migration 0004 has not been
  run against a real Supabase project — same "no live project available in
  this environment" caveat as every other migration and provider claim in
  this changelog. The actual signed-in/admin-panel-rendered states are
  covered by component tests with an injected auth context, not by driving
  a real Supabase Auth session in a browser.

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
