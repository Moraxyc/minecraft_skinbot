FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.12-slim
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY bot ./bot
RUN uv sync --frozen --no-dev && useradd --uid 10001 --create-home bot && mkdir cache && chown bot:bot cache
USER bot
ENV PATH="/app/.venv/bin:$PATH" API_HOST="0.0.0.0"
EXPOSE 8080
CMD ["minecraft-skin-bot"]
