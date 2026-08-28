"""First-half / second-half goal markets.

Not derived from poisson.py's full-match score matrix (unlike double_chance/
correct_score) — these need per-half expected goals, which the full-time
model doesn't produce on its own. Each half's score is modeled as its own
independent Poisson score matrix, reusing poisson.py's score_matrix()
function directly with scaled-down lambdas.

Two simplifications, both deliberate and both unfitted (see ML_Model.md):

1. Goals are split between halves using a fixed FIRST_HALF_FRACTION — the
   well-known empirical tendency for slightly more goals in the second half
   of professional matches, but not a figure calibrated against this
   platform's own data.
2. Each half's score matrix uses rho=0 (no Dixon-Coles low-score
   correlation adjustment), not the full match's RHO from poisson.py. The
   low-score correlation effect is documented for full 90-minute matches;
   this codebase has no basis for assuming it applies identically,
   unadjusted, to a 45-minute segment, and compounding one unverified
   constant (RHO) onto another (FIRST_HALF_FRACTION) without any evidence
   for either felt like the wrong default. Plain independent Poisson is the
   more honest "we don't actually know" choice here.
"""

from app.models.poisson import score_matrix

FIRST_HALF_FRACTION = 0.45


def half_expected_goals(lambda_full_match: float, first_half: bool) -> float:
    """Splits a full-match expected-goals rate into one half's share."""
    fraction = FIRST_HALF_FRACTION if first_half else (1 - FIRST_HALF_FRACTION)
    return max(lambda_full_match * fraction, 0.01)


def half_result_probabilities(half_matrix: list[list[float]]) -> dict[str, float]:
    """home/draw/away probabilities for a single half's own score matrix — same
    shape as poisson.py's 1x2 computation, just applied to a half instead of
    the full match."""
    n = len(half_matrix)
    home = sum(half_matrix[i][j] for i in range(n) for j in range(n) if i > j)
    draw = sum(half_matrix[i][j] for i in range(n) for j in range(n) if i == j)
    away = sum(half_matrix[i][j] for i in range(n) for j in range(n) if i < j)
    return {"home": home, "draw": draw, "away": away}


def total_goals_distribution(matrix: list[list[float]]) -> list[float]:
    """Marginal distribution of total goals (home+away) for a score matrix —
    index k holds P(total goals == k)."""
    n = len(matrix)
    dist = [0.0] * (2 * (n - 1) + 1)
    for i in range(n):
        for j in range(n):
            dist[i + j] += matrix[i][j]
    return dist


def half_with_most_goals_probabilities(
    first_half_matrix: list[list[float]], second_half_matrix: list[list[float]]
) -> dict[str, float]:
    """P(first half had more total goals), P(second half had more), P(equal).

    The two halves are independent by this model's own construction (see
    module docstring), so this is a straightforward weighted comparison of
    each half's total-goals marginal distribution — not a full joint
    scoreline computation the way a combined HT/FT market would need.
    """
    first_dist = total_goals_distribution(first_half_matrix)
    second_dist = total_goals_distribution(second_half_matrix)

    first_half = 0.0
    second_half = 0.0
    equal = 0.0
    for k1, p1 in enumerate(first_dist):
        if p1 == 0.0:
            continue
        for k2, p2 in enumerate(second_dist):
            joint = p1 * p2
            if k1 > k2:
                first_half += joint
            elif k1 < k2:
                second_half += joint
            else:
                equal += joint

    return {"first_half": first_half, "second_half": second_half, "equal": equal}


def wins_at_least_one_half_probabilities(
    first_half_probs: dict[str, float], second_half_probs: dict[str, float]
) -> dict[str, float]:
    """P(this side won at least one of the two halves), one value per side.

    Not a 3-way partition (unlike half_with_most_goals) — "home wins a half"
    and "away wins a half" are not mutually exclusive (home could win the
    first half while away wins the second), so this returns two independent
    yes-probabilities rather than selections that sum to 1. Uses the same
    half-independence assumption as half_with_most_goals_probabilities:
    P(wins >= 1) = 1 - P(doesn't win either) = 1 - P(not win 1H) * P(not win 2H).
    """
    home = 1 - (1 - first_half_probs["home"]) * (1 - second_half_probs["home"])
    away = 1 - (1 - first_half_probs["away"]) * (1 - second_half_probs["away"])
    return {"home": home, "away": away}


def build_half_matrices(lambda_home: float, lambda_away: float) -> tuple[list[list[float]], list[list[float]]]:
    """Convenience wrapper: returns (first_half_matrix, second_half_matrix)
    for a fixture's full-match lambda_home/lambda_away."""
    first_half_matrix = score_matrix(
        half_expected_goals(lambda_home, first_half=True),
        half_expected_goals(lambda_away, first_half=True),
        rho=0.0,
    )
    second_half_matrix = score_matrix(
        half_expected_goals(lambda_home, first_half=False),
        half_expected_goals(lambda_away, first_half=False),
        rho=0.0,
    )
    return first_half_matrix, second_half_matrix
