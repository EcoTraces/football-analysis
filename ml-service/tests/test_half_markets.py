import pytest

from app.models.half_markets import (
    FIRST_HALF_FRACTION,
    build_half_matrices,
    half_expected_goals,
    half_result_probabilities,
    half_with_most_goals_probabilities,
    total_goals_distribution,
)
from app.models.poisson import score_matrix


def test_half_expected_goals_splits_by_fixed_fraction():
    first = half_expected_goals(2.0, first_half=True)
    second = half_expected_goals(2.0, first_half=False)
    assert first == pytest.approx(2.0 * FIRST_HALF_FRACTION)
    assert second == pytest.approx(2.0 * (1 - FIRST_HALF_FRACTION))
    assert second > first  # more goals expected in the second half, by construction


def test_half_expected_goals_never_reaches_zero():
    assert half_expected_goals(0.0, first_half=True) > 0


def test_half_result_probabilities_sum_to_one_and_are_valid():
    matrix = score_matrix(0.9, 0.5, rho=0.0)
    probs = half_result_probabilities(matrix)
    assert probs["home"] + probs["draw"] + probs["away"] == pytest.approx(1.0, abs=1e-9)
    for value in probs.values():
        assert 0.0 <= value <= 1.0


def test_total_goals_distribution_sums_to_one():
    matrix = score_matrix(0.9, 0.5, rho=0.0)
    dist = total_goals_distribution(matrix)
    assert sum(dist) == pytest.approx(1.0, abs=1e-9)


def test_half_with_most_goals_probabilities_sum_to_one():
    first_matrix, second_matrix = build_half_matrices(1.6, 1.0)
    probs = half_with_most_goals_probabilities(first_matrix, second_matrix)
    assert probs["first_half"] + probs["second_half"] + probs["equal"] == pytest.approx(1.0, abs=1e-6)
    for value in probs.values():
        assert 0.0 <= value <= 1.0


def test_half_with_most_goals_favours_second_half_for_symmetric_teams():
    # Equal-strength teams: the only asymmetry is FIRST_HALF_FRACTION < 0.5,
    # so the second half should be favoured to have (strictly) more goals.
    first_matrix, second_matrix = build_half_matrices(1.4, 1.4)
    probs = half_with_most_goals_probabilities(first_matrix, second_matrix)
    assert probs["second_half"] > probs["first_half"]


def test_build_half_matrices_returns_valid_probability_matrices():
    first_matrix, second_matrix = build_half_matrices(1.6, 1.0)
    assert sum(sum(row) for row in first_matrix) == pytest.approx(1.0, abs=1e-9)
    assert sum(sum(row) for row in second_matrix) == pytest.approx(1.0, abs=1e-9)
