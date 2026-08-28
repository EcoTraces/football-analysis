import numpy as np
import pytest

from app.models.poisson import score_matrix
from app.models.rho_fitting import MIN_INFORMATIVE_MATCHES, RhoFittingRow, fit_rho, log_likelihood


def _sample_scores(lambda_home: float, lambda_away: float, rho: float, n: int, rng: np.random.Generator) -> list[tuple[int, int]]:
    """Draws `n` (home_goals, away_goals) outcomes from the *actual*
    Dixon-Coles-adjusted distribution for a known rho — ground truth for
    the recovery test below, built from poisson.py's own score_matrix()
    rather than a separate hand-rolled model."""
    matrix = score_matrix(lambda_home, lambda_away, rho=rho)
    max_goals = len(matrix) - 1
    flat = [p for row in matrix for p in row]
    indices = rng.choice(len(flat), size=n, p=flat)
    return [(int(idx) // (max_goals + 1), int(idx) % (max_goals + 1)) for idx in indices]


def test_fit_rho_recovers_a_known_parameter_from_synthetic_data():
    true_rho = -0.35  # Deliberately far from poisson.py's fixed default (-0.1), so a wrong fit would be obvious.
    rng = np.random.default_rng(seed=42)
    lambda_pairs = [(1.4, 1.1), (1.8, 0.9), (1.0, 1.3), (2.2, 0.7), (0.8, 0.8)]

    rows = []
    for lambda_home, lambda_away in lambda_pairs:
        for home_goals, away_goals in _sample_scores(lambda_home, lambda_away, true_rho, n=4000, rng=rng):
            rows.append(RhoFittingRow(lambda_home, lambda_away, home_goals, away_goals))

    result = fit_rho(rows, default_rho=-0.1)

    assert result.sample_size == len(rows)
    assert result.informative_matches >= MIN_INFORMATIVE_MATCHES
    assert result.fitted_rho == pytest.approx(true_rho, abs=0.03)
    # The fitted value should explain the data at least as well as the
    # (deliberately different) fixed default — the whole point of fitting.
    assert result.log_likelihood_at_fitted_rho >= result.log_likelihood_at_default_rho


def test_fit_rho_raises_when_too_few_informative_matches():
    # Every row finishes 3-2 — never one of the four rho-sensitive
    # scorelines — no matter how many of them there are.
    rows = [RhoFittingRow(1.5, 1.2, 3, 2) for _ in range(100)]
    with pytest.raises(ValueError, match="rho-sensitive"):
        fit_rho(rows, default_rho=-0.1)


def test_log_likelihood_is_unaffected_by_rho_when_no_row_is_informative():
    # Direct check of this module's central claim: tau (and therefore the
    # log-likelihood) doesn't depend on rho at all outside the four
    # informative scorelines.
    rows = [RhoFittingRow(1.5, 1.2, 3, 2), RhoFittingRow(2.0, 0.5, 4, 4), RhoFittingRow(0.9, 0.9, 2, 5)]
    assert log_likelihood(-0.5, rows) == log_likelihood(0.5, rows) == 0.0


def test_log_likelihood_penalizes_a_rho_that_makes_tau_non_positive():
    # A (0,0) row with lam*mu = 4 requires rho < 0.25 to keep tau positive.
    rows = [RhoFittingRow(lambda_home=2.0, lambda_away=2.0, actual_home_goals=0, actual_away_goals=0)]
    assert log_likelihood(0.5, rows) == float("-inf")
    assert log_likelihood(0.1, rows) > float("-inf")
