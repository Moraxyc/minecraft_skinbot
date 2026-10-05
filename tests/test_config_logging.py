import logging
from typing import Any

import pytest
from minecraft_skin_bot.app import SafeLogFilter
from minecraft_skin_bot.config import Settings


def test_startup_requires_cache_channel_and_rejects_unsafe_public_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "synthetic")
    monkeypatch.setenv("MINI_APP_URL", "https://viewer.example")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.example")
    monkeypatch.delenv("TELEGRAM_CACHE_CHAT_ID", raising=False)
    with pytest.raises(ValueError, match="TELEGRAM_CACHE_CHAT_ID"):
        Settings.from_env()
    monkeypatch.setenv("TELEGRAM_CACHE_CHAT_ID", "-100123")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://name:password@api.example")
    with pytest.raises(ValueError, match="PUBLIC_BASE_URL"):
        Settings.from_env()
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.example")
    settings = Settings.from_env()
    assert "synthetic" not in repr(settings)


@pytest.mark.parametrize("exception", [None, RuntimeError("opaque request body")])
def test_logs_redact_transport_urls_credentials_and_exception_payloads(
    exception: Exception | None,
) -> None:
    credential = "123456:synthetic_abcdefghijklmnopqrstuvwxyz0123456789"
    info: Any = (type(exception), exception, None) if exception else None
    record = logging.LogRecord(
        "transport",
        logging.ERROR,
        "app.py",
        1,
        "Request %s failed %s",
        ("https://api.telegram.org/bot" + credential + "/getMe", credential),
        info,
    )
    SafeLogFilter().filter(record)
    assert credential not in record.getMessage()
    assert "opaque request body" not in record.getMessage()
    assert record.exc_info is None
