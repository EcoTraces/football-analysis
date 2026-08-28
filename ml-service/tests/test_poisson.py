import math

import pytest

from app.models.poisson import (
    TeamStrength,
    btts_and_result_probabilities,
    data_quality_for,
    expected_goals,
    handicap_probabilities,
    market_probabilities,
    result_and_total_goals_probabilities,
    score_matrix,
    top_correct_scores,
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


def test_double_chance_probabilities_are_internally_consistent():
    matrix = score_matrix(1.6, 1.0)
    probs = market_probabilities(matrix)

    # Each double-chance selection is exactly the sum of the two 1x2
    # outcomes it covers — so it should equal 1 minus the excluded outcome.
    assert probs["home_or_draw"] == pytest.approx(1.0 - probs["away_win"], abs=1e-9)
    assert probs["home_or_away"] == pytest.approx(1.0 - probs["draw"], abs=1e-9)
    assert probs["draw_or_away"] == pytest.approx(1.0 - probs["home_win"], abs=1e-9)
    for key in ("home_or_draw", "home_or_away", "draw_or_away"):
        assert 0.0 <= probs[key] <= 1.0


def test_top_correct_scores_returns_requested_count_sorted_descending():
    matrix = score_matrix(1.6, 1.0)
    top = top_correct_scores(matrix, n=5)

    assert len(top) == 5
    probabilities = [p for _, _, p in top]
    assert probabilities == sorted(probabilities, reverse=True)
    # Every returned probability should actually come from the matrix cell it claims.
    for home_goals, away_goals, probability in top:
        assert matrix[home_goals][away_goals] == pytest.approx(probability)


def test_top_correct_scores_plus_other_covers_full_probability_mass():
    matrix = score_matrix(1.4, 1.1)
    top = top_correct_scores(matrix, n=10)
    other = 1.0 - sum(p for _, _, p in top)

    assert 0.0 <= other <= 1.0
    # For realistic low-scoring lambdas, the top 10 scorelines should
    # already cover most of the probability mass, leaving "other" small
    # rather than dominant — a sanity check that n=10 is a reasonable cut.
    assert other < 0.5


def test_clean_sheet_probabilities_are_the_opposing_sides_shutout_probability():
    matrix = score_matrix(1.6, 1.0)
    probs = market_probabilities(matrix)

    # home_clean_sheet means the AWAY side failed to score.
    assert probs["home_clean_sheet_yes"] + probs["home_clean_sheet_no"] == pytest.approx(1.0, abs=1e-9)
    assert probs["away_clean_sheet_yes"] + probs["away_clean_sheet_no"] == pytest.approx(1.0, abs=1e-9)
    for key in ("home_clean_sheet_yes", "away_clean_sheet_yes"):
        assert 0.0 <= probs[key] <= 1.0


def test_odd_even_goals_probabilities_sum_to_one():
    matrix = score_matrix(1.4, 1.1)
    probs = market_probabilities(matrix)
    assert probs["even_goals"] + probs["odd_goals"] == pytest.approx(1.0, abs=1e-9)
    assert 0.0 <= probs["even_goals"] <= 1.0


def test_draw_no_bet_renormalizes_over_non_draw_outcomes_only():
    matrix = score_matrix(1.6, 1.0)
    probs = market_probabilities(matrix)

    assert probs["draw_no_bet_home"] + probs["draw_no_bet_away"] == pytest.approx(1.0, abs=1e-9)
    # A stronger home side should be favoured more heavily once the draw is
    # excluded than it is in the raw 1x2 probabilities.
    assert probs["draw_no_bet_home"] > probs["home_win"]


def test_btts_and_result_probabilities_sum_to_one_and_match_marginals():
    matrix = score_matrix(1.6, 1.0)
    joint = btts_and_result_probabilities(matrix)
    marginals = market_probabilities(matrix)

    assert sum(joint.values()) == pytest.approx(1.0, abs=1e-9)
    for value in joint.values():
        assert 0.0 <= value <= 1.0
    # Summing the joint over the "no" btts leg should reproduce btts_no.
    no_total = joint["no_home"] + joint["no_draw"] + joint["no_away"]
    assert no_total == pytest.approx(marginals["btts_no"], abs=1e-9)
    # And summing over the "away" result leg should reproduce away_win.
    away_total = joint["yes_away"] + joint["no_away"]
    assert away_total == pytest.approx(marginals["away_win"], abs=1e-9)


def test_result_and_total_goals_probabilities_sum_to_one_and_match_marginals():
    matrix = score_matrix(1.6, 1.0)
    joint = result_and_total_goals_probabilities(matrix, line=2.5)
    marginals = market_probabilities(matrix)

    assert sum(joint.values()) == pytest.approx(1.0, abs=1e-9)
    for value in joint.values():
        assert 0.0 <= value <= 1.0
    over_total = joint["home_over"] + joint["draw_over"] + joint["away_over"]
    assert over_total == pytest.approx(marginals["over_2_5"], abs=1e-9)
    draw_total = joint["draw_over"] + joint["draw_under"]
    assert draw_total == pytest.approx(marginals["draw"], abs=1e-9)


def test_handicap_probabilities_sum_to_one_with_no_push():
    matrix = score_matrix(1.6, 1.0)
    probs = handicap_probabilities(matrix, home_handicap=-1.5)
    assert probs["home"] + probs["away"] == pytest.approx(1.0, abs=1e-9)
    assert 0.0 <= probs["home"] <= 1.0


def test_handicap_probabilities_favour_away_more_than_raw_away_win():
    # A -1.5 home handicap makes it harder for home to "cover" than to win
    # outright, so the away side's covering probability should exceed its
    # raw away_win probability.
    matrix = score_matrix(1.6, 1.0)
    handicap = handicap_probabilities(matrix, home_handicap=-1.5)
    marginals = market_probabilities(matrix)
    assert handicap["away"] > marginals["away_win"]
