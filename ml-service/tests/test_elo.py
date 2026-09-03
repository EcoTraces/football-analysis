import pytest

from app.models.elo import (
    TeamElo,
    data_quality_for,
    elo_match_probabilities,
    expected_score,
    explain_factors,
)


def test_expected_score_equal_ratings_is_half():
    assert expected_score(1500, 1500) == pytest.approx(0.5, abs=1e-9)


def test_expected_score_higher_rating_favoured():
    assert expected_score(1700, 1500) > 0.5
    assert expected_score(1500, 1700) < 0.5


def test_expected_score_symmetric():
    a = expected_score(1600, 1450)
    b = expected_score(1450, 1600)
    assert a == pytest.approx(1 - b, abs=1e-9)


def test_elo_match_probabilities_sum_to_one():
    home = TeamElo(rating=1550, matches_played=20)
    away = TeamElo(rating=1480, matches_played=20)
    probs = elo_match_probabilities(home, away)
    assert sum(probs.values()) == pytest.approx(1.0, abs=1e-9)


def test_elo_match_probabilities_favours_stronger_home_side():
    home = TeamElo(rating=1700, matches_played=20)
    away = TeamElo(rating=1450, matches_played=20)
    probs = elo_match_probabilities(home, away)
    assert probs["home"] > probs["away"]
    assert probs["home"] > probs["draw"]


def test_elo_match_probabilities_evenly_matched_has_more_draw_mass():
    # Two evenly-matched sides (after home advantage cancels the gap out
    # only partially) should carry more draw probability than a lopsided
    # matchup between otherwise-identical ratings.
    even = elo_match_probabilities(TeamElo(rating=1500, matches_played=20), TeamElo(rating=1500, matches_played=20))
    lopsided = elo_match_probabilities(
        TeamElo(rating=1900, matches_played=20), TeamElo(rating=1100, matches_played=20)
    )
    assert even["draw"] > lopsided["draw"]


def test_elo_match_probabilities_all_positive():
    probs = elo_match_probabilities(TeamElo(rating=1500, matches_played=20), TeamElo(rating=1500, matches_played=20))
    assert all(p > 0 for p in probs.values())


def test_data_quality_thresholds():
    strong = TeamElo(rating=1500, matches_played=10)
    limited = TeamElo(rating=1500, matches_played=5)
    insufficient = TeamElo(rating=1500, matches_played=4)

    assert data_quality_for(strong, strong) == "strong"
    assert data_quality_for(limited, limited) == "limited"
    assert data_quality_for(insufficient, insufficient) == "insufficient"
    # The weaker side's sample size determines the pair's overall quality.
    assert data_quality_for(strong, insufficient) == "insufficient"


def test_explain_factors_flags_rating_gap_and_low_sample():
    home = TeamElo(rating=1700, matches_played=3)
    away = TeamElo(rating=1450, matches_played=20)
    factors = explain_factors(home, away)

    directions = {f["kind"]: f["direction"] for f in factors}
    assert directions["directional"] == "positive"
    assert directions["caveat"] == "negative"


def test_explain_factors_no_directional_factor_for_close_ratings():
    home = TeamElo(rating=1510, matches_played=20)
    away = TeamElo(rating=1500, matches_played=20)
    factors = explain_factors(home, away)
    assert not any(f["kind"] == "directional" for f in factors)
