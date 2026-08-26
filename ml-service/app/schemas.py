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
