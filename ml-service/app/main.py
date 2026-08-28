from fastapi import FastAPI, HTTPException

from app.models.count_markets import total_over_under
from app.models.half_markets import build_half_matrices, half_result_probabilities, half_with_most_goals_probabilities
from app.models.player_market import anytime_scorer_probability, top_scorers
from app.models.player_market import PlayerCandidate as ScorerCandidate
from app.models.poisson import (
    TeamStrength,
    data_quality_for,
    expected_goals,
    explain_factors,
    market_probabilities,
    score_matrix,
    top_correct_scores,
)
from app.schemas import Factor, MarketProbability, PlayerCandidateInput, PoissonPredictionRequest, PoissonPredictionResponse

MODEL_NAME = "poisson-baseline"
MODEL_VERSION = "0.1.0"


def _anytime_goalscorer_predictions(
    market: str,
    players_input: list[PlayerCandidateInput] | None,
    team_lambda: float,
    team_matches_played: int,
    team_goals_scored_avg: float,
) -> list[MarketProbability]:
    """Builds the anytime-goalscorer selections for one team/side. Returns []
    when there's nothing to build from — no players sent, or a team with no
    recorded goals yet — rather than raising, since this is one optional
    piece of a response that otherwise still has plenty to return.

    Selections here are independent probabilities, not mutually exclusive —
    see player_market.py's module docstring. No `factors` either: a list of
    up to 6 largely-unrelated per-player numbers isn't well served by the
    2-3 bullet explanations used elsewhere.
    """
    if players_input is None:
        return []

    team_total_goals = team_goals_scored_avg * team_matches_played
    if team_total_goals <= 0:
        return []

    candidates = [ScorerCandidate(name=p.name, goals_scored=p.goals_scored, matches_played=p.matches_played) for p in players_input]
    predictions = []
    for candidate in top_scorers(candidates):
        probability = anytime_scorer_probability(team_lambda, team_total_goals, candidate.goals_scored)
        predictions.append(MarketProbability(market=market, selection=candidate.name, probability=probability, factors=[]))
    return predictions

# Fixed lines, not fitted or configurable — same simplification as goals'
# over_under_2_5. 3.5 total cards and 9.5 total corners are commonly offered
# lines for a competitive match, chosen for plausibility, not calibrated
# against this platform's own data (there is none yet — see Task.md).
CARDS_LINE = 3.5
CORNERS_LINE = 9.5

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
        # Double chance is a relabeling of the 1x2 probabilities (see
        # market_probabilities' comment) — home_or_draw and draw_or_away each
        # still carry a directional lean since they include one of the two
        # 1x2 sides; home_or_away (excludes only the draw) doesn't lean
        # toward either team, so it gets no factors.
        MarketProbability(
            market="double_chance",
            selection="home_or_draw",
            probability=probs["home_or_draw"],
            factors=home_leaning,
        ),
        MarketProbability(
            market="double_chance", selection="home_or_away", probability=probs["home_or_away"], factors=[]
        ),
        MarketProbability(
            market="double_chance",
            selection="draw_or_away",
            probability=probs["draw_or_away"],
            factors=away_leaning,
        ),
    ]

    # Correct score: only the top N exact scorelines are surfaced individually
    # (the full grid is 121 cells, almost all negligible); the remaining
    # probability mass is reported as an explicit "other" selection so the
    # market's probabilities still sum to 1 rather than silently omitting it.
    top_scores = top_correct_scores(matrix, n=10)
    other_probability = max(0.0, 1.0 - sum(p for _, _, p in top_scores))
    predictions.extend(
        MarketProbability(market="correct_score", selection=f"{home_goals}-{away_goals}", probability=p, factors=[])
        for home_goals, away_goals, p in top_scores
    )
    predictions.append(
        MarketProbability(market="correct_score", selection="other", probability=other_probability, factors=[])
    )

    # Cards and corners are only predicted when the backend actually sent
    # both teams' own averages — no fabricated market when the underlying
    # data isn't there yet (matches this platform's "no data, no guess"
    # policy everywhere else). See count_markets.py for why these are a
    # simple additive Poisson model rather than goals' score-matrix approach.
    if payload.home_team_avg_yellow_cards is not None and payload.away_team_avg_yellow_cards is not None:
        cards_lambda = payload.home_team_avg_yellow_cards + payload.away_team_avg_yellow_cards
        if cards_lambda > 0:
            cards_over, cards_under = total_over_under(cards_lambda, CARDS_LINE)
            predictions.append(MarketProbability(market="total_cards", selection="over", probability=cards_over, factors=[]))
            predictions.append(MarketProbability(market="total_cards", selection="under", probability=cards_under, factors=[]))

    if payload.home_team_avg_corners is not None and payload.away_team_avg_corners is not None:
        corners_lambda = payload.home_team_avg_corners + payload.away_team_avg_corners
        if corners_lambda > 0:
            corners_over, corners_under = total_over_under(corners_lambda, CORNERS_LINE)
            predictions.append(MarketProbability(market="total_corners", selection="over", probability=corners_over, factors=[]))
            predictions.append(MarketProbability(market="total_corners", selection="under", probability=corners_under, factors=[]))

    # Half-based markets: always computable from the same lambda_home/
    # lambda_away as every market above, so — unlike cards/corners — there's
    # no optional-data gate here. See half_markets.py for the fixed
    # first/second-half split and why rho=0 is used for each half instead
    # of the full match's Dixon-Coles RHO.
    first_half_matrix, second_half_matrix = build_half_matrices(lambda_home, lambda_away)
    first_half_probs = half_result_probabilities(first_half_matrix)
    second_half_probs = half_result_probabilities(second_half_matrix)
    most_goals_probs = half_with_most_goals_probabilities(first_half_matrix, second_half_matrix)

    predictions.extend(
        [
            MarketProbability(
                market="first_half_result", selection="home", probability=first_half_probs["home"], factors=home_leaning
            ),
            MarketProbability(market="first_half_result", selection="draw", probability=first_half_probs["draw"], factors=[]),
            MarketProbability(
                market="first_half_result", selection="away", probability=first_half_probs["away"], factors=away_leaning
            ),
            MarketProbability(
                market="second_half_result", selection="home", probability=second_half_probs["home"], factors=home_leaning
            ),
            MarketProbability(
                market="second_half_result", selection="draw", probability=second_half_probs["draw"], factors=[]
            ),
            MarketProbability(
                market="second_half_result", selection="away", probability=second_half_probs["away"], factors=away_leaning
            ),
            MarketProbability(
                market="half_with_most_goals",
                selection="first_half",
                probability=most_goals_probs["first_half"],
                factors=[],
            ),
            MarketProbability(
                market="half_with_most_goals",
                selection="second_half",
                probability=most_goals_probs["second_half"],
                factors=[],
            ),
            MarketProbability(
                market="half_with_most_goals", selection="equal", probability=most_goals_probs["equal"], factors=[]
            ),
        ]
    )

    # Anytime goalscorer: independent, non-mutually-exclusive selections —
    # see player_market.py's module docstring and _anytime_goalscorer_predictions'.
    # Two separate markets (not one shared one) since predictions has no
    # team-side column and mixing both squads' names into one flat list
    # would be ambiguous about which team a name belongs to.
    predictions.extend(
        _anytime_goalscorer_predictions(
            "home_anytime_goalscorer",
            payload.home_team_players,
            lambda_home,
            payload.home_team.matches_played,
            payload.home_team.goals_scored_avg,
        )
    )
    predictions.extend(
        _anytime_goalscorer_predictions(
            "away_anytime_goalscorer",
            payload.away_team_players,
            lambda_away,
            payload.away_team.matches_played,
            payload.away_team.goals_scored_avg,
        )
    )

    return PoissonPredictionResponse(
        model_name=MODEL_NAME,
        model_version=MODEL_VERSION,
        data_quality=quality,
        predictions=predictions,
    )
