"""Anytime goalscorer market — a genuinely different shape from every other
market in this service.

Every market elsewhere is a set of mutually exclusive selections that sum to
1 (home/draw/away, over/under, ...). This one isn't: "will player X score at
any point" and "will player Y score at any point" are independent events —
both, either, or neither can happen in the same match — so the selections
this module produces are NOT constrained to sum to 1, and callers/tests
should not assume they do.

Known simplification, stated plainly: this does NOT check whether a player
is actually selected, fit, or even still at the club for the specific
fixture being predicted. It ranks a team's own historical top scorers (by
season goals, among players with enough appearances to be meaningful) and
assumes each is as likely to play and score as their season record
suggests. A more accurate version would gate this on confirmed lineups
(this platform already has `lineups`, refreshed close to kickoff) — see
Task.md. This version trades some accuracy for being computable as soon as
a fixture gets any prediction at all, days ahead of kickoff.
"""

import math
from dataclasses import dataclass

MIN_APPEARANCES = 3  # Below this, a player's goals/appearance ratio is too noisy to trust.
MAX_CANDIDATES = 6  # Top N scorers surfaced per team — the rest of a squad is mostly near-zero probabilities not worth listing.


@dataclass
class PlayerCandidate:
    name: str
    goals_scored: float
    matches_played: int


def top_scorers(candidates: list[PlayerCandidate], n: int = MAX_CANDIDATES) -> list[PlayerCandidate]:
    """Ranks eligible candidates (enough appearances, at least one goal) by
    goals scored, descending, returning at most n."""
    eligible = [c for c in candidates if c.matches_played >= MIN_APPEARANCES and c.goals_scored > 0]
    return sorted(eligible, key=lambda c: c.goals_scored, reverse=True)[:n]


def anytime_scorer_probability(team_lambda: float, team_total_goals: float, player_goals: float) -> float:
    """P(this player scores at least once), from an independent-Poisson
    approximation: the player's own historical share of the team's total
    goals scales the team's match-level expected-goals rate down to a
    player-level rate — player_lambda = team_lambda * (player_goals /
    team_total_goals) — and P(X >= 1) = 1 - P(X = 0) = 1 - e^-lambda.

    team_total_goals is the SAME season total the candidate pool's shares
    are computed against (i.e. the team's own goals_scored, not the
    opponent's) — passing the wrong team's total would silently produce a
    meaningless share.
    """
    if team_total_goals <= 0:
        raise ValueError("team_total_goals must be positive")
    if player_goals < 0:
        raise ValueError("player_goals must be non-negative")
    share = player_goals / team_total_goals
    player_lambda = team_lambda * share
    return 1 - math.exp(-player_lambda)
