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
