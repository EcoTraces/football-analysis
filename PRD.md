# Product Requirements Document

## Vision

A professional football analytics and prediction platform covering
competitions across Europe, Asia, North America, South America, and (where
reliable data exists) Africa, that answers questions like: what's being
played today, which matches have the strongest statistical signals, what's
the probability of each outcome and why, what's each team's form and
head-to-head record, who's unavailable, and how has the model actually
performed historically.

The platform prioritizes data quality, statistical rigor, model validation,
and transparency over flashy predictions. See `README.md` for what of this
vision is actually built today — this document describes the target, not
the current state.

## Non-negotiable principles

1. **Never fabricate data.** Fixtures, results, injuries, lineups, odds,
   standings, xG, weather, and model performance must come from a real,
   attributed, timestamped source. Where no source is configured or a
   provider is unavailable, the system shows "Data unavailable" — never a
   plausible-looking guess.
2. **Predictions are probabilities, never guarantees.** No "100% sure,"
   "guaranteed win," "fixed match," "banker," or "risk-free" language,
   anywhere — UI copy, API responses, or docs.
3. **Confidence ≠ probability.** A 70% prediction backed by thin data is not
   "high confidence." Confidence reflects data completeness, sample size,
   and model agreement.
4. **Everything time-sensitive carries provenance.** Source, timestamp, and
   a freshness classification (LIVE / RECENT / STALE / UNAVAILABLE).
5. **Responsible presentation.** Accumulator research is framed as
   statistical research, not betting advice, with responsible-gambling
   messaging on every surface that shows probabilities.

## Scope (target state)

- Fixture browsing across supported countries/competitions with rich
  filters (date, league, team, confidence, market, status).
- Team analysis: league position, form (recency- and opponent-strength
  weighted), home/away splits, goals/xG trends, rolling windows (last 5,
  last 10, season, home, away).
- Head-to-head analysis with recency weighting and explicit sample size.
- Player availability (injuries/suspensions/rotation) with
  EXPECTED/CONFIRMED/UNKNOWN lineup states, never presented as more certain
  than the source data supports.
- Match context: importance (title race, relegation, cup, derby...),
  schedule/fatigue, league-specific home-advantage effects, weather where
  reliable and only where statistically justified.
- Prediction engine: a model ensemble (Poisson/Dixon-Coles baseline today;
  logistic regression, gradient boosting, and others as the training
  pipeline matures) covering 1X2, BTTS, Over/Under, Asian Handicap, correct
  score, and other markets only where data quality supports them.
- Explainability: every prediction ships with its major positive/negative
  factors.
- Value analysis against real odds where a reliable odds provider is
  configured (implied probability vs. model probability, EV) — never
  presented without the underlying data being real.
- Daily analysis and accumulator research (SAFE-LEANING / BALANCED /
  HIGHER-VARIANCE shortlists), combined-probability math shown, never framed
  as guaranteed.
- Monthly analytics: historical accuracy, calibration, league/market
  breakdowns, clearly separated from forward-looking predictions.
- Model validation: backtesting with train/validation/test splits and
  walk-forward validation, tracked accuracy/log-loss/Brier score/calibration
  per league and market.
- Admin dashboard: data source health, job status, model versions/metrics.
- Notifications, search, user accounts and favorites.

## Out of scope for now

Anything requiring a live, licensed data provider this repository does not
have credentials for. The provider abstraction (`Data_Sources.md`) exists so
this can be turned on without an architecture change — it is not simulated
with fake data in the meantime.

## Current implementation status

See `README.md` → "What's actually implemented" and `Road_map.md` for the
phase-by-phase breakdown.
