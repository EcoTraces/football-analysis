import pytest

from app.models.ensemble import (
    combine_components,
    compute_ev_and_edge,
    consensus_level,
    devig_market_probabilities,
    injury_adjustment,
    overall_data_quality,
    risk_tier,
    selection_score,
)

WEIGHTS = {"elo": 0.2667, "poisson": 0.2000, "form": 0.2000, "home_away": 0.1333, "injuries": 0.1333, "market": 0.0667}

SCORE_WEIGHTS = {"ensemble_confidence": 0.40, "ev": 0.30, "consensus": 0.20, "data_quality": 0.10}

RISK_THRESHOLDS = {"elite_min": 85, "strong_min": 70, "medium_min": 50, "high_risk_min": 30}


def test_combine_components_all_present_sums_to_one():
    components = {
        "elo": {"home": 0.5, "draw": 0.25, "away": 0.25},
        "poisson": {"home": 0.45, "draw": 0.3, "away": 0.25},
        "form": {"home": 0.4, "draw": 0.3, "away": 0.3},
        "home_away": {"home": 0.5, "draw": 0.2, "away": 0.3},
        "injuries": {"home": 0.4, "draw": 0.33, "away": 0.27},
        "market": {"home": 0.42, "draw": 0.28, "away": 0.3},
    }
    combined, weights_used = combine_components(components, WEIGHTS)
    assert sum(combined.values()) == pytest.approx(1.0, abs=1e-9)
    assert sum(weights_used.values()) == pytest.approx(1.0, abs=1e-9)
    assert weights_used == WEIGHTS  # nothing missing -> no redistribution needed


def test_combine_components_missing_component_redistributes_weight():
    components = {
        "elo": {"home": 0.6, "draw": 0.2, "away": 0.2},
        "poisson": {"home": 0.6, "draw": 0.2, "away": 0.2},
    }
    combined, weights_used = combine_components(components, WEIGHTS)
    assert sum(combined.values()) == pytest.approx(1.0, abs=1e-9)
    assert sum(weights_used.values()) == pytest.approx(1.0, abs=1e-9)
    assert set(weights_used.keys()) == {"elo", "poisson"}
    # Original relative proportion between elo/poisson is preserved.
    assert weights_used["elo"] / weights_used["poisson"] == pytest.approx(WEIGHTS["elo"] / WEIGHTS["poisson"])
    # Both present components agree completely -> combined equals their shared triple.
    assert combined["home"] == pytest.approx(0.6, abs=1e-9)


def test_combine_components_raises_when_nothing_present():
    with pytest.raises(ValueError):
        combine_components({}, WEIGHTS)


def test_combine_components_raises_when_only_unweighted_components_present():
    with pytest.raises(ValueError):
        combine_components({"unknown_component": {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}}, WEIGHTS)


def test_devig_market_probabilities_removes_overround():
    # A typical over-round book: implied probabilities sum to > 1 before devigging.
    odds = {"home": 2.0, "draw": 3.4, "away": 4.0}
    probs = devig_market_probabilities(odds)
    assert sum(probs.values()) == pytest.approx(1.0, abs=1e-9)
    assert probs["home"] > probs["draw"] > probs["away"]


def test_devig_market_probabilities_rejects_degenerate_odds():
    with pytest.raises(ValueError):
        devig_market_probabilities({"home": 0, "draw": 0, "away": 0})


def test_injury_adjustment_favours_less_depleted_side():
    adjustment = injury_adjustment(home_key_absences=0, away_key_absences=3)
    assert adjustment["home"] > 1 / 3
    assert adjustment["away"] < 1 / 3
    assert sum(adjustment.values()) == pytest.approx(1.0, abs=1e-9)


def test_injury_adjustment_symmetric_when_equal():
    adjustment = injury_adjustment(home_key_absences=2, away_key_absences=2)
    assert adjustment["home"] == pytest.approx(adjustment["away"], abs=1e-9)


def test_injury_adjustment_shift_is_capped():
    adjustment = injury_adjustment(home_key_absences=0, away_key_absences=20)
    assert adjustment["home"] <= 1 / 3 + 0.15 + 1e-9


def test_consensus_level_high_when_components_agree_tightly():
    combined = {"home": 0.55, "draw": 0.25, "away": 0.2}
    components = {
        "elo": {"home": 0.53, "draw": 0.26, "away": 0.21},
        "poisson": {"home": 0.57, "draw": 0.24, "away": 0.19},
        "form": {"home": 0.55, "draw": 0.25, "away": 0.2},
    }
    assert consensus_level(components, combined) == "high"


def test_consensus_level_conflicting_when_favourites_differ_widely():
    combined = {"home": 0.4, "draw": 0.25, "away": 0.35}
    components = {
        "elo": {"home": 0.7, "draw": 0.15, "away": 0.15},
        "poisson": {"home": 0.15, "draw": 0.15, "away": 0.7},
    }
    assert consensus_level(components, combined) == "conflicting"


def test_consensus_level_low_with_single_component():
    combined = {"home": 0.6, "draw": 0.2, "away": 0.2}
    components = {"elo": {"home": 0.6, "draw": 0.2, "away": 0.2}}
    assert consensus_level(components, combined) == "low"


def test_overall_data_quality_takes_the_worst():
    assert overall_data_quality({"elo": "strong", "poisson": "insufficient"}) == "insufficient"
    assert overall_data_quality({"elo": "strong", "poisson": "limited"}) == "limited"
    assert overall_data_quality({"elo": "strong", "poisson": "strong"}) == "strong"


def test_overall_data_quality_rejects_empty_input():
    with pytest.raises(ValueError):
        overall_data_quality({})


def test_compute_ev_and_edge_none_when_no_odds():
    ev, edge = compute_ev_and_edge(0.55, None)
    assert ev is None
    assert edge is None


def test_compute_ev_and_edge_positive_when_model_beats_market():
    # Model says 60%, market implies 50% (odds of 2.0) -> positive edge/EV.
    ev, edge = compute_ev_and_edge(0.6, 2.0)
    assert edge == pytest.approx(10.0, abs=1e-9)
    assert ev == pytest.approx(0.2, abs=1e-9)


def test_compute_ev_and_edge_negative_when_model_below_market():
    ev, edge = compute_ev_and_edge(0.4, 2.0)
    assert edge < 0
    assert ev < 0


def test_selection_score_bounded_0_100():
    score = selection_score(0.9, 0.5, "high", "strong", SCORE_WEIGHTS)
    assert 0 <= score <= 100
    score_low = selection_score(0.1, -0.5, "conflicting", "insufficient", SCORE_WEIGHTS)
    assert 0 <= score_low <= 100
    assert score > score_low


def test_selection_score_neutral_ev_when_odds_unavailable():
    with_neutral_ev = selection_score(0.5, None, "moderate", "limited", SCORE_WEIGHTS)
    with_zero_ev = selection_score(0.5, 0.0, "moderate", "limited", SCORE_WEIGHTS)
    assert with_neutral_ev == pytest.approx(with_zero_ev, abs=1e-9)


def test_risk_tier_thresholds():
    assert risk_tier(90, RISK_THRESHOLDS) == "elite"
    assert risk_tier(85, RISK_THRESHOLDS) == "elite"
    assert risk_tier(75, RISK_THRESHOLDS) == "strong"
    assert risk_tier(55, RISK_THRESHOLDS) == "medium"
    assert risk_tier(35, RISK_THRESHOLDS) == "high_risk"
    assert risk_tier(10, RISK_THRESHOLDS) == "avoid"
