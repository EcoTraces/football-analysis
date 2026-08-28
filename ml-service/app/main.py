from fastapi import FastAPI, HTTPException

from app.models.count_markets import total_over_under
from app.models.gradient_boosting import (
    GradientBoostingOneXTwoModel,
    NotTrainedError,
    TeamFeatures,
    TrainingRow,
)
from app.models.half_markets import (
    build_half_matrices,
    half_result_probabilities,
    half_with_most_goals_probabilities,
    wins_at_least_one_half_probabilities,
)
from app.models.player_market import anytime_scorer_probability, top_scorers
from app.models.player_market import PlayerCandidate as ScorerCandidate
from app.models.poisson import (
    RHO,
    TeamStrength,
    btts_and_result_probabilities,
    data_quality_for,
    expected_goals,
    explain_factors,
    handicap_probabilities,
    market_probabilities,
    result_and_total_goals_probabilities,
    score_matrix,
    top_correct_scores,
)
from app.models.rho_fitting import RhoFittingRow, fit_rho
from app.schemas import (
    DixonColesRhoFitRequest,
    DixonColesRhoFitResponse,
    Factor,
    GradientBoostingPredictionResponse,
    GradientBoostingPredictRequest,
    GradientBoostingTrainRequest,
    GradientBoostingTrainResponse,
    MarketProbability,
    PlayerCandidateInput,
    PoissonPredictionRequest,
    PoissonPredictionResponse,
    RhoStatusResponse,
)

MODEL_NAME = "poisson-baseline"
MODEL_VERSION = "0.1.0"

GRADIENT_BOOSTING_MODEL_NAME = "gradient-boosting"
GRADIENT_BOOSTING_MODEL_VERSION = "0.1.0"


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
TEAM_TOTAL_GOALS_LINE = 1.5  # A single team's own goals, not the match total — same "plausible, not fitted" caveat.
HANDICAP_HOME_LINE = -1.5  # Half-integer so there's no push case; see poisson.py::handicap_probabilities.

app = FastAPI(title="Football Analysis ML Service", version=MODEL_VERSION)

# Process-local, in-memory only — see gradient_boosting.py's module
# docstring. A restart of this service loses whatever was trained; the
# backend must retrain (POST /admin/model/gradient-boosting/train) after
# every ml-service redeploy/restart until this is backed by real
# persistence. There is exactly one instance for the whole process, not
# per-request, because training is meant to be a rare, explicit action
# whose result should stick around for every prediction request after it.
_gradient_boosting_model = GradientBoostingOneXTwoModel()

# Same process-local, in-memory, restart-loses-it pattern as
# _gradient_boosting_model above — None means "nobody has fit rho yet, use
# poisson.py's fixed RHO". Set by POST /fit/dixon_coles_rho, read by every
# /predict/poisson call after that (see _effective_rho()) and by every
# market derived from that same score matrix (correct score, btts,
# over/under, double chance, clean sheet, handicap, the two joint markets —
# everything except the half-based markets, which deliberately use rho=0
# regardless; see half_markets.py).
_fitted_rho: float | None = None


def _effective_rho() -> float:
    return _fitted_rho if _fitted_rho is not None else RHO


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
        matrix = score_matrix(lambda_home, lambda_away, rho=_effective_rho())
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
        # Clean sheet, odd/even goals, and draw-no-bet are all, like double
        # chance, pure relabelings of market_probabilities()'s output — no
        # separate model behind any of them.
        # home_clean_sheet leans on home_leaning (which includes home's own
        # defensive-record factor) since it's about home's defense holding,
        # not directly about the model's overall goal-difference lean.
        MarketProbability(
            market="home_clean_sheet", selection="yes", probability=probs["home_clean_sheet_yes"], factors=home_leaning
        ),
        MarketProbability(
            market="home_clean_sheet", selection="no", probability=probs["home_clean_sheet_no"], factors=[]
        ),
        MarketProbability(
            market="away_clean_sheet", selection="yes", probability=probs["away_clean_sheet_yes"], factors=away_leaning
        ),
        MarketProbability(
            market="away_clean_sheet", selection="no", probability=probs["away_clean_sheet_no"], factors=[]
        ),
        MarketProbability(market="odd_even_goals", selection="even", probability=probs["even_goals"], factors=[]),
        MarketProbability(market="odd_even_goals", selection="odd", probability=probs["odd_goals"], factors=[]),
        MarketProbability(
            market="draw_no_bet", selection="home", probability=probs["draw_no_bet_home"], factors=home_leaning
        ),
        MarketProbability(
            market="draw_no_bet", selection="away", probability=probs["draw_no_bet_away"], factors=away_leaning
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

    # Two joint (not independent) markets and a handicap — all read directly
    # off the same full-match matrix as correct_score, always computed.
    btts_and_result = btts_and_result_probabilities(matrix)
    predictions.extend(
        MarketProbability(market="btts_and_result", selection=selection, probability=p, factors=[])
        for selection, p in btts_and_result.items()
    )

    result_and_total_goals = result_and_total_goals_probabilities(matrix, line=2.5)
    predictions.extend(
        MarketProbability(market="result_and_total_goals", selection=selection, probability=p, factors=[])
        for selection, p in result_and_total_goals.items()
    )

    handicap = handicap_probabilities(matrix, home_handicap=HANDICAP_HOME_LINE)
    predictions.append(
        MarketProbability(market="handicap", selection="home", probability=handicap["home"], factors=home_leaning)
    )
    predictions.append(
        MarketProbability(market="handicap", selection="away", probability=handicap["away"], factors=away_leaning)
    )

    # Team total goals: each side's OWN lambda against a fixed line — reuses
    # count_markets.total_over_under() directly (same shape as total_cards/
    # total_corners, just with a single team's lambda instead of a summed
    # one), always computable, no optional-data gate.
    home_team_total_over, home_team_total_under = total_over_under(lambda_home, TEAM_TOTAL_GOALS_LINE)
    predictions.append(
        MarketProbability(market="home_team_total_goals", selection="over", probability=home_team_total_over, factors=home_leaning)
    )
    predictions.append(
        MarketProbability(market="home_team_total_goals", selection="under", probability=home_team_total_under, factors=[])
    )
    away_team_total_over, away_team_total_under = total_over_under(lambda_away, TEAM_TOTAL_GOALS_LINE)
    predictions.append(
        MarketProbability(market="away_team_total_goals", selection="over", probability=away_team_total_over, factors=away_leaning)
    )
    predictions.append(
        MarketProbability(market="away_team_total_goals", selection="under", probability=away_team_total_under, factors=[])
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

    # Wins at least one half: like anytime-goalscorer, independent
    # per-side probabilities, not a 3-way partition — both sides can win a
    # half in the same match. See half_markets.py.
    wins_a_half = wins_at_least_one_half_probabilities(first_half_probs, second_half_probs)
    predictions.append(
        MarketProbability(market="home_wins_a_half", selection="yes", probability=wins_a_half["home"], factors=home_leaning)
    )
    predictions.append(
        MarketProbability(market="home_wins_a_half", selection="no", probability=1 - wins_a_half["home"], factors=[])
    )
    predictions.append(
        MarketProbability(market="away_wins_a_half", selection="yes", probability=wins_a_half["away"], factors=away_leaning)
    )
    predictions.append(
        MarketProbability(market="away_wins_a_half", selection="no", probability=1 - wins_a_half["away"], factors=[])
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


@app.post("/train/gradient_boosting", response_model=GradientBoostingTrainResponse)
def train_gradient_boosting(payload: GradientBoostingTrainRequest) -> GradientBoostingTrainResponse:
    rows = [
        TrainingRow(
            home=TeamFeatures(
                matches_played=row.home_team.matches_played,
                goals_scored_avg=row.home_team.goals_scored_avg,
                goals_conceded_avg=row.home_team.goals_conceded_avg,
            ),
            away=TeamFeatures(
                matches_played=row.away_team.matches_played,
                goals_scored_avg=row.away_team.goals_scored_avg,
                goals_conceded_avg=row.away_team.goals_conceded_avg,
            ),
            outcome=row.outcome,
        )
        for row in payload.rows
    ]

    try:
        result = _gradient_boosting_model.train(rows)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return GradientBoostingTrainResponse(
        sample_size=result.sample_size,
        train_accuracy=result.train_accuracy,
        class_counts=result.class_counts,
    )


@app.post("/predict/gradient_boosting", response_model=GradientBoostingPredictionResponse)
def predict_gradient_boosting(payload: GradientBoostingPredictRequest) -> GradientBoostingPredictionResponse:
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
        probs = _gradient_boosting_model.predict(
            TeamFeatures(home.matches_played, home.goals_scored_avg, home.goals_conceded_avg),
            TeamFeatures(away.matches_played, away.goals_scored_avg, away.goals_conceded_avg),
        )
    except NotTrainedError as exc:
        # 409, not 422/500 — the request itself is fine, but there's no
        # trained model to serve yet. The caller (backend) treats this the
        # same as any other "prediction unavailable" — never fabricates a
        # fallback probability.
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    predictions = [
        MarketProbability(market="1x2", selection="home", probability=probs["home"], factors=[]),
        MarketProbability(market="1x2", selection="draw", probability=probs["draw"], factors=[]),
        MarketProbability(market="1x2", selection="away", probability=probs["away"], factors=[]),
    ]

    return GradientBoostingPredictionResponse(
        model_name=GRADIENT_BOOSTING_MODEL_NAME,
        model_version=GRADIENT_BOOSTING_MODEL_VERSION,
        # Reuses the same matches-played-based proxy poisson.py uses — it's
        # a statement about how much data described these two teams, not
        # about this specific model's own confidence, so the same thresholds
        # apply regardless of which model is answering.
        data_quality=data_quality_for(home, away),
        predictions=predictions,
    )


@app.post("/fit/dixon_coles_rho", response_model=DixonColesRhoFitResponse)
def fit_dixon_coles_rho(payload: DixonColesRhoFitRequest) -> DixonColesRhoFitResponse:
    rows = []
    for row in payload.rows:
        home = TeamStrength(
            matches_played=row.home_team.matches_played,
            goals_scored_avg=row.home_team.goals_scored_avg,
            goals_conceded_avg=row.home_team.goals_conceded_avg,
        )
        away = TeamStrength(
            matches_played=row.away_team.matches_played,
            goals_scored_avg=row.away_team.goals_scored_avg,
            goals_conceded_avg=row.away_team.goals_conceded_avg,
        )
        lambda_home, lambda_away = expected_goals(home, away, payload.league_avg_home_goals, payload.league_avg_away_goals)
        rows.append(RhoFittingRow(lambda_home, lambda_away, row.actual_home_goals, row.actual_away_goals))

    try:
        result = fit_rho(rows, default_rho=RHO)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    global _fitted_rho
    _fitted_rho = result.fitted_rho

    return DixonColesRhoFitResponse(
        sample_size=result.sample_size,
        informative_matches=result.informative_matches,
        fitted_rho=result.fitted_rho,
        log_likelihood_at_fitted_rho=result.log_likelihood_at_fitted_rho,
        log_likelihood_at_default_rho=result.log_likelihood_at_default_rho,
        default_rho=RHO,
    )


@app.get("/rho_status", response_model=RhoStatusResponse)
def rho_status() -> RhoStatusResponse:
    return RhoStatusResponse(fitted_rho=_fitted_rho, default_rho=RHO)
