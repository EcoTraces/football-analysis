from pydantic import BaseModel, ConfigDict, Field


def to_camel(snake: str) -> str:
    head, *tail = snake.split("_")
    return head + "".join(word.capitalize() for word in tail)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, protected_namespaces=())


class TeamStrengthInput(CamelModel):
    matches_played: int = Field(ge=0)
    goals_scored_avg: float = Field(ge=0)
    goals_conceded_avg: float = Field(ge=0)


class PlayerCandidateInput(CamelModel):
    name: str
    goals_scored: float = Field(ge=0)
    matches_played: int = Field(ge=0)


class PoissonPredictionRequest(CamelModel):
    home_team: TeamStrengthInput
    away_team: TeamStrengthInput
    league_avg_home_goals: float = Field(gt=0)
    league_avg_away_goals: float = Field(gt=0)
    # Optional per-request override of the Dixon-Coles rho used for this
    # one prediction — lets the caller supply a competition-specific fitted
    # rho (backend/src/jobs/fitDixonColesRho.ts::getCompetitionRho) without
    # this service needing to know anything about competitions as entities.
    # None (the default) falls back to the existing global behavior:
    # whatever /fit/dixon_coles_rho last set process-wide, or the fixed
    # RHO constant if nobody has fit anything yet — see _effective_rho().
    rho: float | None = None
    # Optional: each team's own average yellow cards / corners per match.
    # Unlike goals, the backend only has these once fixture-statistics data
    # (corners) or cards-parsing (see syncTeamStatistics.ts) has actually
    # been synced for both teams — when either is missing, the caller omits
    # both of a pair rather than sending a guessed value, and main.py skips
    # that market entirely (see its "no data -> no prediction" handling).
    home_team_avg_yellow_cards: float | None = Field(default=None, ge=0)
    away_team_avg_yellow_cards: float | None = Field(default=None, ge=0)
    home_team_avg_corners: float | None = Field(default=None, ge=0)
    away_team_avg_corners: float | None = Field(default=None, ge=0)
    # Optional: a team's own season goalscorers (from player_statistics —
    # see syncPlayerStatistics.ts), for the anytime-goalscorer markets. None
    # (not an empty list) means the backend hasn't synced player data for
    # this team's season yet — main.py skips that side's market entirely
    # rather than treating "no players sent" the same as "sent, but nobody
    # qualified." See player_market.py for the ranking/eligibility rules.
    home_team_players: list[PlayerCandidateInput] | None = None
    away_team_players: list[PlayerCandidateInput] | None = None


class Factor(CamelModel):
    direction: str
    label: str


class MarketProbability(CamelModel):
    market: str
    selection: str
    probability: float
    factors: list[Factor]


class PoissonPredictionResponse(CamelModel):
    model_name: str
    model_version: str
    data_quality: str
    predictions: list[MarketProbability]


class GradientBoostingPredictRequest(CamelModel):
    home_team: TeamStrengthInput
    away_team: TeamStrengthInput


# Same field names/shape as PoissonPredictionResponse — the backend's
# PredictionClient reuses that one type for both models rather than
# defining a parallel one, since a 1x2-only response is a strict subset of
# the Poisson response shape.
class GradientBoostingPredictionResponse(CamelModel):
    model_name: str
    model_version: str
    data_quality: str
    predictions: list[MarketProbability]


class GradientBoostingTrainingRowInput(CamelModel):
    home_team: TeamStrengthInput
    away_team: TeamStrengthInput
    outcome: str  # "home" | "draw" | "away"


class GradientBoostingTrainRequest(CamelModel):
    rows: list[GradientBoostingTrainingRowInput]


class GradientBoostingTrainResponse(CamelModel):
    sample_size: int
    train_accuracy: float
    class_counts: dict[str, int]


class RhoFittingRowInput(CamelModel):
    home_team: TeamStrengthInput
    away_team: TeamStrengthInput
    actual_home_goals: int = Field(ge=0)
    actual_away_goals: int = Field(ge=0)


class DixonColesRhoFitRequest(CamelModel):
    league_avg_home_goals: float = Field(gt=0)
    league_avg_away_goals: float = Field(gt=0)
    rows: list[RhoFittingRowInput]
    # True (the default, and the only behavior that existed before
    # per-competition fitting): adopt this fit as the process-wide fallback
    # rho, exactly like every prior /fit/dixon_coles_rho call. False: fit
    # and return the result, but leave the global fallback untouched — used
    # for a competition-scoped fit, where the result gets stored per
    # competition (competition_rho) instead of overwriting the one value
    # every other competition's predictions would otherwise fall back to.
    apply_globally: bool = True


class DixonColesRhoFitResponse(CamelModel):
    sample_size: int
    informative_matches: int
    fitted_rho: float
    log_likelihood_at_fitted_rho: float
    log_likelihood_at_default_rho: float
    default_rho: float


class RhoStatusResponse(CamelModel):
    fitted_rho: float | None
    default_rho: float
