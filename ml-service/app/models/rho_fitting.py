"""Fits the Dixon-Coles low-score correlation parameter (RHO) from real
match results by maximum likelihood, instead of poisson.py's fixed
approximation (RHO = -0.1).

Why only four scorelines matter: dixon_coles_tau(x, y, lam, mu, rho) is
exactly 1.0 (no rho dependence at all) for every scoreline except (0,0),
(0,1), (1,0), and (1,1) — that is the entire Dixon-Coles adjustment, by
construction (see poisson.py). So only matches that actually finished as
one of those four scorelines carry any information about rho; every other
match contributes exactly zero to this fit's objective. This is inherent
to the model's shape, not a limitation of this implementation — a caller
handing over hundreds of matches that happen to avoid those four
scorelines still gets nothing to fit from.

lambda_home/lambda_away per match are supplied by the caller (main.py
computes them via poisson.py's own expected_goals(), from point-in-time
team strength — see backend/src/jobs/fitDixonColesRho.ts) and never
re-derived here; this module only ever touches rho.
"""

import math
from dataclasses import dataclass

from scipy.optimize import minimize_scalar

from app.models.poisson import dixon_coles_tau

# See module docstring — this floor is on how many matches actually landed
# on one of the four rho-sensitive scorelines, not on the raw row count.
# Real football has those scorelines in roughly a quarter to a third of
# matches, so even 30 is a low bar for a genuinely stable estimate, not a
# claim of real statistical power — same "plausible, not authoritative"
# spirit as this platform's other fixed thresholds.
MIN_INFORMATIVE_MATCHES = 30

# Sane outer range for a low-score correlation parameter — real
# Dixon-Coles fits in the literature sit much closer to zero than this.
_OUTER_BOUNDS = (-1.0, 1.0)
_EPSILON = 1e-6  # Keeps tau strictly positive at the search boundary (avoids log(0)).

_INFORMATIVE_SCORELINES = {(0, 0), (0, 1), (1, 0), (1, 1)}


@dataclass
class RhoFittingRow:
    lambda_home: float
    lambda_away: float
    actual_home_goals: int
    actual_away_goals: int


def _is_informative(row: RhoFittingRow) -> bool:
    return (row.actual_home_goals, row.actual_away_goals) in _INFORMATIVE_SCORELINES


def log_likelihood(rho: float, rows: list[RhoFittingRow]) -> float:
    """Sum of log(tau) across all rows — the only rho-dependent term of the
    Dixon-Coles log-likelihood (the independent-Poisson marginals are
    constants with respect to rho, so they don't move where the maximum
    falls, and are omitted here). -inf for any rho that makes some row's
    tau non-positive — an invalid probability, not merely an unlikely one.
    """
    total = 0.0
    for row in rows:
        tau = dixon_coles_tau(row.actual_home_goals, row.actual_away_goals, row.lambda_home, row.lambda_away, rho)
        if tau <= 0:
            return float("-inf")
        total += math.log(tau)
    return total


def _valid_rho_bounds(rows: list[RhoFittingRow]) -> tuple[float, float]:
    """Tightest [lower, upper] within which every row's tau stays positive
    for every one of the four informative scorelines — derived directly
    from tau's own formulas (see poisson.py), not guessed. (0,0) and (1,1)
    rows only ever tighten the upper bound; (0,1) and (1,0) rows only ever
    tighten the lower bound — both always stay within _OUTER_BOUNDS since
    1/(lam*mu) and -1/lam are never negative/positive respectively.
    """
    lower, upper = _OUTER_BOUNDS
    for row in rows:
        x, y, lam, mu = row.actual_home_goals, row.actual_away_goals, row.lambda_home, row.lambda_away
        if (x, y) == (0, 0) and lam * mu > 0:
            upper = min(upper, 1 / (lam * mu))
        elif (x, y) == (1, 1):
            upper = min(upper, 1.0)
        elif (x, y) == (0, 1) and lam > 0:
            lower = max(lower, -1 / lam)
        elif (x, y) == (1, 0) and mu > 0:
            lower = max(lower, -1 / mu)
    return lower, upper


@dataclass
class RhoFitResult:
    sample_size: int
    informative_matches: int
    fitted_rho: float
    # Diagnostics, not a claim of out-of-sample performance — both are
    # computed on the same rows the fit used. Compares the fitted value
    # against whatever `default_rho` the caller is currently using, so a
    # caller can see whether fitting actually found anything better.
    log_likelihood_at_fitted_rho: float
    log_likelihood_at_default_rho: float


def fit_rho(rows: list[RhoFittingRow], default_rho: float) -> RhoFitResult:
    informative_count = sum(1 for r in rows if _is_informative(r))
    if informative_count < MIN_INFORMATIVE_MATCHES:
        raise ValueError(
            f"Need at least {MIN_INFORMATIVE_MATCHES} matches finishing 0-0, 1-0, 0-1, or 1-1 to fit rho "
            f"(only those scorelines are rho-sensitive — see module docstring), got {informative_count} "
            f"out of {len(rows)} rows."
        )

    lower, upper = _valid_rho_bounds(rows)
    lower, upper = lower + _EPSILON, upper - _EPSILON
    if lower >= upper:
        raise ValueError(
            "No rho value keeps every row's Dixon-Coles adjustment a valid probability — "
            "check for extreme expected-goals values among the informative matches."
        )

    result = minimize_scalar(lambda rho: -log_likelihood(rho, rows), bounds=(lower, upper), method="bounded")
    fitted_rho = float(result.x)

    return RhoFitResult(
        sample_size=len(rows),
        informative_matches=informative_count,
        fitted_rho=fitted_rho,
        log_likelihood_at_fitted_rho=log_likelihood(fitted_rho, rows),
        log_likelihood_at_default_rho=log_likelihood(default_rho, rows),
    )
