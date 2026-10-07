import os
import re
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

TELEGRAM_SECRET_PATTERN = re.compile(r"\A[A-Za-z0-9_-]{1,256}\Z")


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
class Webhook:
    """Public webhook endpoint that receives Telegram updates."""

    url: str
    path: str
    secret: str = field(repr=False)


def _webhook() -> Webhook | None:
    """Read the optional webhook endpoint and its Telegram secret token."""
    url = os.environ.get("TELEGRAM_WEBHOOK_URL", "")
    if not url:
        return None
    endpoint = _url("TELEGRAM_WEBHOOK_URL", url)
    parsed = urlsplit(endpoint)
    if not parsed.path or parsed.query:
        raise ValueError(
            "Set TELEGRAM_WEBHOOK_URL to the full public webhook path, "
            "such as https://skin.example.com/telegram/webhook."
        )
    secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
    if secret and not TELEGRAM_SECRET_PATTERN.match(secret):
        raise ValueError(
            "Set TELEGRAM_WEBHOOK_SECRET to 1-256 characters of A-Z, a-z, 0-9, _ or -."
        )
    return Webhook(url=endpoint, path=parsed.path, secret=secret or secrets.token_urlsafe(32))


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str = field(repr=False)
    cache_chat_id: int
    mini_app_url: str
    public_base_url: str
    cache_dir: Path = Path("cache")
    api_host: str = "127.0.0.1"
    api_port: int = 8080
    api_unix_socket: Path | None = None
    api_unix_socket_group: str | None = None
    upload_ttl_seconds: int = 86400
    max_upload_bytes: int = 1048576
    cache_max_bytes: int = 536870912
    rich_messages: bool = True
    webhook: Webhook | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not token:
            raise ValueError("Set TELEGRAM_BOT_TOKEN to start the bot.")
        mini_app_url = _url("MINI_APP_URL", os.environ.get("MINI_APP_URL", ""))
        public_base_url = _url("PUBLIC_BASE_URL", os.environ.get("PUBLIC_BASE_URL", ""))
        webhook = _webhook()
        cache_chat = os.environ.get("TELEGRAM_CACHE_CHAT_ID", "")
        if not cache_chat:
            raise ValueError("Set TELEGRAM_CACHE_CHAT_ID to enable all four inline media results.")
        socket_path = os.environ.get("API_UNIX_SOCKET", "").strip()
        socket_group = os.environ.get("API_UNIX_SOCKET_GROUP", "").strip()
        try:
            settings = cls(
                bot_token=token,
                cache_chat_id=int(cache_chat),
                mini_app_url=mini_app_url,
                public_base_url=public_base_url,
                cache_dir=Path(os.environ.get("CACHE_DIR", "cache")),
                api_host=os.environ.get("API_HOST", "127.0.0.1"),
                api_port=int(os.environ.get("API_PORT", "8080")),
                api_unix_socket=Path(socket_path) if socket_path else None,
                api_unix_socket_group=socket_group or None,
                upload_ttl_seconds=int(os.environ.get("UPLOAD_TTL_SECONDS", "86400")),
                cache_max_bytes=int(os.environ.get("CACHE_MAX_BYTES", "536870912")),
                rich_messages=os.environ.get("TELEGRAM_RICH_MESSAGES", "true").lower()
                in {"true", "1", "yes"},
                webhook=webhook,
            )
        except ValueError as exc:
            raise ValueError(
                "Cache chat, port, upload TTL and cache budget must be valid integers."
            ) from exc
        if settings.cache_chat_id == 0 or abs(settings.cache_chat_id) >= 2**52:
            raise ValueError(
                "Set TELEGRAM_CACHE_CHAT_ID to the target's full signed numeric chat ID."
            )
        if not 1 <= settings.api_port <= 65535 or settings.upload_ttl_seconds < 60:
            raise ValueError("Use a valid API port and an upload TTL of at least 60 seconds.")
        if settings.cache_max_bytes <= 0:
            raise ValueError("Use a positive cache byte budget.")
        if settings.api_unix_socket is not None and not settings.api_unix_socket.is_absolute():
            raise ValueError("Set API_UNIX_SOCKET to an absolute socket path.")
        return settings
