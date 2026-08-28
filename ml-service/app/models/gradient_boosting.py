"""Second model on the wishlist (Task.md): a gradient-boosted classifier for
the 1x2 market. Scoped to 1x2 only, deliberately — the same market-scope
discipline the backtesting pipeline established (ML_Model.md's "Backtesting"
section), rather than trying to port all ~20 markets to a new model family
before this one is even proven out.

The key difference from poisson.py: that model has a closed-form Poisson
formula, so it can always produce a probability. This one has no formula at
all — it is only ever as good as what it was trained on, and produces
nothing meaningful (indeed, nothing at all) before training. `predict()`
raises `NotTrainedError` rather than fabricating a guess (e.g. an even
1/3-1/3-1/3 split) when nobody has trained it yet — the same "no data, no
market" discipline this platform applies everywhere else, just applied to
"no trained model" instead of "no synced statistic."

Training data must be point-in-time / walk-forward (see
backend/src/jobs/runBacktest.ts's `computePointInTimeStrength`) — the same
lookahead-bias concern that motivated the backtesting pipeline applies
identically here: training on a team's full-season aggregate to predict one
of that season's own matches would leak future results into the training
set.

State is process-local and in-memory only: a trained model lives only as
long as this ml-service process does, and is lost on restart. A production
deployment would persist the fitted model (to disk or object storage) and
reload it at boot; that persistence layer does not exist yet (see
ML_Model.md) — this is a deliberate, documented simplification, not an
oversight.
"""

from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier

# Same six inputs poisson.py's TeamStrength carries — kept identical so a
# training row can be built from exactly the same point-in-time computation
# the backtesting pipeline already does, with no new data requirement.
FEATURE_NAMES = [
    "home_matches_played",
    "home_goals_scored_avg",
    "home_goals_conceded_avg",
    "away_matches_played",
    "away_goals_scored_avg",
    "away_goals_conceded_avg",
]

OUTCOME_CLASSES = ["away", "draw", "home"]

# Below this, a gradient-boosted model (hundreds of decision trees by
# default) is far more likely to memorize noise than learn a real signal.
# Refusing outright is more honest than fitting on too little data and
# calling the result a model.
MIN_TRAINING_ROWS = 20


class NotTrainedError(RuntimeError):
    """Raised by predict() before train() has ever succeeded on this instance."""


@dataclass
class TeamFeatures:
    matches_played: int
    goals_scored_avg: float
    goals_conceded_avg: float


@dataclass
class TrainingRow:
    home: TeamFeatures
    away: TeamFeatures
    outcome: str  # "home" | "draw" | "away" — what actually happened


@dataclass
class TrainingResult:
    sample_size: int
    # In-sample accuracy only — the model scored against the exact rows it
    # was fit on, NOT a held-out test set. This is a diagnostic that
    # training ran and the model isn't degenerate, not a generalization
    # estimate. Use the backtesting pipeline (runBacktest.ts, generalized to
    # accept a model choice) against fixtures the model was never trained on
    # for anything resembling a real performance number.
    train_accuracy: float
    class_counts: dict[str, int]


def _feature_vector(home: TeamFeatures, away: TeamFeatures) -> list[float]:
    return [
        home.matches_played,
        home.goals_scored_avg,
        home.goals_conceded_avg,
        away.matches_played,
        away.goals_scored_avg,
        away.goals_conceded_avg,
    ]


class GradientBoostingOneXTwoModel:
    def __init__(self) -> None:
        self._classifier: GradientBoostingClassifier | None = None

    @property
    def is_trained(self) -> bool:
        return self._classifier is not None

    def train(self, rows: list[TrainingRow]) -> TrainingResult:
        if len(rows) < MIN_TRAINING_ROWS:
            raise ValueError(f"Need at least {MIN_TRAINING_ROWS} training rows, got {len(rows)}.")

        outcomes = [row.outcome for row in rows]
        invalid = sorted(set(outcomes) - set(OUTCOME_CLASSES))
        if invalid:
            raise ValueError(f"Unknown outcome label(s): {invalid}")
        if len(set(outcomes)) < 2:
            raise ValueError(
                "Training data must include at least two distinct outcomes "
                "(a model that has only ever seen one result can't learn anything)."
            )

        x = np.array([_feature_vector(row.home, row.away) for row in rows])
        y = np.array(outcomes)

        classifier = GradientBoostingClassifier(random_state=0)
        classifier.fit(x, y)
        self._classifier = classifier

        train_accuracy = float(classifier.score(x, y))
        class_counts = {cls: int((y == cls).sum()) for cls in OUTCOME_CLASSES}
        return TrainingResult(sample_size=len(rows), train_accuracy=train_accuracy, class_counts=class_counts)

    def predict(self, home: TeamFeatures, away: TeamFeatures) -> dict[str, float]:
        if self._classifier is None:
            raise NotTrainedError("Gradient boosting model has not been trained yet.")

        x = np.array([_feature_vector(home, away)])
        proba = self._classifier.predict_proba(x)[0]
        by_class = dict(zip(self._classifier.classes_, (float(p) for p in proba)))
        # A class absent from the training data (e.g. a training window that
        # happened to contain zero draws) is structurally unlearnable, not
        # just unlikely — predict_proba only ever returns the classes it was
        # fit on. Reporting 0.0 for it here is the honest reflection of
        # that, not a claim the model has evidence the outcome can't happen.
        return {cls: by_class.get(cls, 0.0) for cls in OUTCOME_CLASSES}
