import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_predict_poisson_returns_all_markets():
    payload = {
        "homeTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.8, "goalsConcededAvg": 0.9},
        "awayTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.2, "goalsConcededAvg": 1.3},
        "leagueAvgHomeGoals": 1.5,
        "leagueAvgAwayGoals": 1.1,
    }
    res = client.post("/predict/poisson", json=payload)
    assert res.status_code == 200

    body = res.json()
    assert body["modelName"] == "poisson-baseline"
    assert body["dataQuality"] in {"insufficient", "limited", "strong"}

    markets = {(p["market"], p["selection"]) for p in body["predictions"]}
    assert ("1x2", "home") in markets
    assert ("1x2", "draw") in markets
    assert ("1x2", "away") in markets
    assert ("btts", "yes") in markets
    assert ("over_under_2_5", "over") in markets
    assert ("double_chance", "home_or_draw") in markets
    assert ("double_chance", "home_or_away") in markets
    assert ("double_chance", "draw_or_away") in markets
    assert ("correct_score", "other") in markets

    for prediction in body["predictions"]:
        assert 0.0 <= prediction["probability"] <= 1.0

    correct_score_predictions = [p for p in body["predictions"] if p["market"] == "correct_score"]
    # 10 exact scorelines + the "other" bucket covering the rest.
    assert len(correct_score_predictions) == 11
    assert sum(p["probability"] for p in correct_score_predictions) == pytest.approx(1.0, abs=1e-6)

    # No cards/corners averages were sent — no fabricated market for either.
    assert not any(m == "total_cards" for m, _ in markets)
    assert not any(m == "total_corners" for m, _ in markets)

    # Half-based markets always appear — no optional data needed for them.
    assert ("first_half_result", "home") in markets
    assert ("first_half_result", "draw") in markets
    assert ("first_half_result", "away") in markets
    assert ("second_half_result", "home") in markets
    assert ("half_with_most_goals", "first_half") in markets
    assert ("half_with_most_goals", "second_half") in markets
    assert ("half_with_most_goals", "equal") in markets

    for market_name in ("first_half_result", "second_half_result", "half_with_most_goals"):
        market_predictions = [p for p in body["predictions"] if p["market"] == market_name]
        assert len(market_predictions) == 3
        assert sum(p["probability"] for p in market_predictions) == pytest.approx(1.0, abs=1e-6)

    # No player lists were sent — no fabricated anytime-goalscorer market either.
    assert not any(m == "home_anytime_goalscorer" for m, _ in markets)
    assert not any(m == "away_anytime_goalscorer" for m, _ in markets)

    # The 8 newest derived markets — all always computed, no optional data needed.
    assert ("home_clean_sheet", "yes") in markets
    assert ("away_clean_sheet", "yes") in markets
    assert ("odd_even_goals", "even") in markets
    assert ("odd_even_goals", "odd") in markets
    assert ("draw_no_bet", "home") in markets
    assert ("draw_no_bet", "away") in markets
    assert ("handicap", "home") in markets
    assert ("handicap", "away") in markets
    assert ("home_team_total_goals", "over") in markets
    assert ("away_team_total_goals", "over") in markets
    assert ("home_wins_a_half", "yes") in markets
    assert ("away_wins_a_half", "yes") in markets

    for two_way_market in (
        "home_clean_sheet",
        "away_clean_sheet",
        "odd_even_goals",
        "draw_no_bet",
        "handicap",
        "home_team_total_goals",
        "away_team_total_goals",
        "home_wins_a_half",
        "away_wins_a_half",
    ):
        rows = [p for p in body["predictions"] if p["market"] == two_way_market]
        assert len(rows) == 2
        assert sum(p["probability"] for p in rows) == pytest.approx(1.0, abs=1e-6)

    # btts_and_result and result_and_total_goals are each a 6-way joint
    # market that sums to 1 (unlike anytime-goalscorer/wins-a-half, which
    # are independent per-side probabilities that don't).
    for joint_market in ("btts_and_result", "result_and_total_goals"):
        rows = [p for p in body["predictions"] if p["market"] == joint_market]
        assert len(rows) == 6
        assert sum(p["probability"] for p in rows) == pytest.approx(1.0, abs=1e-6)


def test_predict_poisson_includes_anytime_goalscorer_only_for_sides_with_players_sent():
    payload = {
        "homeTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.8, "goalsConcededAvg": 0.9},
        "awayTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.2, "goalsConcededAvg": 1.3},
        "leagueAvgHomeGoals": 1.5,
        "leagueAvgAwayGoals": 1.1,
        "homeTeamPlayers": [
            {"name": "Home Striker", "goalsScored": 12, "matchesPlayed": 15},
            {"name": "Home Winger", "goalsScored": 5, "matchesPlayed": 14},
            {"name": "Home Bench", "goalsScored": 1, "matchesPlayed": 2},  # below MIN_APPEARANCES
        ],
        # awayTeamPlayers deliberately omitted
    }
    res = client.post("/predict/poisson", json=payload)
    assert res.status_code == 200

    body = res.json()
    home_scorer_predictions = [p for p in body["predictions"] if p["market"] == "home_anytime_goalscorer"]
    away_scorer_predictions = [p for p in body["predictions"] if p["market"] == "away_anytime_goalscorer"]

    names = {p["selection"] for p in home_scorer_predictions}
    assert "Home Striker" in names
    assert "Home Winger" in names
    assert "Home Bench" not in names  # too few appearances

    for p in home_scorer_predictions:
        assert 0.0 < p["probability"] < 1.0
        assert p["factors"] == []

    # These are independent probabilities, not mutually exclusive selections
    # — deliberately NOT asserting they sum to 1 (see player_market.py).
    assert away_scorer_predictions == []  # no away players sent at all


def test_predict_poisson_omits_anytime_goalscorer_for_a_team_with_no_recorded_goals():
    payload = {
        "homeTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.8, "goalsConcededAvg": 0.9},
        "awayTeam": {"matchesPlayed": 0, "goalsScoredAvg": 0, "goalsConcededAvg": 0},
        "leagueAvgHomeGoals": 1.5,
        "leagueAvgAwayGoals": 1.1,
        "awayTeamPlayers": [{"name": "New Signing", "goalsScored": 0, "matchesPlayed": 0}],
    }
    res = client.post("/predict/poisson", json=payload)
    assert res.status_code == 200
    markets = {p["market"] for p in res.json()["predictions"]}
    assert "away_anytime_goalscorer" not in markets


def test_predict_poisson_includes_cards_and_corners_only_when_both_teams_averages_are_sent():
    base_payload = {
        "homeTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.8, "goalsConcededAvg": 0.9},
        "awayTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.2, "goalsConcededAvg": 1.3},
        "leagueAvgHomeGoals": 1.5,
        "leagueAvgAwayGoals": 1.1,
    }

    # Both teams' cards averages present, corners entirely absent.
    res = client.post(
        "/predict/poisson",
        json={**base_payload, "homeTeamAvgYellowCards": 2.1, "awayTeamAvgYellowCards": 1.8},
    )
    assert res.status_code == 200
    markets = {(p["market"], p["selection"]) for p in res.json()["predictions"]}
    assert ("total_cards", "over") in markets
    assert ("total_cards", "under") in markets
    assert not any(m == "total_corners" for m, _ in markets)

    cards_predictions = [p for p in res.json()["predictions"] if p["market"] == "total_cards"]
    assert sum(p["probability"] for p in cards_predictions) == pytest.approx(1.0, abs=1e-9)

    # Both teams' corners averages present too.
    res2 = client.post(
        "/predict/poisson",
        json={
            **base_payload,
            "homeTeamAvgYellowCards": 2.1,
            "awayTeamAvgYellowCards": 1.8,
            "homeTeamAvgCorners": 5.5,
            "awayTeamAvgCorners": 4.2,
        },
    )
    assert res2.status_code == 200
    markets2 = {(p["market"], p["selection"]) for p in res2.json()["predictions"]}
    assert ("total_corners", "over") in markets2
    assert ("total_corners", "under") in markets2

    corners_predictions = [p for p in res2.json()["predictions"] if p["market"] == "total_corners"]
    assert sum(p["probability"] for p in corners_predictions) == pytest.approx(1.0, abs=1e-9)


def test_predict_poisson_omits_cards_when_only_one_teams_average_is_sent():
    res = client.post(
        "/predict/poisson",
        json={
            "homeTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.8, "goalsConcededAvg": 0.9},
            "awayTeam": {"matchesPlayed": 15, "goalsScoredAvg": 1.2, "goalsConcededAvg": 1.3},
            "leagueAvgHomeGoals": 1.5,
            "leagueAvgAwayGoals": 1.1,
            "homeTeamAvgYellowCards": 2.1,
            # awayTeamAvgYellowCards deliberately omitted
        },
    )
    assert res.status_code == 200
    markets = {p["market"] for p in res.json()["predictions"]}
    assert "total_cards" not in markets


def test_predict_poisson_rejects_invalid_input():
    res = client.post(
        "/predict/poisson",
        json={
            "homeTeam": {"matchesPlayed": -1, "goalsScoredAvg": 1.0, "goalsConcededAvg": 1.0},
            "awayTeam": {"matchesPlayed": 10, "goalsScoredAvg": 1.0, "goalsConcededAvg": 1.0},
            "leagueAvgHomeGoals": 1.5,
            "leagueAvgAwayGoals": 1.1,
        },
    )
    assert res.status_code == 422


STRONG_TEAM = {"matchesPlayed": 20, "goalsScoredAvg": 2.5, "goalsConcededAvg": 0.5}
WEAK_TEAM = {"matchesPlayed": 20, "goalsScoredAvg": 0.5, "goalsConcededAvg": 2.5}
EVEN_TEAM = {"matchesPlayed": 20, "goalsScoredAvg": 1.2, "goalsConcededAvg": 1.2}


def _training_row(home: dict, away: dict, outcome: str) -> dict:
    return {"homeTeam": home, "awayTeam": away, "outcome": outcome}


def test_predict_gradient_boosting_before_training_returns_409_not_a_fabricated_guess():
    res = client.post("/predict/gradient_boosting", json={"homeTeam": STRONG_TEAM, "awayTeam": WEAK_TEAM})
    assert res.status_code == 409


def test_train_gradient_boosting_rejects_too_few_rows():
    rows = [_training_row(STRONG_TEAM, WEAK_TEAM, "home")] * 5
    res = client.post("/train/gradient_boosting", json={"rows": rows})
    assert res.status_code == 422


def test_train_then_predict_gradient_boosting_round_trip():
    rows = (
        [_training_row(STRONG_TEAM, WEAK_TEAM, "home")] * 10
        + [_training_row(WEAK_TEAM, STRONG_TEAM, "away")] * 10
        + [_training_row(EVEN_TEAM, EVEN_TEAM, "draw")] * 10
    )
    train_res = client.post("/train/gradient_boosting", json={"rows": rows})
    assert train_res.status_code == 200
    train_body = train_res.json()
    assert train_body["sampleSize"] == 30
    assert train_body["classCounts"] == {"home": 10, "draw": 10, "away": 10}
    assert 0.0 <= train_body["trainAccuracy"] <= 1.0

    predict_res = client.post("/predict/gradient_boosting", json={"homeTeam": STRONG_TEAM, "awayTeam": WEAK_TEAM})
    assert predict_res.status_code == 200
    body = predict_res.json()
    assert body["modelName"] == "gradient-boosting"
    assert body["dataQuality"] in {"insufficient", "limited", "strong"}

    predictions = {p["selection"]: p["probability"] for p in body["predictions"]}
    assert set(predictions.keys()) == {"home", "draw", "away"}
    assert sum(predictions.values()) == pytest.approx(1.0, abs=1e-6)
    assert predictions["home"] > predictions["away"]  # learned the separable training pattern


def test_rho_status_defaults_to_no_fitted_value():
    res = client.get("/rho_status")
    assert res.status_code == 200
    body = res.json()
    assert body["fittedRho"] is None
    assert body["defaultRho"] == -0.1


def _rho_fitting_row(home: dict, away: dict, home_goals: int, away_goals: int) -> dict:
    return {"homeTeam": home, "awayTeam": away, "actualHomeGoals": home_goals, "actualAwayGoals": away_goals}


def test_fit_dixon_coles_rho_rejects_too_few_informative_matches():
    # 3-2 is never one of the four rho-sensitive scorelines, no matter how many there are.
    rows = [_rho_fitting_row(STRONG_TEAM, WEAK_TEAM, 3, 2)] * 50
    res = client.post("/fit/dixon_coles_rho", json={"leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1, "rows": rows})
    assert res.status_code == 422


def test_fit_dixon_coles_rho_updates_rho_status_and_subsequent_poisson_predictions():
    # Skewed hard toward 0-0/1-1 — enough to pull the fitted rho well away
    # from the fixed -0.1 default, so its effect on later predictions is
    # unambiguous rather than lost in noise.
    rows = [_rho_fitting_row(EVEN_TEAM, EVEN_TEAM, 0, 0)] * 20 + [_rho_fitting_row(EVEN_TEAM, EVEN_TEAM, 1, 1)] * 20

    prediction_payload = {"homeTeam": EVEN_TEAM, "awayTeam": EVEN_TEAM, "leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1}
    before = client.post("/predict/poisson", json=prediction_payload).json()
    zero_zero_before = next(p["probability"] for p in before["predictions"] if p["market"] == "correct_score" and p["selection"] == "0-0")

    fit_res = client.post("/fit/dixon_coles_rho", json={"leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1, "rows": rows})
    assert fit_res.status_code == 200
    fit_body = fit_res.json()
    assert fit_body["sampleSize"] == 40
    assert fit_body["informativeMatches"] == 40
    assert fit_body["defaultRho"] == -0.1
    assert fit_body["fittedRho"] < -0.1  # more negative than the default — expected, given the 0-0/1-1-only training data

    status = client.get("/rho_status").json()
    assert status["fittedRho"] == pytest.approx(fit_body["fittedRho"])

    after = client.post("/predict/poisson", json=prediction_payload).json()
    zero_zero_after = next(p["probability"] for p in after["predictions"] if p["market"] == "correct_score" and p["selection"] == "0-0")

    # A more negative rho pushes more probability mass onto 0-0 (see
    # rho_fitting.py's module docstring / poisson.py's dixon_coles_tau) —
    # the fit must actually be in effect for later predictions, not just
    # reported back in the fit response.
    assert zero_zero_after > zero_zero_before


def test_fit_dixon_coles_rho_with_apply_globally_false_leaves_the_global_fallback_untouched():
    # A competition-scoped fit (backend passes applyGlobally=False) must
    # never leak into every other competition's predictions.
    rows = [_rho_fitting_row(EVEN_TEAM, EVEN_TEAM, 0, 0)] * 20 + [_rho_fitting_row(EVEN_TEAM, EVEN_TEAM, 1, 1)] * 20

    fit_res = client.post(
        "/fit/dixon_coles_rho",
        json={"leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1, "rows": rows, "applyGlobally": False},
    )
    assert fit_res.status_code == 200
    fit_body = fit_res.json()
    assert fit_body["fittedRho"] < -0.1  # the fit itself still ran and returned a real result

    status = client.get("/rho_status").json()
    assert status["fittedRho"] is None  # ...but the process-wide fallback never moved

    prediction_payload = {"homeTeam": EVEN_TEAM, "awayTeam": EVEN_TEAM, "leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1}
    predict_res = client.post("/predict/poisson", json=prediction_payload).json()
    zero_zero = next(p["probability"] for p in predict_res["predictions"] if p["market"] == "correct_score" and p["selection"] == "0-0")
    # Still using the fixed -0.1 default — not the competition-scoped fit.
    default_matrix_res = client.post("/predict/poisson", json={**prediction_payload, "rho": -0.1}).json()
    zero_zero_at_default = next(
        p["probability"] for p in default_matrix_res["predictions"] if p["market"] == "correct_score" and p["selection"] == "0-0"
    )
    assert zero_zero == pytest.approx(zero_zero_at_default)


def test_predict_poisson_accepts_a_per_request_rho_override():
    payload = {"homeTeam": EVEN_TEAM, "awayTeam": EVEN_TEAM, "leagueAvgHomeGoals": 1.5, "leagueAvgAwayGoals": 1.1}

    default_res = client.post("/predict/poisson", json=payload).json()
    overridden_res = client.post("/predict/poisson", json={**payload, "rho": -0.4}).json()

    def zero_zero(body: dict) -> float:
        return next(p["probability"] for p in body["predictions"] if p["market"] == "correct_score" and p["selection"] == "0-0")

    # A more negative rho than the -0.1 default pushes more mass onto 0-0
    # (same direction as the module-level fit tests above) — proves the
    # override actually reaches score_matrix(), not just accepted and ignored.
    assert zero_zero(overridden_res) > zero_zero(default_res)
