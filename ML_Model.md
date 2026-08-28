# ML Model

## Current model: `poisson-baseline` v0.1.0

Location: `ml-service/app/models/poisson.py`. An independent Poisson goals
model with the Dixon & Coles (1997) low-score correlation adjustment.

### How it works

1. Each team's expected goals rate is derived from its season
   goals-scored/conceded averages relative to league-average home/away
   goals: `home_attack = home.goals_scored_avg / league_avg_home_goals`,
   etc. Home attack combines with away defense (and vice versa) to produce
   `lambda_home`/`lambda_away`.
2. A score probability matrix is built from independent Poisson
   distributions over `lambda_home`/`lambda_away` (0–10 goals each), then
   adjusted by the Dixon-Coles `tau` correction for the four low-scoring
   cells (0-0, 1-0, 0-1, 1-1) using a fixed `RHO = -0.1`.
3. Market probabilities (1X2, BTTS, Over/Under 2.5) are summed from the
   matrix. All tests assert these sum to 1 exactly (`tests/test_poisson.py`).
4. Two markets are then *derived* from the results of steps 1–3 rather than
   modeled independently:
   - **Double chance** (`home_or_draw`, `home_or_away`, `draw_or_away`) is
     just a relabeling — each selection is the sum of the two 1X2 outcomes
     it covers (e.g. `home_or_draw = home_win + draw`). It carries no
     information beyond the 1X2 probabilities it's built from, and is only
     as accurate as they are.
   - **Correct score** exposes the score matrix's individual cells as their
     own market. The full grid is 121 cells (0–10 goals each side); only
     the top 10 most probable exact scorelines are returned as their own
     selections (`top_correct_scores()`), with the remaining probability
     mass reported as one `"other"` selection — so the market's
     probabilities still sum to 1 rather than silently dropping the tail.
     A scoreline this model has never assigned any real weight to (an 8-6,
     say) simply falls inside `"other"`, not its own selection.

   Both are pure functions of the same `lambda_home`/`lambda_away` and
   score matrix as the three original markets — there is no separate model,
   calibration, or historical data behind either one. The `RHO` and
   league-agnostic caveats below apply to them exactly as much as they do
   to 1X2/BTTS/O-U 2.5.

## More derived markets: clean sheet, odd/even, DNB, handicap, and two joint markets

Still in `poisson.py`, still pure functions of the same full-match matrix —
`market_probabilities()`, `btts_and_result_probabilities()`,
`result_and_total_goals_probabilities()`, and `handicap_probabilities()`.

- **`home_clean_sheet`/`away_clean_sheet`** were already computed as
  intermediate values inside `market_probabilities()` (`p_home_0`/`p_away_0`
  — "this side conceded zero") and simply weren't exposed as their own
  market before now.
- **`odd_even_goals`** sums the matrix by parity of `i + j`.
- **`draw_no_bet`** renormalizes `home_win`/`away_win` over the non-draw
  outcomes only (`home_win / (home_win + away_win)`) — "what the 1X2
  probabilities would be if the draw didn't exist," not a separate model.
  It is *not* the same number as `home_win` itself — draw-no-bet is always
  more confident, since it drops the probability mass that goes to neither
  side.
- **`btts_and_result`** and **`result_and_total_goals`** are each a genuine
  **joint** distribution (6 selections, sum to 1), not the product of two
  markets' marginals — BTTS and the match result are correlated through the
  same scoreline (a 1-0 home win can never be BTTS=yes), so each sums
  matrix cells directly. Tests assert the joint reduces back to the right
  marginal when summed over the other axis (e.g. `yes_home + yes_draw +
  yes_away` isn't asserted, but `no_home + no_draw + no_away ==
  btts_no` is).
- **`handicap`** applies a fixed `HANDICAP_HOME_LINE = -1.5` to the home
  side before comparing scorelines (home needs to win by 2+ to "cover").
  A half-integer line is used deliberately so there's no push/tie case —
  every scoreline resolves to exactly one side covering, same clean 2-way
  shape as every O/U-style market in this service. The line itself is
  fixed and unfitted, same category of simplification as every other fixed
  line in this file (`over_under_2_5`, `CARDS_LINE`, `CORNERS_LINE`,
  `TEAM_TOTAL_GOALS_LINE`).

## Team total goals: `home_team_total_goals`, `away_team_total_goals`

Reuses `count_markets.total_over_under()` directly (see below) — but
against a *single* side's own `lambda_home`/`lambda_away`, not the summed
rate cards/corners use. `TEAM_TOTAL_GOALS_LINE = 1.5` (`main.py`), same
"plausible, not fitted" caveat as every other fixed line. Always computed,
no optional-data gate — unlike cards/corners, both team lambdas are already
guaranteed present for every request that reaches this far.

## Count markets: `total_cards`, `total_corners`

Location: `ml-service/app/models/count_markets.py`. A genuinely different,
much simpler model from the goals one above — not a derivation of it.

- **Why not the Poisson goals model:** there's no meaningful "attack vs.
  opposing defense" relationship for cards or corners the way there is for
  goals — a card is mostly a function of a team's own discipline plus the
  referee, not directly the opponent's. So each side's own historical
  average (`homeTeamAvgYellowCards`/`awayTeamAvgYellowCards`,
  `homeTeamAvgCorners`/`awayTeamAvgCorners` in the request) is simply summed
  into one combined rate, and the match total is modeled as a single Poisson
  variable (`total_over_under()`) against a **fixed line** — 3.5 cards, 9.5
  corners (`CARDS_LINE`/`CORNERS_LINE` in `main.py`), chosen for plausibility
  as commonly-offered lines, not calibrated against this platform's own
  data. Same simplification as goals' `over_under_2_5`.
- **No data, no market — literally, per pair:** `/predict/poisson` only
  includes `total_cards` when *both* `homeTeamAvgYellowCards` and
  `awayTeamAvgYellowCards` are present in the request, and the same for
  `total_corners`/corners. The backend (`generatePredictions.ts`) sends
  `undefined`, not `0`, for a team whose `team_statistics` row doesn't have
  that field populated yet — so a fixture can have `total_cards` but not
  `total_corners`, or neither, depending on what's actually been synced for
  both teams.
- **Corners' data pipeline is the newest and least exercised in this
  project.** Unlike every other market's inputs, `team_statistics.corners`
  isn't written by the same sync job that populates goals — it's aggregated
  from a brand new `fixture_statistics` table via
  `syncFixtureStatistics.ts`/`refreshTeamCornersAverage()` (see
  `Database.md`, `Data_Sources.md`). Until that job has actually run against
  live fixtures, `total_corners` will simply never appear for any fixture —
  which is the intended fail-safe (no data → no market), not a bug, but
  worth knowing when a fixture's prediction cards are missing it.

## Half-based markets: `first_half_result`, `second_half_result`, `half_with_most_goals`, `home_wins_a_half`, `away_wins_a_half`

Location: `ml-service/app/models/half_markets.py`. Reuses `poisson.py`'s
`score_matrix()` function directly, but is not a *derivation* of the
full-match matrix the way double chance/correct score are — it needs its
own pair of per-half score matrices, built from scaled-down lambdas.

- Each side's full-match `lambda_home`/`lambda_away` (already computed for
  the main markets — no new request fields needed, unlike cards/corners)
  is split into a first-half share and a second-half share using a fixed
  `FIRST_HALF_FRACTION = 0.45` — the well-known empirical tendency for
  slightly more goals in the second half of professional matches, but
  **not fitted to this platform's own data**, same category of
  simplification as `RHO` and the count-markets' fixed lines.
- Each half gets its own independent Poisson score matrix
  (`build_half_matrices()`), but **with `rho=0`, not the full match's
  `RHO`.** Dixon-Coles' low-score correlation adjustment is documented for
  full 90-minute matches; there's no basis in this codebase for assuming it
  applies identically, unadjusted, to a 45-minute segment, and compounding
  one unverified constant onto another without any evidence for either felt
  like the wrong default. Plain independent Poisson per half is the more
  honest choice given what's actually known here.
- `first_half_result`/`second_half_result` are each a plain home/draw/away
  computed from one half's own matrix (`half_result_probabilities()`) — the
  same structure as 1X2, just scoped to one half's goals instead of the
  full match's.
- `half_with_most_goals` (`first_half`/`second_half`/`equal`) compares each
  half's *total*-goals marginal distribution
  (`total_goals_distribution()`), not a full joint scoreline computation —
  the two halves are independent by this model's own construction, so a
  weighted comparison of their marginals is sufficient and exact under that
  assumption.
- `home_wins_a_half`/`away_wins_a_half` (`wins_at_least_one_half_probabilities()`)
  are, like anytime-goalscorer, **independent per-side probabilities that
  don't sum to 1** — both teams can win a half in the same match (home
  takes the first, away takes the second), so these aren't a 3-way
  partition of one distribution. `P(wins >= 1 half) = 1 - P(wins neither
  half)`, using the same half-independence assumption
  `half_with_most_goals` already relies on.
- Always computed, no optional gating like cards/corners — every fixture
  that gets a 1X2 prediction also gets all five of these.
- **Not calibrated or backtested in any way.** No real half-time score data
  has ever been compared against this model's output — `fixtures.
  home_score_ht`/`away_score_ht` (present in the schema since day one) was
  only wired up to actually get populated in the same piece of work that
  added these markets (`syncFixtures.ts`, parsing the vendor's
  `score.halftime` field), so there's now a real data source to eventually
  check these predictions against, but that check hasn't been done.

## Anytime goalscorer: `home_anytime_goalscorer`, `away_anytime_goalscorer`

Location: `ml-service/app/models/player_market.py`. The biggest departure
from every other market in this file — both in what it needs (per-player
data, which required a brand-new ingestion pipeline — `player_statistics`,
`syncPlayerStatistics.ts`, see `Data_Sources.md`) and in its output shape.

- **Not mutually exclusive.** Every other market's selections partition one
  probability distribution and sum to 1 (home/draw/away, over/under, ...).
  This one doesn't: "will player X score" and "will player Y score" are
  independent events (both, either, or neither can happen), so
  `home_anytime_goalscorer`'s rows are NOT constrained to sum to 1 — and
  the tests deliberately don't assert that they do. Two separate markets
  (home/away), not one shared one, since `predictions` has no team-side
  column and mixing both squads' names into one flat list would be
  ambiguous about which team a name belongs to.
- **Not lineup-gated — stated plainly as a real simplification.** This does
  NOT check whether a player is actually selected, fit, or even still at
  the club for the specific fixture being predicted. It ranks a team's own
  historical top scorers (`top_scorers()`: at least `MIN_APPEARANCES = 3`
  appearances, at least one goal, capped at `MAX_CANDIDATES = 6`, sorted by
  season goals) and assumes each is as likely to play and score as their
  season record suggests. This platform already has `lineups` data
  (refreshed close to kickoff), so a more accurate lineup-gated version is
  possible — deliberately not built here, since gating on confirmed
  lineups would mean this market simply doesn't exist until shortly before
  kickoff, unlike every other market (available as soon as a fixture gets
  any prediction at all, days out). See `Task.md` for the tradeoff.
- **The probability itself** (`anytime_scorer_probability()`) is an
  independent-Poisson approximation: a player's own historical share of
  their team's total goals (`player_goals / team_total_goals`, both season
  totals) scales the team's match-level `lambda_home`/`lambda_away` down to
  a player-level rate, and `P(scores >= 1) = 1 - e^-lambda`.
  `team_total_goals` is derived from the same `goals_scored_avg *
  matches_played` already in the request — no new field needed for it.
- **No `factors`.** A list of up to 6 largely-unrelated per-player numbers
  isn't well served by the 2-3 bullet explanations used elsewhere.
- **Per-side optional data, independently.** `/predict/poisson` only builds
  a side's market when that side's player list is present in the request
  (`homeTeamPlayers`/`awayTeamPlayers`) — the backend sends `undefined`,
  not `[]`, when nothing has ever been synced for that team's season
  (`generatePredictions.ts::loadPlayerCandidates`), same "no data, no
  market" policy as cards/corners, just per-side instead of per-pair.
- **`/players`' pagination isn't fully handled.** api-football's endpoint
  returns 20 players/page; `ApiFootballProvider.getPlayerStatistics` only
  requests the first page. A fringe player past the 20th slot being missed
  is very unlikely to matter, since only the top 6 scorers are ever
  surfaced anyway — but it's a real, documented gap, not an oversight to
  discover later.

### Known limitations (be honest about these)

- **`RHO` can now be fitted, but has never actually been fitted for real.**
  -0.1 is a commonly cited literature starting value, not a value
  calibrated against this platform's own data. A real MLE fitting
  pipeline now exists (see "Rho fitting" below), but it has never
  actually been run against real historical results in this environment —
  no live API-Football key has ever been connected here, so there is no
  real fixture history to fit against. Treat this model's calibration as
  unverified until someone runs it against real data.
- **League-agnostic.** The same `RHO` and the caller-supplied league
  averages are the only place league identity enters the model. No
  league-specific home-advantage effect is modeled yet (spec section 16).
- **No opponent-strength or recency weighting.** `goals_scored_avg`/
  `goals_conceded_avg` are simple season averages passed in by the caller —
  no recency weighting (spec section 10) or head-to-head signal (section 11)
  feeds this model yet.
- **Single model, not an ensemble.** Spec section 19 calls for comparing
  multiple algorithms (logistic regression, gradient boosting, etc.) and
  using an ensemble where it outperforms. Only the Poisson baseline exists.
- **Backtesting exists but is unrun.** `model_evaluations` now has a writer
  (see "Backtesting" below), but it has never been executed against real
  data — there is no real fixture history in this environment to backtest
  against. Nothing in this repo currently proves this model is any good;
  it's mathematically consistent, not validated.

### Data quality and confidence

`data_quality_for()` classifies `insufficient` (<5 matches for either team),
`limited` (5–9), or `strong` (10+) — a proxy for sample size, not model
performance. The backend's `confidenceFor()`
(`backend/src/jobs/generatePredictions.ts`) combines this with match count
to set `low`/`medium`/`high` confidence — deliberately not a function of the
predicted probability itself (spec section 26).

### Explainability

`explain_factors()` returns plain-language factors derived only from the
inputs the model actually used (expected-goals gap, conceding rate,
sample size) — never claims about tactics, injuries, or anything outside
this model's inputs. Directional factors are polarity-flipped for the away
selection; sample-size caveats are not (see code comments).

## Backtesting

`backend/src/jobs/runBacktest.ts` implements a genuine walk-forward
backtest of the **1x2 market only** (none of the other ~20 markets this
platform predicts are backtested yet). An admin picks a `[from, to]` date
range; for every finished, non-synthetic fixture whose kickoff falls in
that range, the job:

1. Recomputes both teams' strength (`goals_scored_avg`, `goals_conceded_avg`,
   `matches_played`) via `computePointInTimeStrength()` — aggregated
   directly from `fixtures` rows that are `status = 'finished'`,
   `is_synthetic = false`, and have `kickoff_utc` **strictly before** the
   fixture being backtested. This is the one detail the whole pipeline
   exists to get right: `team_statistics` is a single current snapshot, not
   a time series, so using it for a historical fixture would leak
   knowledge of matches that hadn't happened yet at that fixture's kickoff
   (lookahead bias) — silently making the backtest look better than any
   real prediction could have been. Point-in-time computation from
   fixtures' own results avoids that entirely.
2. Skips the fixture (like live predictions) if either team has fewer than
   `MIN_MATCHES_FOR_PREDICTION` (3) prior matches at that point in time.
3. Calls a `predictFn` — the real `PredictionClient.predictPoisson()` or
   `.predictGradientBoosting()` depending on which `model` the caller asked
   for (see "Gradient boosting model" below), the same code path live
   predictions/that model's own endpoint uses, not a shortcut — with those
   point-in-time strengths.
4. Scores the returned `1x2` probabilities against what actually happened:
   **accuracy** (did the highest-probability selection match the result),
   **log loss** (`-ln(p_actual)`, clamped away from exactly 0 so one
   zero-probability forecast can't make the run's average infinite), and
   **Brier score** (the standard multi-class form: sum of
   `(forecast - indicator)^2` over the three outcomes per fixture, averaged
   over fixtures — not further divided by the outcome count).
5. Writes exactly one `model_evaluations` row per run (`market: "1x2"`,
   `evaluation_window: "<from>..<to>"`), or none if zero fixtures qualified.

`runLatestBacktestJob()` wraps this with the same `ingestion_runs`
bookkeeping every sync job gets (so a backtest run shows up in the admin
job history), but **is deliberately not wired into the scheduler**
(`scheduler.ts`) — backtesting is an occasional evaluation an admin
triggers over a chosen window, not ongoing ingestion.

Admin routes: `POST /admin/backtest/run?from=&to=&competitionId=&model=`
(rate limited like every other sync/prediction trigger; `model` defaults to
`poisson-baseline`) and `GET /admin/backtest/results?limit=` to read back
past runs, enriched with each row's model name — see `API.md`. A panel on
the admin dashboard (`AdminDashboard.tsx`) exposes both, plus a model
selector, so this is never a curl-only capability.

**What this does and doesn't prove.** The pipeline itself is real and unit
tested — in particular, a dedicated test proves
`computePointInTimeStrength()` genuinely excludes a fixture at or after the
target kickoff (a simultaneous result is not "prior" data either), and
another proves the accuracy/log-loss/Brier-score math against known
synthetic predictions. What it has **not** done is run against real
historical results: no live API-Football key has ever been connected in
this environment, so there is no real fixture history to backtest against.
Running it for real, and using the resulting `model_evaluations` rows to
decide whether the current fixed `RHO = -0.1` (or the "Rho fitting" section
below's alternative) is actually any good, is future work.

## Rho fitting

`ml-service/app/models/rho_fitting.py` fits the Dixon-Coles low-score
correlation parameter (`RHO`) by maximum likelihood from real match
results, instead of leaving it at the fixed `RHO = -0.1` approximation.
This is the second wishlist item off Task.md, after gradient boosting.

**Why only four scorelines matter.** `dixon_coles_tau(x, y, lam, mu, rho)`
(`poisson.py`) is exactly `1.0` — no dependence on `rho` at all — for
every scoreline except `(0,0)`, `(0,1)`, `(1,0)`, and `(1,1)`. That is the
entire Dixon-Coles adjustment, by construction. So only matches that
actually finished as one of those four scorelines carry any information
about `rho`; every other match contributes exactly zero to the fit. This
is inherent to the model's shape, not a limitation of this
implementation — handing over a thousand matches that happen to avoid
those four scorelines still yields nothing to fit from.
`fit_rho()` refuses (raises `ValueError`, mapped to `422`) below
`MIN_INFORMATIVE_MATCHES` (30) matches at those four scorelines
specifically, not below some raw row count.

**The fit itself.** Since the independent-Poisson marginal terms don't
depend on `rho`, maximizing the Dixon-Coles log-likelihood over `rho`
reduces to maximizing `sum(log(tau_i(rho)))` across matches —
`scipy.optimize.minimize_scalar` does that directly. The search is bounded
to whatever range of `rho` keeps every informative match's `tau` strictly
positive (a valid probability), derived directly from `tau`'s own
formulas rather than guessed (`_valid_rho_bounds()`). Tested against a
genuine parameter-recovery case: synthetic scorelines are sampled from
`poisson.py`'s own `score_matrix()` at a known `true_rho`, and `fit_rho()`
is asserted to recover it within a small tolerance — this is the
strongest test in this codebase that the optimization machinery actually
works, as opposed to merely running without error.

**Where the inputs come from.** `backend/src/jobs/fitDixonColesRho.ts`'s
`buildRhoFittingRows()` reuses `runBacktest.ts`'s
`computePointInTimeStrength()` — the identical walk-forward computation
training/backtesting already use — so a fit is never informed by a team's
future results relative to the fixture being fit on (the same
lookahead-bias concern that motivated backtesting in the first place).
Each row carries the *exact final score*, not just the win/draw/loss
result gradient boosting's training rows use — rho fitting is sensitive to
the precise scoreline, since only four exact scorelines are informative at
all.

**How a fit takes effect.** Like the gradient boosting model,
`ml-service/app/main.py` keeps exactly one process-local, in-memory
`_fitted_rho: float | None` (`None` = "nobody has fit rho yet, use
`poisson.py`'s fixed `RHO`"). `POST /fit/dixon_coles_rho` sets it;
`GET /rho_status` reports it; every `/predict/poisson` call after a
successful fit uses it via `_effective_rho()`. Because that same endpoint
backs both live predictions and `runBacktest.ts`'s scoring of
`poisson-baseline`, a fit takes effect for **every market derived from the
full-match score matrix** — 1x2, correct score, BTTS, over/under, double
chance, clean sheet, odd/even, draw no bet, the two joint markets, and the
handicap market — not just 1x2. The half-based markets are the one
exception: they deliberately use `rho=0` regardless (see
`half_markets.py`), so a rho fit never touches them. Same "in-memory only,
lost on restart" caveat as gradient boosting's trained state — a real
persistence layer doesn't exist yet.

On a successful fit, `runLatestDixonColesRhoFitJob()` also updates
`poisson-baseline`'s **existing** `model_versions` row
(`trained_at`/`training_dataset_version`/`notes`) — this refines that
model, it doesn't create a new one, unlike gradient boosting's separate
row.

Admin routes: `POST /admin/model/poisson/fit-rho?from=&to=&competitionId=`
(same rate limiting/range guardrails as backtest/training) and
`GET /admin/model/poisson/rho-status` (unauthenticated-by-role-only read,
like `/admin/data-health`) — see `API.md`. The admin dashboard's
"Backtest & models" panel shows the currently-effective rho and exposes a
"Fit Dixon-Coles rho" button, so this is never a curl-only capability.

**Caveats — same discipline as everything else in this file.** This has
never been run against real data: no live API-Football key has ever been
connected in this environment, so there is no real fixture history with
enough 0-0/1-0/0-1/1-1 results to fit against. `poisson-baseline`'s
`model_versions` row stays at its dev-seeded, unfit state in practice.

## Gradient boosting model

`ml-service/app/models/gradient_boosting.py` is the platform's second
model — the first item worked off Task.md's wishlist ("add at least one
additional model... and compare against the Poisson baseline before
calling anything an ensemble"). Scoped to the **1x2 market only**, the same
market-scope discipline the backtesting pipeline established, rather than
porting all ~20 markets to a new model family before this one is proven
out.

**Why it's a genuinely different shape from `poisson.py`.** The Poisson
model has a closed-form formula — it can always produce a probability,
calibrated or not. Gradient boosting has no formula at all; it is only
ever as good as what it was fit on, and produces nothing before that.
`GradientBoostingOneXTwoModel.predict()` raises `NotTrainedError` rather
than fabricating a fallback guess (e.g. an even 1/3-1/3-1/3 split) when
nobody has trained it yet — the ml-service endpoint turns that into a
`409`, and `PredictionClient.predictGradientBoosting()` maps that to
`null`, the same "unavailable, never fabricated" contract
`predictPoisson()` already has.

**Training.** `backend/src/jobs/trainGradientBoosting.ts`'s
`buildTrainingRows()` reuses `runBacktest.ts`'s
`computePointInTimeStrength()` to build one training row per finished,
non-synthetic fixture in an admin-chosen `[from, to]` range (same
`MIN_MATCHES_FOR_PREDICTION` gate as live predictions and backtesting) —
this is not incidental reuse: training on a team's full-season aggregate to
predict one of that season's own matches would leak future results into
the training set, the identical lookahead-bias concern that motivated the
backtesting pipeline in the first place. `runLatestGradientBoostingTrainingJob()`
POSTs the rows to `POST /train/gradient_boosting`, which refuses (`422`) to
fit on fewer than `MIN_TRAINING_ROWS` (20) rows or on data with only one
outcome class — a model trained on too little or too narrow a sample is
worse than no model. On success, it updates the `gradient-boosting`
`model_versions` row's `trained_at`/`training_dataset_version`/`notes`
(the same columns `poisson-baseline`'s manually-seeded row already has,
now with a real writer). Like backtesting, training is **never wired into
the scheduler** — retraining is an explicit, occasional admin action, not
ongoing ingestion.

**State is process-local and in-memory only.** `main.py` keeps exactly one
`GradientBoostingOneXTwoModel` instance for the life of the ml-service
process; a restart loses whatever was trained, and the backend must
retrain after every ml-service redeploy/restart. A real deployment would
persist the fitted model (disk or object storage) and reload it at boot —
that persistence layer does not exist yet. Deliberate simplification, not
an oversight.

**Comparing against the baseline.** `runBacktest.ts` was generalized to
take a `predictFn` instead of hardcoding `predictPoisson()` — it never
knows or cares which model it's scoring. `runLatestBacktestJob()` now
takes a `modelName: "poisson-baseline" | "gradient-boosting"` (default
`poisson-baseline`) and looks up that model's own `model_versions` row and
predict endpoint. Running a backtest over the same `[from, to]` range once
per model produces two directly comparable `model_evaluations` rows (same
market, same evaluation window, different `model_version_id`) — this is
the mechanism the wishlist's "compare... before calling anything an
ensemble" requirement leans on. No comparison has actually been run in
this environment; see the caveat below.

**No `factors`.** Unlike Poisson's `explain_factors()`, gradient boosting
predictions carry an empty `factors` list — there's no hand-derived,
plain-language explanation for what hundreds of decision trees weighted,
and fabricating one would misrepresent how the prediction was actually
produced. A real explainability story for this model (e.g. SHAP values) is
future work.

**Caveats — same discipline as everything else in this file.** In-sample
`trainAccuracy` reported by `/train/gradient_boosting` is a training-set
diagnostic, not a generalization estimate — never present it as
performance; use a backtest over fixtures the model was never trained on
for that. And, as with the backtesting pipeline itself: this model has
never actually been trained or backtested against real data. No live
API-Football key has ever been connected in this environment, so there is
no real fixture history to train on — the `gradient-boosting`
`model_versions` row exists (dev-seeded, like `poisson-baseline`'s) but is
deliberately left untrained (`trained_at = null`), because there isn't
remotely enough real data here to train it honestly, and synthetic seed
data must never be used to fabricate a "trained" model.

## Adding a new model

1. Implement it in `ml-service/app/models/` — see `gradient_boosting.py`
   for a worked example of a model with no closed-form fallback.
2. Add a `model_versions` row (name/version/algorithm) — manually seeded
   for now, same as `poisson-baseline`'s; see "Gradient boosting model"
   above for why there's no admin route for this yet.
3. Extend `PredictionClient`/`generatePredictionsForUpcomingFixtures` (or add
   a parallel path) to call it and compare against the baseline before
   treating any ensemble as an improvement — never swap the baseline out
   without a `model_evaluations` comparison backing the decision.
4. If it should be backtestable, add it to `runBacktest.ts`'s
   `BacktestableModel` union and `buildPredictFn()` — the walk-forward
   scoring logic itself never needs to change.
