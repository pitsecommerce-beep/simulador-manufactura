# Contexto de build: raíz del repositorio (Railway: Root Directory vacío).
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.8.17
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages/jobqueue-py packages/jobqueue-py
COPY services services
RUN uv sync --frozen --no-dev --package cad-worker
RUN useradd --create-home worker
USER worker
CMD ["/app/.venv/bin/cad-worker"]
