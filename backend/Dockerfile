FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./

# Keep dependency installation cached when only application code changes.
RUN mkdir app \
    && touch app/__init__.py \
    && pip install --no-cache-dir -e ".[dev]"

COPY app ./app

COPY alembic.ini ./
COPY alembic ./alembic

EXPOSE 8000
