import pytest

from app.models.player_market import (
    MAX_CANDIDATES,
    MIN_APPEARANCES,
    PlayerCandidate,
    anytime_scorer_probability,
    top_scorers,
)


def test_top_scorers_excludes_players_below_min_appearances():
    candidates = [
        PlayerCandidate(name="Regular", goals_scored=10, matches_played=MIN_APPEARANCES),
        PlayerCandidate(name="Cameo", goals_scored=5, matches_played=MIN_APPEARANCES - 1),
    ]
    result = top_scorers(candidates)
    names = [c.name for c in result]
    assert "Regular" in names
    assert "Cameo" not in names


def test_top_scorers_excludes_players_with_zero_goals():
    candidates = [PlayerCandidate(name="Defender", goals_scored=0, matches_played=20)]
    assert top_scorers(candidates) == []


def test_top_scorers_sorts_descending_and_caps_at_n():
    candidates = [PlayerCandidate(name=f"Player{i}", goals_scored=float(i), matches_played=10) for i in range(1, 10)]
    result = top_scorers(candidates, n=3)
    assert len(result) == 3
    assert [c.name for c in result] == ["Player9", "Player8", "Player7"]


def test_top_scorers_default_cap_matches_max_candidates():
    candidates = [PlayerCandidate(name=f"Player{i}", goals_scored=float(i), matches_played=10) for i in range(1, 10)]
    assert len(top_scorers(candidates)) == MAX_CANDIDATES


def test_anytime_scorer_probability_is_between_zero_and_one():
    p = anytime_scorer_probability(team_lambda=1.6, team_total_goals=40, player_goals=15)
    assert 0.0 < p < 1.0


def test_anytime_scorer_probability_scales_with_players_share():
    low = anytime_scorer_probability(team_lambda=1.6, team_total_goals=40, player_goals=4)
    high = anytime_scorer_probability(team_lambda=1.6, team_total_goals=40, player_goals=20)
    assert high > low


def test_anytime_scorer_probability_rejects_non_positive_team_total():
    with pytest.raises(ValueError):
        anytime_scorer_probability(team_lambda=1.6, team_total_goals=0, player_goals=5)


def test_anytime_scorer_probability_rejects_negative_player_goals():
    with pytest.raises(ValueError):
        anytime_scorer_probability(team_lambda=1.6, team_total_goals=40, player_goals=-1)


def test_anytime_scorer_probability_zero_goals_gives_zero_probability():
    assert anytime_scorer_probability(team_lambda=1.6, team_total_goals=40, player_goals=0) == pytest.approx(0.0)
