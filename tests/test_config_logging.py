import logging
from typing import Any

import pytest
from minecraft_skin_bot.app import SafeLogFilter
from minecraft_skin_bot.config import Settings, Webhook


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "synthetic")
    monkeypatch.setenv("TELEGRAM_CACHE_CHAT_ID", "-100123")
    monkeypatch.setenv("MINI_APP_URL", "https://viewer.example")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.example")


def test_delivery_defaults_to_polling_and_generates_a_webhook_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_env(monkeypatch)
    monkeypatch.delenv("TELEGRAM_WEBHOOK_URL", raising=False)
    assert Settings.from_env().webhook is None
    monkeypatch.setenv("TELEGRAM_WEBHOOK_URL", "https://skin.example.com/telegram/hook")
    monkeypatch.delenv("TELEGRAM_WEBHOOK_SECRET", raising=False)
    settings = Settings.from_env()
    assert settings.webhook is not None
    assert settings.webhook.path == "/telegram/hook"
    assert 32 <= len(settings.webhook.secret) <= 256
    assert settings.webhook.secret not in repr(settings)
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "pinned_AZaz09-_token")
    assert Settings.from_env().webhook == Webhook(
        "https://skin.example.com/telegram/hook", "/telegram/hook", "pinned_AZaz09-_token"
    )


@pytest.mark.parametrize(
    ("url", "secret"),
    [
        ("https://skin.example.com", ""),
        ("https://skin.example.com/hook?token=1", ""),
        ("http://skin.example.com/hook", ""),
        ("https://skin.example.com/hook", "invalid secret"),
        ("https://skin.example.com/hook", "x" * 257),
    ],
    ids=["no-path", "query", "unsafe-scheme", "bad-chars", "too-long"],
)
def test_webhook_configuration_rejects_unsafe_endpoints(
    monkeypatch: pytest.MonkeyPatch, url: str, secret: str
) -> None:
    _base_env(monkeypatch)
    monkeypatch.setenv("TELEGRAM_WEBHOOK_URL", url)
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", secret)
    with pytest.raises(ValueError, match="TELEGRAM_WEBHOOK"):
        Settings.from_env()


@pytest.mark.parametrize(
    "bad_url", ["https://name:password@api.example", "https://api.example:invalid"]
)
def test_startup_requires_cache_channel_and_rejects_unsafe_public_url(
    monkeypatch: pytest.MonkeyPatch,
    bad_url: str,
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "synthetic")
    monkeypatch.setenv("MINI_APP_URL", "https://viewer.example")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.example")
    monkeypatch.delenv("TELEGRAM_CACHE_CHAT_ID", raising=False)
    with pytest.raises(ValueError, match="TELEGRAM_CACHE_CHAT_ID"):
        Settings.from_env()
    monkeypatch.setenv("TELEGRAM_CACHE_CHAT_ID", "-100123")
    monkeypatch.setenv("PUBLIC_BASE_URL", bad_url)
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
