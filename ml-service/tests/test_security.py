from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

ELO_PAYLOAD = {
    "homeTeam": {"rating": 1620, "matchesPlayed": 25},
    "awayTeam": {"rating": 1480, "matchesPlayed": 22},
}


def test_health_never_requires_a_key(monkeypatch):
    # Render's own health-check probe (render.yaml's healthCheckPath) sends
    # no custom headers — /health must stay reachable regardless of whether
    # ML_SERVICE_API_KEY is configured, or a correctly-configured deploy
    # looks down to Render.
    monkeypatch.setenv("ML_SERVICE_API_KEY", "prod-secret")
    res = client.get("/health")
    assert res.status_code == 200


def test_model_endpoint_open_when_no_key_configured(monkeypatch):
    monkeypatch.delenv("ML_SERVICE_API_KEY", raising=False)
    res = client.post("/predict/elo", json=ELO_PAYLOAD)
    assert res.status_code == 200


def test_model_endpoint_rejects_missing_header_when_key_configured(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_API_KEY", "prod-secret")
    res = client.post("/predict/elo", json=ELO_PAYLOAD)
    assert res.status_code == 401


def test_model_endpoint_rejects_wrong_key(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_API_KEY", "prod-secret")
    res = client.post("/predict/elo", json=ELO_PAYLOAD, headers={"X-API-Key": "wrong"})
    assert res.status_code == 401


def test_model_endpoint_accepts_correct_key(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_API_KEY", "prod-secret")
    res = client.post("/predict/elo", json=ELO_PAYLOAD, headers={"X-API-Key": "prod-secret"})
    assert res.status_code == 200
