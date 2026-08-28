FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
# Shell form (not exec-array) so ${PORT:-8000} actually expands — Render
# injects its own PORT and expects the container to bind to it (same
# reason backend/src/config/env.ts reads process.env.PORT rather than a
# hardcoded value); falls back to 8000 for local/docker-compose use where
# PORT isn't set.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
