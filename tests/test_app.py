from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import aiohttp
import pytest
from aiogram import Bot, Dispatcher
from aiogram.methods import AnswerInlineQuery, GetMe, SetMyCommands
from aiogram.methods.base import TelegramMethod, TelegramType
from aiogram.types import Update, User
from aiohttp import web
from minecraft_skin_bot import app
from test_service import settings
from test_telegram import PLAYER, Provider, TelegramSession, inline_update, message


class StartupSession(TelegramSession):
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
        if isinstance(method, (GetMe, SetMyCommands)):
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
        for media in result.results:
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
