"""Service-to-service auth for the model endpoints.

ml-service has no user-facing auth of its own by design (Data_Sources.md,
Architecture.md) — every real request is meant to come from the backend,
which already enforces its own signed-in-user/admin checks before ever
calling here. But this service is deployed as its own public Render web
service (render.yaml) with no network-level restriction in front of it, so
without something at this layer too, `/predict/poisson`,
`/train/gradient_boosting` (the one genuinely expensive endpoint — see
main.py's module comment on `_gradient_boosting_model`), and every other
model route are reachable and callable by anyone on the internet directly,
for free, with no rate limit.

ML_SERVICE_API_KEY is optional and unset by default — required in
production (render.yaml), but a real key is not something local dev or the
test suite should have to configure just to call these endpoints, so an
unset key means "no enforcement," matching this codebase's existing
"fail closed only when explicitly configured to require it" pattern (e.g.
registry.py's provider construction). `/health` deliberately never goes
through this — Render's own health-check probe (render.yaml's
healthCheckPath) doesn't send this header, and a 401 there would make
Render treat a correctly-configured, healthy instance as down.
"""

import hmac
import os

from fastapi import Header, HTTPException


def require_internal_api_key(x_api_key: str | None = Header(default=None)) -> None:
    expected = os.environ.get("ML_SERVICE_API_KEY")
    if not expected:
        return
    if not x_api_key or not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key header.")
