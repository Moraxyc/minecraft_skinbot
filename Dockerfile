FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY bot ./bot
RUN uv sync --frozen --no-dev && useradd --uid 10001 --create-home bot && mkdir cache && chown bot:bot cache
USER bot
ENV PATH="/app/.venv/bin:$PATH" API_HOST="0.0.0.0"
EXPOSE 8080
CMD ["minecraft-skin-bot"]
