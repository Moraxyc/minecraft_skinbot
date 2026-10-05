import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


def _url(name: str, value: str) -> str:
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise ValueError(f"{name} requires a valid HTTPS URL.") from exc
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or (name == "PUBLIC_BASE_URL" and parsed.query)
        or (parsed.scheme != "https" and not (local and parsed.scheme == "http"))
    ):
        raise ValueError(f"{name} requires an HTTPS URL (HTTP is allowed on localhost).")
    return value.rstrip("/")


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str = field(repr=False)
    cache_chat_id: int
    mini_app_url: str
    public_base_url: str
    cache_dir: Path = Path("cache")
    api_host: str = "127.0.0.1"
    api_port: int = 8080
    upload_ttl_seconds: int = 86400
    max_upload_bytes: int = 1048576
    rich_messages: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not token:
            raise ValueError("Set TELEGRAM_BOT_TOKEN to start the bot.")
        mini_app_url = _url("MINI_APP_URL", os.environ.get("MINI_APP_URL", ""))
        public_base_url = _url("PUBLIC_BASE_URL", os.environ.get("PUBLIC_BASE_URL", ""))
        cache_chat = os.environ.get("TELEGRAM_CACHE_CHAT_ID", "")
        if not cache_chat:
            raise ValueError("Set TELEGRAM_CACHE_CHAT_ID to enable all four inline media results.")
        try:
            settings = cls(
                bot_token=token,
                cache_chat_id=int(cache_chat),
                mini_app_url=mini_app_url,
                public_base_url=public_base_url,
                cache_dir=Path(os.environ.get("CACHE_DIR", "cache")),
                api_host=os.environ.get("API_HOST", "127.0.0.1"),
                api_port=int(os.environ.get("API_PORT", "8080")),
                upload_ttl_seconds=int(os.environ.get("UPLOAD_TTL_SECONDS", "86400")),
                rich_messages=os.environ.get("TELEGRAM_RICH_MESSAGES", "true").lower()
                in {"true", "1", "yes"},
            )
        except ValueError as exc:
            raise ValueError("Cache chat, port and upload TTL must be valid integers.") from exc
        if not 1 <= settings.api_port <= 65535 or settings.upload_ttl_seconds < 60:
            raise ValueError("Use a valid API port and an upload TTL of at least 60 seconds.")
        return settings
