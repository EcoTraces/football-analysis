import pytest

import app.main as main_module
from app.models.gradient_boosting import GradientBoostingOneXTwoModel


@pytest.fixture(autouse=True)
def reset_gradient_boosting_model():
    """app.main keeps exactly one process-wide GradientBoostingOneXTwoModel
    instance (see its module comment) so a trained model survives across
    requests. That same persistence would leak trained state between tests
    if left alone — one test training the model would make every other
    test (in this file or any other, since TestClient shares the same
    imported `app`) see it as already trained. Reset before every test."""
    main_module._gradient_boosting_model = GradientBoostingOneXTwoModel()
    yield
