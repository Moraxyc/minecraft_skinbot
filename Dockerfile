FROM ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168 AS uv
FROM python:3.14-slim@sha256:f85c5697265c178cc6887276c55fe16cf3d14ca35c3df6a5eab3b360534a55d2
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY bot ./bot
RUN uv sync --frozen --no-dev && useradd --uid 10001 --create-home bot && mkdir cache && chown bot:bot cache
USER bot
ENV PATH="/app/.venv/bin:$PATH" API_HOST="0.0.0.0"
EXPOSE 8080
CMD ["minecraft-skin-bot"]
