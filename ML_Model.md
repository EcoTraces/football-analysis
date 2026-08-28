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

## Half-based markets: `first_half_result`, `second_half_result`, `half_with_most_goals`

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
- Always computed, no optional gating like cards/corners — every fixture
  that gets a 1X2 prediction also gets all three of these.
- **Not calibrated or backtested in any way.** No real half-time score data
  has ever been compared against this model's output — `fixtures.
  home_score_ht`/`away_score_ht` (present in the schema since day one) was
  only wired up to actually get populated in the same piece of work that
  added these markets (`syncFixtures.ts`, parsing the vendor's
  `score.halftime` field), so there's now a real data source to eventually
  check these predictions against, but that check hasn't been done.

### Known limitations (be honest about these)

- **`RHO` is not fitted.** -0.1 is a commonly cited starting value in the
  literature, not a value calibrated against this platform's own data. Until
  a backtesting pipeline exists (`Task.md`), treat this model's calibration
  as unverified.
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
- **No backtesting.** `model_evaluations` (accuracy, log loss, Brier score,
  calibration) has no writer. Nothing in this repo currently proves this
  model is any good — it's mathematically consistent, not validated.

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

## Adding a new model

1. Implement it in `ml-service/app/models/`.
2. Add a `model_versions` row (name/version/algorithm).
3. Extend `PredictionClient`/`generatePredictionsForUpcomingFixtures` (or add
   a parallel path) to call it and compare against the baseline before
   treating any ensemble as an improvement — never swap the baseline out
   without a `model_evaluations` comparison backing the decision.
