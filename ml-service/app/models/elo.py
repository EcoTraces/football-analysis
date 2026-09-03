"""Elo-style team-strength model.

This is the stateless, "convert two ratings into a match-outcome
probability" half of the platform's Elo system. Rating *maintenance* — the
chronological replay of finished fixtures and the K-factor update after
each result — is deliberately NOT here: it lives in
backend/src/jobs/computeEloRatings.ts, which recomputes a rating per team
from scratch on a schedule and calls POST /predict/elo once per fixture
actually being screened, not once per historical match (see that file's
module docstring for why the split is this way round).

Classic Elo (as in chess) only produces a single continuous "expected
score" in [0, 1] with no explicit draw outcome. Football has a real,
non-trivial draw rate, so elo_match_probabilities() carves out a draw
probability as a function of how close the two ratings are (closer ratings
-> more draw mass) before splitting the remainder between home and away
using the standard Elo expected-score formula. MAX_DRAW_PROBABILITY and
DRAW_RATING_SPREAD below are fixed, documented approximations — like
poisson.py's RHO, they are not fitted from this platform's own historical
results (no backtest exists yet for this model), so treat this model's
calibration as unverified, not "the" correct football-Elo formula.
"""

import math
from dataclasses import dataclass

DEFAULT_RATING = 1500.0  # Elo's own convention for an unrated/new team.
HOME_ADVANTAGE = 60.0  # Added to the home side's rating before comparing. Fixed, unfitted.
MAX_DRAW_PROBABILITY = 0.30  # Draw probability when the two (adjusted) ratings are equal.
DRAW_RATING_SPREAD = 200.0  # Rating-point scale over which draw probability decays.

MIN_MATCHES_FOR_ELO = 5  # Below this, a team's rating hasn't seen enough
# real results to be trustworthy — mirrors poisson.py's data_quality_for
# "limited" threshold, since a rating built from a handful of matches is no
# more trustworthy than a goals-average built from the same sample.


@dataclass
class TeamElo:
    rating: float
    matches_played: int


def expected_score(rating_a: float, rating_b: float) -> float:
    """Standard Elo expected-score formula: a's probability of the better
    outcome against b, given only the rating gap. This is NOT itself a
    3-way football match probability — see elo_match_probabilities."""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def elo_match_probabilities(home: TeamElo, away: TeamElo) -> dict[str, float]:
    """Converts two Elo ratings into (home, draw, away) probabilities that
    sum to exactly 1. See module docstring for the draw-carve-out approach."""
    adjusted_home_rating = home.rating + HOME_ADVANTAGE
    rating_gap = adjusted_home_rating - away.rating

    expected_home_two_way = expected_score(adjusted_home_rating, away.rating)
    draw = MAX_DRAW_PROBABILITY * math.exp(-((rating_gap / DRAW_RATING_SPREAD) ** 2) / 2)

    home_win = expected_home_two_way * (1 - draw)
    away_win = (1 - expected_home_two_way) * (1 - draw)
    return {"home": home_win, "draw": draw, "away": away_win}


def data_quality_for(home: TeamElo, away: TeamElo) -> str:
    """Same three-tier scheme as poisson.py's data_quality_for, applied to
    matches_played instead of a goals-average sample size — kept as a
    separate function (not a shared import) because the two models measure
    different things and could diverge in future without this one needing
    to change poisson.py's thresholds or vice versa."""
    min_matches = min(home.matches_played, away.matches_played)
    if min_matches >= 10:
        return "strong"
    if min_matches >= MIN_MATCHES_FOR_ELO:
        return "limited"
    return "insufficient"


def explain_factors(home: TeamElo, away: TeamElo) -> list[dict[str, str]]:
    """Plain-language factors derived only from the two ratings and sample
    sizes actually used above — same "directional vs caveat" shape as
    poisson.py's explain_factors, so main.py's existing home/away-flip
    logic (see predict_poisson) applies unchanged to this model's output."""
    factors: list[dict[str, str]] = []

    rating_gap = (home.rating + HOME_ADVANTAGE) - away.rating
    if rating_gap > 75:
        factors.append(
            {
                "direction": "positive",
                "label": "Home team's Elo rating is meaningfully higher, even after home advantage",
                "kind": "directional",
            }
        )
    elif rating_gap < -75:
        factors.append(
            {
                "direction": "negative",
                "label": "Away team's Elo rating is meaningfully higher, despite home advantage",
                "kind": "directional",
            }
        )

    if home.matches_played < 10 or away.matches_played < 10:
        factors.append(
            {
                "direction": "negative",
                "label": "Elo rating is based on fewer than 10 finished matches for at least one team",
                "kind": "caveat",
            }
        )

    return factors
