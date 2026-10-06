import asyncio
import os
import socket
import stat
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import aiohttp
import pytest
from aiogram import Bot, Dispatcher
from aiogram.methods import AnswerInlineQuery, GetMe, SendMessage, SetMyCommands, SetWebhook
from aiogram.methods.base import TelegramMethod, TelegramType
from aiogram.types import Update, User
from aiohttp import web
from minecraft_skin_bot import app
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Webhook
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.telegram.media import MediaCacheUnavailable
from minecraft_skin_bot.web import create_web_app
from test_media_cache import CacheSession
from test_service import settings
from test_telegram import PLAYER, Provider, inline_update, message


class StartupSession(CacheSession):
    def __init__(self, username: str | None) -> None:
        super().__init__()
        self.identity = User(id=123456, is_bot=True, first_name="Skin Bot", username=username)
        self.closed = False

    async def close(self) -> None:
        self.closed = True

    async def make_request(
        self,
        bot: Bot,
        method: TelegramMethod[TelegramType],
        timeout: int | None = None,  # noqa: ASYNC109
    ) -> TelegramType:
        if isinstance(method, (GetMe, SetMyCommands, SetWebhook)):
            self.calls.append(method)
            return cast(TelegramType, self.identity if isinstance(method, GetMe) else True)
        return await super().make_request(bot, method, timeout)


class StartupProvider(Provider):
    async def close(self) -> None:
        pass


@pytest.mark.parametrize("username", ["runtime_skin_bot", "renamed_skin_bot"])
async def test_startup_identity_drives_telegram_links_and_public_viewer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, username: str
) -> None:
    session = StartupSession(username)
    bot = Bot("123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT", session=session)
    provider = StartupProvider()
    runtime = replace(settings(tmp_path), bot_token=bot.token, api_port=0)
    runner_type = web.AppRunner
    runners: list[web.AppRunner] = []

    def create_runner(application: web.Application, **kwargs: Any) -> web.AppRunner:
        runner = runner_type(application, **kwargs)
        runners.append(runner)
        return runner

    async def poll(dispatcher: Dispatcher, current_bot: Bot, **kwargs: Any) -> None:
        assert await current_bot.me() == session.identity
        for index, command in enumerate(("/start", "/help"), start=1):
            await dispatcher.feed_update(
                current_bot, Update(update_id=index, message=message(text=command))
            )
            assert f"@{username} Notch" in getattr(session.calls[-1], "text", "")
        await dispatcher.feed_update(current_bot, inline_update("Notch"))
        result = session.calls[-1]
        assert isinstance(result, AnswerInlineQuery)
        assert len(result.results) == 4
        for media in result.results[1:]:
            assert media.reply_markup is not None
            assert media.reply_markup.inline_keyboard[0][0].url == (
                f"https://t.me/{username}?startapp={PLAYER.hex}"
            )
        address = runners[0].addresses[0]
        async with aiohttp.ClientSession() as client:
            async with client.get(
                f"http://127.0.0.1:{address[1]}/api/profile/{PLAYER.hex}"
            ) as response:
                assert response.status == 200
                assert (await response.json())["bot_username"] == username

    monkeypatch.setenv("BOT_USERNAME", "stale_skin_bot")
    monkeypatch.setenv("VITE_BOT_USERNAME", "stale_skin_bot")
    monkeypatch.setattr(app, "Bot", lambda token: bot)
    monkeypatch.setattr(app, "MojangProfileProvider", lambda http: provider)
    monkeypatch.setattr(web, "AppRunner", create_runner)
    monkeypatch.setattr(Dispatcher, "start_polling", poll)
    await app.run(runtime)
    commands = [call for call in session.calls if isinstance(call, SetMyCommands)]
    assert [(call.language_code, call.commands[0].description) for call in commands] == [
        (None, "Search and share Minecraft skins"),
        ("zh", "查询和分享 Minecraft 皮肤"),
    ]
    assert sum(isinstance(call, GetMe) for call in session.calls) == 1
    assert session.closed and runners[0].addresses == []


async def test_missing_runtime_username_fails_with_actionable_message_and_closes_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    session = StartupSession(None)
    bot = Bot("123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT", session=session)
    runtime = replace(settings(tmp_path), bot_token=bot.token, api_port=0)
    monkeypatch.setattr(app, "Bot", lambda token: bot)
    monkeypatch.setattr(app, "MojangProfileProvider", lambda http: StartupProvider())
    with pytest.raises(ValueError, match="getMe.*username"):
        await app.run(runtime)
    assert "BotFather" in caplog.text
    assert [call.__api_method__ for call in session.calls] == ["getMe"]
    assert session.closed


async def test_invalid_cache_target_stops_before_updates_with_actionable_message(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    session = StartupSession("runtime_skin_bot")
    session.failure_method = "getChat"
    bot = Bot("123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT", session=session)
    runtime = replace(settings(tmp_path), bot_token=bot.token, api_port=0)
    monkeypatch.setattr(app, "Bot", lambda token: bot)
    monkeypatch.setattr(app, "MojangProfileProvider", lambda http: StartupProvider())
    with pytest.raises(MediaCacheUnavailable, match="TELEGRAM_CACHE_CHAT_ID"):
        await app.run(runtime)
    assert "full signed chat ID" in caplog.text
    assert "chat not found" not in caplog.text
    assert [call.__api_method__ for call in session.calls] == ["getMe", "getChat"]
    assert session.closed


async def test_unix_socket_listener_replaces_stale_socket_and_serves_api(tmp_path: Path) -> None:
    runtime = settings(tmp_path)
    socket_path = tmp_path / "run" / "api.sock"
    socket_path.parent.mkdir()
    socket_path.touch()
    service = SkinService(StartupProvider(), FileCache(tmp_path / "content"), runtime)
    runner = web.AppRunner(create_web_app(service, "runtime_skin_bot"), access_log=None)
    await runner.setup()
    try:
        await app.start_listener(runner, replace(runtime, api_unix_socket=socket_path))
        assert stat.S_ISSOCK(socket_path.stat().st_mode)
        async with aiohttp.ClientSession(
            connector=aiohttp.UnixConnector(str(socket_path))
        ) as client:
            async with client.get("http://unix/healthz") as response:
                assert response.status == 200
                assert await response.json() == {"status": "ok"}
    finally:
        await runner.cleanup()
        await service.close()


def test_inherited_sockets_ignores_foreign_and_malformed_activation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LISTEN_PID", str(os.getpid() + 1))
    monkeypatch.setenv("LISTEN_FDS", "1")
    assert app.inherited_sockets() == []
    monkeypatch.setenv("LISTEN_PID", str(os.getpid()))
    monkeypatch.setenv("LISTEN_FDS", "invalid")
    assert app.inherited_sockets() == []
    monkeypatch.delenv("LISTEN_FDS")
    assert app.inherited_sockets() == []


async def test_systemd_socket_listener_serves_api_from_inherited_descriptor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = settings(tmp_path)
    service = SkinService(StartupProvider(), FileCache(tmp_path / "content"), runtime)
    runner = web.AppRunner(create_web_app(service, "runtime_skin_bot"), access_log=None)
    await runner.setup()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    monkeypatch.setattr(app, "SD_LISTEN_FDS_START", os.dup(listener.fileno()))
    monkeypatch.setenv("LISTEN_PID", str(os.getpid()))
    monkeypatch.setenv("LISTEN_FDS", "1")
    try:
        await app.start_listener(runner, runtime)
        async with aiohttp.ClientSession() as client:
            async with client.get(f"http://127.0.0.1:{port}/healthz") as response:
                assert response.status == 200
                assert await response.json() == {"status": "ok"}
    finally:
        listener.close()
        await runner.cleanup()
        await service.close()


async def test_webhook_registration_serves_secret_guarded_updates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    username = "runtime_skin_bot"
    session = StartupSession(username)
    bot = Bot("123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT", session=session)
    provider = StartupProvider()
    webhook = Webhook(
        "https://skin.example.com/telegram/hook", "/telegram/hook", "synthetic_secret"
    )
    runtime = replace(settings(tmp_path), bot_token=bot.token, api_port=0, webhook=webhook)
    runner_type = web.AppRunner
    runners: list[web.AppRunner] = []
    polling_calls: list[str] = []

    def create_runner(application: web.Application, **kwargs: Any) -> web.AppRunner:
        runner = runner_type(application, **kwargs)
        runners.append(runner)
        return runner

    async def poll(dispatcher: Dispatcher, current_bot: Bot, **kwargs: Any) -> None:
        polling_calls.append("polling")
        raise AssertionError("webhook delivery must not start long polling")

    monkeypatch.setattr(app, "Bot", lambda token: bot)
    monkeypatch.setattr(app, "MojangProfileProvider", lambda http: provider)
    monkeypatch.setattr(web, "AppRunner", create_runner)
    monkeypatch.setattr(Dispatcher, "start_polling", poll)

    update = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "date": 1700000000,
            "chat": {"id": 789, "type": "private"},
            "from": {"id": 789, "is_bot": False, "first_name": "Test"},
            "text": "/start",
        },
    }
    delivered = asyncio.create_task(app.run(runtime))
    try:
        for _ in range(300):
            if any(isinstance(call, SetWebhook) for call in session.calls) and runners[0].addresses:
                break
            await asyncio.sleep(0.01)
        registration = next(call for call in session.calls if isinstance(call, SetWebhook))
        assert registration.url == webhook.url
        assert registration.secret_token == webhook.secret
        assert {"message", "inline_query", "callback_query"} <= set(
            registration.allowed_updates or []
        )
        port = runners[0].addresses[0][1]
        async with aiohttp.ClientSession() as client:
            url = f"http://127.0.0.1:{port}{webhook.path}"
            async with client.post(url, json=update) as response:
                assert response.status == 401
            async with client.post(
                url, json=update, headers={"X-Telegram-Bot-Api-Secret-Token": "stale"}
            ) as response:
                assert response.status == 401
            async with client.post(
                url, json=update, headers={"X-Telegram-Bot-Api-Secret-Token": webhook.secret}
            ) as response:
                assert response.status == 200
        for _ in range(300):
            if any(isinstance(call, SendMessage) for call in session.calls):
                break
            await asyncio.sleep(0.01)
        reply = next(call for call in session.calls if isinstance(call, SendMessage))
        assert f"@{username} Notch" in (reply.text or "")
    finally:
        delivered.cancel()
        await asyncio.gather(delivered, return_exceptions=True)
    assert polling_calls == []
    assert session.closed and runners[0].addresses == []
