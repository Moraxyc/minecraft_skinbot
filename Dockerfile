FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv
FROM python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY bot ./bot
RUN uv sync --frozen --no-dev && useradd --uid 10001 --create-home bot && mkdir cache && chown bot:bot cache
USER bot
ENV PATH="/app/.venv/bin:$PATH" API_HOST="0.0.0.0"
EXPOSE 8080
CMD ["minecraft-skin-bot"]
