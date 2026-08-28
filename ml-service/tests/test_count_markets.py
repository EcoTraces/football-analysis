import pytest

from app.models.count_markets import total_over_under


def test_probabilities_sum_to_one():
    p_over, p_under = total_over_under(lambda_total=3.8, line=3.5)
    assert p_over + p_under == pytest.approx(1.0, abs=1e-9)
    assert 0.0 <= p_over <= 1.0
    assert 0.0 <= p_under <= 1.0


def test_higher_rate_favours_over():
    p_over_low, _ = total_over_under(lambda_total=2.0, line=3.5)
    p_over_high, _ = total_over_under(lambda_total=6.0, line=3.5)
    assert p_over_high > p_over_low


def test_rejects_non_positive_lambda():
    with pytest.raises(ValueError):
        total_over_under(lambda_total=0, line=3.5)
    with pytest.raises(ValueError):
        total_over_under(lambda_total=-1, line=3.5)


def test_line_boundary_uses_floor_of_line():
    # line=9.5 means "under" covers 0..9 corners — poisson.cdf(9, ...).
    p_over, p_under = total_over_under(lambda_total=10.0, line=9.5)
    from scipy.stats import poisson

    assert p_under == pytest.approx(float(poisson.cdf(9, 10.0)))
    assert p_over == pytest.approx(1 - float(poisson.cdf(9, 10.0)))
