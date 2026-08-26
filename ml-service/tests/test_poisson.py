import math

import pytest

from app.models.poisson import (
    TeamStrength,
    data_quality_for,
    expected_goals,
    market_probabilities,
    score_matrix,
)

LEAGUE_AVG_HOME = 1.5
LEAGUE_AVG_AWAY = 1.1


def test_expected_goals_average_teams_reproduce_league_average():
    # Two teams exactly at the league average should reproduce it.
    home = TeamStrength(matches_played=20, goals_scored_avg=LEAGUE_AVG_HOME, goals_conceded_avg=LEAGUE_AVG_AWAY)
    away = TeamStrength(matches_played=20, goals_scored_avg=LEAGUE_AVG_AWAY, goals_conceded_avg=LEAGUE_AVG_HOME)

    lam_home, lam_away = expected_goals(home, away, LEAGUE_AVG_HOME, LEAGUE_AVG_AWAY)

    assert lam_home == pytest.approx(LEAGUE_AVG_HOME, rel=1e-6)
    assert lam_away == pytest.approx(LEAGUE_AVG_AWAY, rel=1e-6)


def test_stronger_attack_and_weaker_opposing_defense_increases_expected_goals():
    weak_away_defense = TeamStrength(matches_played=20, goals_scored_avg=0.8, goals_conceded_avg=2.0)
    strong_home_attack = TeamStrength(matches_played=20, goals_scored_avg=2.5, goals_conceded_avg=0.8)

    lam_home, _ = expected_goals(strong_home_attack, weak_away_defense, LEAGUE_AVG_HOME, LEAGUE_AVG_AWAY)

    assert lam_home > LEAGUE_AVG_HOME


def test_score_matrix_sums_to_one():
    matrix = score_matrix(1.4, 1.1)
    total = sum(sum(row) for row in matrix)
    assert total == pytest.approx(1.0, abs=1e-9)


def test_market_probabilities_are_internally_consistent():
    matrix = score_matrix(1.6, 1.0)
    probs = market_probabilities(matrix)

    assert probs["home_win"] + probs["draw"] + probs["away_win"] == pytest.approx(1.0, abs=1e-9)
    assert probs["btts_yes"] + probs["btts_no"] == pytest.approx(1.0, abs=1e-9)
    assert probs["over_2_5"] + probs["under_2_5"] == pytest.approx(1.0, abs=1e-9)
    for value in probs.values():
        assert 0.0 <= value <= 1.0


def test_stronger_home_side_is_favoured():
    strong_home = TeamStrength(matches_played=20, goals_scored_avg=2.2, goals_conceded_avg=0.7)
    weak_away = TeamStrength(matches_played=20, goals_scored_avg=0.7, goals_conceded_avg=2.0)

    lam_home, lam_away = expected_goals(strong_home, weak_away, LEAGUE_AVG_HOME, LEAGUE_AVG_AWAY)
    matrix = score_matrix(lam_home, lam_away)
    probs = market_probabilities(matrix)

    assert probs["home_win"] > probs["away_win"]
    assert probs["home_win"] > probs["draw"]


@pytest.mark.parametrize(
    "home_matches,away_matches,expected",
    [(20, 20, "strong"), (7, 20, "limited"), (3, 20, "insufficient")],
)
def test_data_quality_reflects_smallest_sample(home_matches, away_matches, expected):
    home = TeamStrength(matches_played=home_matches, goals_scored_avg=1.5, goals_conceded_avg=1.0)
    away = TeamStrength(matches_played=away_matches, goals_scored_avg=1.5, goals_conceded_avg=1.0)
    assert data_quality_for(home, away) == expected


def test_expected_goals_never_reaches_zero():
    home = TeamStrength(matches_played=20, goals_scored_avg=0.0, goals_conceded_avg=0.0)
    away = TeamStrength(matches_played=20, goals_scored_avg=0.0, goals_conceded_avg=0.0)
    lam_home, lam_away = expected_goals(home, away, LEAGUE_AVG_HOME, LEAGUE_AVG_AWAY)
    assert lam_home > 0
    assert lam_away > 0
    assert not math.isnan(lam_home)
