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
