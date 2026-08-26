from fastapi import FastAPI, HTTPException

from app.models.poisson import (
    TeamStrength,
    data_quality_for,
    expected_goals,
    explain_factors,
    market_probabilities,
    score_matrix,
)
from app.schemas import Factor, MarketProbability, PoissonPredictionRequest, PoissonPredictionResponse

MODEL_NAME = "poisson-baseline"
MODEL_VERSION = "0.1.0"

app = FastAPI(title="Football Analysis ML Service", version=MODEL_VERSION)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/predict/poisson", response_model=PoissonPredictionResponse)
def predict_poisson(payload: PoissonPredictionRequest) -> PoissonPredictionResponse:
    home = TeamStrength(
        matches_played=payload.home_team.matches_played,
        goals_scored_avg=payload.home_team.goals_scored_avg,
        goals_conceded_avg=payload.home_team.goals_conceded_avg,
    )
    away = TeamStrength(
        matches_played=payload.away_team.matches_played,
        goals_scored_avg=payload.away_team.goals_scored_avg,
        goals_conceded_avg=payload.away_team.goals_conceded_avg,
    )

    try:
        lambda_home, lambda_away = expected_goals(
            home, away, payload.league_avg_home_goals, payload.league_avg_away_goals
        )
        matrix = score_matrix(lambda_home, lambda_away)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    probs = market_probabilities(matrix)
    quality = data_quality_for(home, away)
    raw_factors = explain_factors(home, away, lambda_home, lambda_away)
    # Factors are written from the home side's perspective. Directional
    # factors get their polarity flipped for the away selection (a factor
    # favouring the home side argues against the away side); caveats
    # (data-quality warnings) apply identically to both and are never flipped.
    home_leaning = [Factor(direction=f["direction"], label=f["label"]) for f in raw_factors]
    away_leaning = [
        Factor(
            direction=("negative" if f["direction"] == "positive" else "positive")
            if f["kind"] == "directional"
            else f["direction"],
            label=f["label"],
        )
        for f in raw_factors
    ]

    predictions = [
        MarketProbability(market="1x2", selection="home", probability=probs["home_win"], factors=home_leaning),
        MarketProbability(market="1x2", selection="draw", probability=probs["draw"], factors=[]),
        MarketProbability(market="1x2", selection="away", probability=probs["away_win"], factors=away_leaning),
        MarketProbability(market="btts", selection="yes", probability=probs["btts_yes"], factors=home_leaning),
        MarketProbability(market="btts", selection="no", probability=probs["btts_no"], factors=[]),
        MarketProbability(
            market="over_under_2_5", selection="over", probability=probs["over_2_5"], factors=home_leaning
        ),
        MarketProbability(
            market="over_under_2_5", selection="under", probability=probs["under_2_5"], factors=[]
        ),
    ]

    return PoissonPredictionResponse(
        model_name=MODEL_NAME,
        model_version=MODEL_VERSION,
        data_quality=quality,
        predictions=predictions,
    )
