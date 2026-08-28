"""Dixon-Coles-adjusted independent Poisson goals model.

This is the platform's baseline prediction model (spec section 19). It is
intentionally simple and fully transparent: two expected-goals rates derived
from each team's season scoring/conceding averages relative to a league
baseline, an independent Poisson distribution over the resulting score grid,
and the low-score correlation adjustment from Dixon & Coles (1997).

RHO (the low-score correlation parameter) is a fixed, documented
approximation here, not fitted from historical results — this service does
not yet have a training/backtesting pipeline (see ML_Model.md, Road_map.md).
Treat this model's calibration as unverified until backtested; the backend
propagates data_quality/confidence rather than presenting output as
guaranteed regardless.
"""

from dataclasses import dataclass

from scipy.stats import poisson

RHO = -0.1  # Fixed approximation; see module docstring.
MAX_GOALS = 10  # Captures effectively all probability mass for realistic lambdas.


@dataclass
class TeamStrength:
    matches_played: int
    goals_scored_avg: float
    goals_conceded_avg: float


def dixon_coles_tau(x: int, y: int, lam: float, mu: float, rho: float) -> float:
    if x == 0 and y == 0:
        return 1 - (lam * mu * rho)
    if x == 0 and y == 1:
        return 1 + (lam * rho)
    if x == 1 and y == 0:
        return 1 + (mu * rho)
    if x == 1 and y == 1:
        return 1 - rho
    return 1.0


def expected_goals(
    home: TeamStrength, away: TeamStrength, league_avg_home_goals: float, league_avg_away_goals: float
) -> tuple[float, float]:
    """Return (lambda_home, lambda_away) expected-goals rates."""
    home_attack = home.goals_scored_avg / league_avg_home_goals
    home_defense = home.goals_conceded_avg / league_avg_away_goals
    away_attack = away.goals_scored_avg / league_avg_away_goals
    away_defense = away.goals_conceded_avg / league_avg_home_goals

    lambda_home = home_attack * away_defense * league_avg_home_goals
    lambda_away = away_attack * home_defense * league_avg_away_goals
    return max(lambda_home, 0.01), max(lambda_away, 0.01)


def score_matrix(lambda_home: float, lambda_away: float, rho: float = RHO) -> list[list[float]]:
    """P[i][j] = probability of a final score of i home goals, j away goals."""
    home_pmf = [poisson.pmf(i, lambda_home) for i in range(MAX_GOALS + 1)]
    away_pmf = [poisson.pmf(j, lambda_away) for j in range(MAX_GOALS + 1)]

    matrix = [
        [
            dixon_coles_tau(i, j, lambda_home, lambda_away, rho) * home_pmf[i] * away_pmf[j]
            for j in range(MAX_GOALS + 1)
        ]
        for i in range(MAX_GOALS + 1)
    ]

    total = sum(sum(row) for row in matrix)
    if total <= 0:
        raise ValueError("Degenerate score matrix — check input expected-goals rates")
    return [[p / total for p in row] for row in matrix]


def market_probabilities(matrix: list[list[float]]) -> dict[str, float]:
    n = len(matrix)
    home_win = sum(matrix[i][j] for i in range(n) for j in range(n) if i > j)
    draw = sum(matrix[i][j] for i in range(n) for j in range(n) if i == j)
    away_win = sum(matrix[i][j] for i in range(n) for j in range(n) if i < j)

    p_home_0 = sum(matrix[0][j] for j in range(n))
    p_away_0 = sum(matrix[i][0] for i in range(n))
    p_both_0 = matrix[0][0]
    btts_yes = 1 - p_home_0 - p_away_0 + p_both_0

    over_2_5 = sum(matrix[i][j] for i in range(n) for j in range(n) if i + j >= 3)

    # Double chance is just a relabeling of the 1x2 outcome probabilities
    # (each selection covers two of the three 1x2 results) — no separate
    # model, so it can only ever be as accurate as the 1x2 probabilities
    # it's built from.
    home_or_draw = home_win + draw
    home_or_away = home_win + away_win
    draw_or_away = draw + away_win

    # Clean sheet: p_home_0/p_away_0 above are already "this side conceded
    # zero" — home_clean_sheet is literally p_away_0 (away failed to score
    # against them), and vice versa.
    home_clean_sheet = p_away_0
    away_clean_sheet = p_home_0

    even_goals = sum(matrix[i][j] for i in range(n) for j in range(n) if (i + j) % 2 == 0)

    # Draw no bet: home/away renormalized over the non-draw outcomes only —
    # "what if the draw didn't exist" rather than a separate model. Division
    # is safe here: home_win + away_win == 0 would need draw == 1, i.e. a
    # degenerate matrix score_matrix() already rejects before this runs.
    non_draw = home_win + away_win
    draw_no_bet_home = home_win / non_draw
    draw_no_bet_away = away_win / non_draw

    return {
        "home_win": home_win,
        "draw": draw,
        "away_win": away_win,
        "btts_yes": btts_yes,
        "btts_no": 1 - btts_yes,
        "over_2_5": over_2_5,
        "under_2_5": 1 - over_2_5,
        "home_or_draw": home_or_draw,
        "home_or_away": home_or_away,
        "draw_or_away": draw_or_away,
        "home_clean_sheet_yes": home_clean_sheet,
        "home_clean_sheet_no": 1 - home_clean_sheet,
        "away_clean_sheet_yes": away_clean_sheet,
        "away_clean_sheet_no": 1 - away_clean_sheet,
        "even_goals": even_goals,
        "odd_goals": 1 - even_goals,
        "draw_no_bet_home": draw_no_bet_home,
        "draw_no_bet_away": draw_no_bet_away,
    }


def top_correct_scores(matrix: list[list[float]], n: int = 10) -> list[tuple[int, int, float]]:
    """Returns the `n` most probable exact scorelines as (home_goals, away_goals,
    probability), sorted by probability descending (ties broken by fewest total
    goals, then by home_goals, for a deterministic order).

    The full grid has (MAX_GOALS + 1)^2 = 121 cells; the overwhelming majority
    carry negligible probability for realistic football lambdas, so only the
    top `n` are surfaced as individual "correct score" selections — the caller
    is responsible for reporting the remaining probability mass as a single
    "other" selection rather than silently dropping it (see main.py).
    """
    cells = [
        (home_goals, away_goals, matrix[home_goals][away_goals])
        for home_goals in range(len(matrix))
        for away_goals in range(len(matrix[0]))
    ]
    cells.sort(key=lambda c: (-c[2], c[0] + c[1], c[0]))
    return cells[:n]


def btts_and_result_probabilities(matrix: list[list[float]]) -> dict[str, float]:
    """Joint probability of (both teams scored, match result) — 6 selections.

    Genuinely joint, not the product of the marginals: BTTS and match result
    are correlated through the same scoreline (e.g. a 1-0 home win can never
    be BTTS=yes), so this sums matrix cells directly rather than multiplying
    btts_yes * home_win the way an *independent* combination would.
    """
    n = len(matrix)
    probs = {f"{btts}_{result}": 0.0 for btts in ("yes", "no") for result in ("home", "draw", "away")}
    for i in range(n):
        for j in range(n):
            btts = "yes" if i >= 1 and j >= 1 else "no"
            result = "home" if i > j else "draw" if i == j else "away"
            probs[f"{btts}_{result}"] += matrix[i][j]
    return probs


def result_and_total_goals_probabilities(matrix: list[list[float]], line: float = 2.5) -> dict[str, float]:
    """Joint probability of (match result, total goals over/under `line`) —
    6 selections. Same joint-not-independent reasoning as
    btts_and_result_probabilities. `line` is expected to be a half-integer
    (matching over_under_2_5's own line) so there's no exact-total edge case."""
    n = len(matrix)
    threshold = line  # e.g. 2.5: total >= 3 is "over"
    probs = {f"{result}_{ou}": 0.0 for result in ("home", "draw", "away") for ou in ("over", "under")}
    for i in range(n):
        for j in range(n):
            result = "home" if i > j else "draw" if i == j else "away"
            ou = "over" if (i + j) > threshold else "under"
            probs[f"{result}_{ou}"] += matrix[i][j]
    return probs


def handicap_probabilities(matrix: list[list[float]], home_handicap: float = -1.5) -> dict[str, float]:
    """Two-way Asian handicap: P(home covers), P(away covers), for a fixed
    `home_handicap` applied to the home side's goals before comparing
    (e.g. -1.5 means home needs to win by 2+ goals to cover). A half-integer
    line is used deliberately so there's no push/tie case to handle — every
    scoreline resolves to exactly one side covering, and the two
    probabilities sum to 1 exactly, same shape as every other O/U-style
    market in this service.
    """
    n = len(matrix)
    home_covers = sum(matrix[i][j] for i in range(n) for j in range(n) if (i + home_handicap) > j)
    return {"home": home_covers, "away": 1 - home_covers}


def data_quality_for(home: TeamStrength, away: TeamStrength) -> str:
    min_matches = min(home.matches_played, away.matches_played)
    if min_matches >= 10:
        return "strong"
    if min_matches >= 5:
        return "limited"
    return "insufficient"


def explain_factors(
    home: TeamStrength, away: TeamStrength, lambda_home: float, lambda_away: float
) -> list[dict[str, str]]:
    """Plain-language factors derived directly from the inputs used above —
    never claims about tactics, injuries, or anything this model doesn't
    actually see (spec section 22).

    Each factor is tagged "directional" (argues for the home side, so a
    caller presenting the away side should flip its polarity) or "caveat"
    (a data-quality warning that applies the same way regardless of which
    selection it's attached to, and must never be flipped).
    """
    factors: list[dict[str, str]] = []

    if lambda_home - lambda_away > 0.4:
        factors.append(
            {
                "direction": "positive",
                "label": "Model expects meaningfully more home goals than away goals",
                "kind": "directional",
            }
        )
    elif lambda_away - lambda_home > 0.4:
        factors.append(
            {
                "direction": "negative",
                "label": "Model expects meaningfully more away goals than home goals",
                "kind": "directional",
            }
        )

    if home.goals_conceded_avg < 1.0:
        factors.append(
            {
                "direction": "positive",
                "label": "Home team concedes below one goal per match on average",
                "kind": "directional",
            }
        )
    if away.goals_conceded_avg < 1.0:
        factors.append(
            {
                "direction": "negative",
                "label": "Away team concedes below one goal per match on average",
                "kind": "directional",
            }
        )

    if home.matches_played < 10 or away.matches_played < 10:
        factors.append(
            {
                "direction": "negative",
                "label": "Sample size under 10 matches for at least one team",
                "kind": "caveat",
            }
        )

    return factors
