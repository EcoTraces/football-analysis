"""Total-count over/under markets: bookings (cards) and corners.

Unlike goals, these aren't modeled with the Dixon-Coles score matrix in
poisson.py — there's no meaningful "attack vs. opposing defense" relationship
for cards or corners the way there is for goals (a card is mostly a function
of a team's own discipline plus the referee, not directly the opponent's
defensive record), and this platform has no data suggesting otherwise. So
each side's own historical average is summed into one combined rate, and the
match total is modeled as a single Poisson variable — the sum of two
independent Poisson variables is itself Poisson with the combined rate, so no
joint distribution/matrix is needed the way goals' score grid is.

This is a deliberately simpler model than goals — a starting point, not a
claim that cards/corners have been researched as carefully. See ML_Model.md.
"""

import math

from scipy.stats import poisson


def total_over_under(lambda_total: float, line: float) -> tuple[float, float]:
    """Returns (p_over, p_under) for a total-count market modeled as Poisson(lambda_total).

    `line` is expected to be a half-integer (e.g. 9.5, 3.5), matching how
    these markets are actually offered — there is no push/exact-tie case to
    handle. A whole-number line isn't specially handled (over_2_5 in
    poisson.py has its own, market-specific exact-boundary logic for goals;
    this function doesn't reproduce that here since nothing today calls it
    with one).
    """
    if lambda_total <= 0:
        raise ValueError("lambda_total must be positive")
    threshold = math.floor(line)
    p_under = float(poisson.cdf(threshold, lambda_total))
    return (1 - p_under, p_under)
