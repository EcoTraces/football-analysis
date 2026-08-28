import pytest

from app.models.gradient_boosting import (
    MIN_TRAINING_ROWS,
    GradientBoostingOneXTwoModel,
    NotTrainedError,
    TeamFeatures,
    TrainingRow,
)

STRONG = TeamFeatures(matches_played=20, goals_scored_avg=2.5, goals_conceded_avg=0.5)
WEAK = TeamFeatures(matches_played=20, goals_scored_avg=0.5, goals_conceded_avg=2.5)
EVEN = TeamFeatures(matches_played=20, goals_scored_avg=1.2, goals_conceded_avg=1.2)


def separable_training_rows(per_class: int = 10) -> list[TrainingRow]:
    """A trivially separable synthetic dataset — not real football data,
    just enough structure (strong team at home => home win, etc.) to prove
    the model actually learns something rather than always predicting the
    majority class. Real training data comes from
    backend/src/jobs/trainGradientBoosting.ts's point-in-time fixture
    aggregation, which this module never sees directly."""
    rows = []
    for _ in range(per_class):
        rows.append(TrainingRow(home=STRONG, away=WEAK, outcome="home"))
        rows.append(TrainingRow(home=WEAK, away=STRONG, outcome="away"))
        rows.append(TrainingRow(home=EVEN, away=EVEN, outcome="draw"))
    return rows


def test_is_trained_starts_false_and_flips_after_a_successful_train():
    model = GradientBoostingOneXTwoModel()
    assert model.is_trained is False
    model.train(separable_training_rows())
    assert model.is_trained is True


def test_predict_before_training_raises_not_trained_rather_than_guessing():
    model = GradientBoostingOneXTwoModel()
    with pytest.raises(NotTrainedError):
        model.predict(STRONG, WEAK)


def test_train_refuses_fewer_than_the_minimum_row_count():
    model = GradientBoostingOneXTwoModel()
    too_few = [TrainingRow(home=STRONG, away=WEAK, outcome="home")] * (MIN_TRAINING_ROWS - 1)
    with pytest.raises(ValueError, match="at least"):
        model.train(too_few)


def test_train_refuses_a_single_outcome_class():
    model = GradientBoostingOneXTwoModel()
    only_home_wins = [TrainingRow(home=STRONG, away=WEAK, outcome="home")] * MIN_TRAINING_ROWS
    with pytest.raises(ValueError, match="two distinct outcomes"):
        model.train(only_home_wins)


def test_train_refuses_an_unknown_outcome_label():
    model = GradientBoostingOneXTwoModel()
    rows = separable_training_rows()
    rows[0] = TrainingRow(home=STRONG, away=WEAK, outcome="home_win")  # not one of home/draw/away
    with pytest.raises(ValueError, match="Unknown outcome"):
        model.train(rows)


def test_train_reports_sample_size_and_class_counts():
    model = GradientBoostingOneXTwoModel()
    result = model.train(separable_training_rows(per_class=10))
    assert result.sample_size == 30
    assert result.class_counts == {"home": 10, "draw": 10, "away": 10}
    # This dataset is trivially separable by construction — a model that
    # can't fit it near-perfectly in-sample would indicate something is
    # broken, not that the data is merely hard.
    assert result.train_accuracy > 0.9


def test_predict_after_training_learns_the_separable_pattern():
    model = GradientBoostingOneXTwoModel()
    model.train(separable_training_rows())

    home_favoured = model.predict(STRONG, WEAK)
    assert home_favoured["home"] > home_favoured["away"]
    assert home_favoured["home"] > home_favoured["draw"]

    away_favoured = model.predict(WEAK, STRONG)
    assert away_favoured["away"] > away_favoured["home"]
    assert away_favoured["away"] > away_favoured["draw"]

    even_match = model.predict(EVEN, EVEN)
    assert even_match["draw"] > even_match["home"]
    assert even_match["draw"] > even_match["away"]

    for probs in (home_favoured, away_favoured, even_match):
        assert set(probs.keys()) == {"home", "draw", "away"}
        assert sum(probs.values()) == pytest.approx(1.0, abs=1e-6)
