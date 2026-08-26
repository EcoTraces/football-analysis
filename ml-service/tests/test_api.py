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

    for prediction in body["predictions"]:
        assert 0.0 <= prediction["probability"] <= 1.0


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
