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


class PoissonPredictionRequest(CamelModel):
    home_team: TeamStrengthInput
    away_team: TeamStrengthInput
    league_avg_home_goals: float = Field(gt=0)
    league_avg_away_goals: float = Field(gt=0)
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
