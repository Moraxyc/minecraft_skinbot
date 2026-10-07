import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError, TelegramRetryAfter
from aiogram.methods import AnswerInlineQuery, GetChat, GetChatMember, SendPhoto
from aiogram.methods.base import TelegramMethod, TelegramType
from aiogram.types import (
    AcceptedGiftTypes,
    ChatFullInfo,
    ChatMemberAdministrator,
    ChatMemberLeft,
    Update,
    User,
)
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.telegram.inline import InlineSkins, SkinQuery
from minecraft_skin_bot.telegram.media import MediaCacheUnavailable, validate_media_cache
from test_service import settings
from test_telegram import Harness, Provider, TelegramSession, inline_update, message


class CacheSession(TelegramSession):
    """Synthetic transport that models cache access separately from ordinary chat replies."""

    def __init__(self) -> None:
        super().__init__()
        self.cache_chat = ChatFullInfo(
            id=-100123,
            type="channel",
            accent_color_id=0,
            max_reaction_count=3,
            accepted_gift_types=AcceptedGiftTypes.model_validate(
                dict.fromkeys(AcceptedGiftTypes.model_fields, False)
            ),
        )
        self.member = ChatMemberAdministrator(
            user=User(id=123456, is_bot=True, first_name="Synthetic Bot"),
            can_be_edited=False,
            is_anonymous=False,
            can_manage_chat=True,
            can_delete_messages=False,
            can_manage_video_chats=False,
            can_restrict_members=False,
            can_promote_members=False,
            can_change_info=False,
            can_invite_users=False,
            can_post_stories=False,
            can_edit_stories=False,
            can_delete_stories=False,
            can_send_welcome_messages=False,
            can_post_messages=True,
        )
        self.failure_method: str | None = None
        self.failure_code = 400
        self.failure_text = "Bad Request: chat not found"
        self.migrate_to_chat_id: int | None = None
        self.network_failure = False
        self.left = False
        self.retry_after: int | None = None
        self.upload_gate: asyncio.Event | None = None

    async def make_request(
        self,
        bot: Bot,
        method: TelegramMethod[TelegramType],
        timeout: int | None = None,  # noqa: ASYNC109
    ) -> TelegramType:
        target = getattr(method, "chat_id", None)
        if method.__api_method__ == self.failure_method and target == self.cache_chat.id:
            self.calls.append(method)
            if self.retry_after is not None:
                raise TelegramRetryAfter(
                    method=method, message="Synthetic flood control", retry_after=self.retry_after
                )
            if self.network_failure:
                raise TelegramNetworkError(method=method, message="Synthetic transport timeout")
            body: dict[str, object] = {
                "ok": False,
                "error_code": self.failure_code,
                "description": self.failure_text,
            }
            if self.migrate_to_chat_id:
                body["parameters"] = {"migrate_to_chat_id": self.migrate_to_chat_id}
            self.check_response(bot, method, self.failure_code, json.dumps(body))
            raise AssertionError("Synthetic failure response should raise an API error")
        if isinstance(method, GetChat):
            self.calls.append(method)
            return cast(TelegramType, self.cache_chat)
        if isinstance(method, GetChatMember):
            self.calls.append(method)
            member = ChatMemberLeft(user=self.member.user) if self.left else self.member
            return cast(TelegramType, member)
        if method.__api_method__ == "sendPhoto" and self.upload_gate is not None:
            await self.upload_gate.wait()
        return await super().make_request(bot, method, timeout)


@pytest.fixture
async def cache_harness(tmp_path: Path) -> AsyncIterator[Harness]:
    runtime = replace(settings(tmp_path), bot_token="123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT")
    provider, session = Provider(), CacheSession()
    service = SkinService(provider, FileCache(tmp_path / "content"), runtime)
    bot = Bot(runtime.bot_token, session=session)
    try:
        yield Harness(service, runtime, provider, session, bot)
    finally:
        await service.close()
        await bot.session.close()


@pytest.mark.parametrize(
    ("failed_method", "failure_code"),
    [("sendPhoto", 400), ("sendDocument", 400), ("sendPhoto", 403)],
)
async def test_inline_cache_target_failure_keeps_3d_and_recovers_all_four_media(
    cache_harness: Harness,
    caplog: pytest.LogCaptureFixture,
    failed_method: str,
    failure_code: int,
) -> None:
    session = cast(CacheSession, cache_harness.session)
    session.failure_method = failed_method
    session.failure_code = failure_code
    dispatcher = cache_harness.dispatcher()
    with caplog.at_level(logging.WARNING):
        await dispatcher.feed_update(cache_harness.bot, inline_update("Notch"))
    answer = session.calls[-1]
    assert isinstance(answer, AnswerInlineQuery)
    assert len(answer.results) == (3 if failed_method == "sendDocument" else 0)
    assert answer.cache_time == 0
    assert answer.button and answer.button.text == "Previews unavailable · Open 3D"
    assert answer.button.web_app and "uuid=" in answer.button.web_app.url
    record = next(record for record in caplog.records if hasattr(record, "operation"))
    assert record.operation == "cache_upload" and vars(record)["inline_query_id"] == "inline"
    assert vars(record)["telegram_method"] == failed_method
    assert "TELEGRAM_CACHE_CHAT_ID" in record.getMessage()
    assert "chat not found" not in record.getMessage()

    await dispatcher.feed_update(
        cache_harness.bot,
        Update(update_id=3, message=message(text="skin Notch")),
    )
    ordinary_reply = session.calls[-1]
    assert isinstance(ordinary_reply, SendPhoto) and ordinary_reply.chat_id == 789

    session.failure_method = None
    await dispatcher.feed_update(cache_harness.bot, inline_update("Notch"))
    recovered = session.calls[-1]
    assert isinstance(recovered, AnswerInlineQuery)
    assert [result.type for result in recovered.results] == ["photo", "photo", "photo", "document"]
    assert recovered.cache_time == 60


async def test_slow_cache_upload_answers_in_budget_with_cached_later_results_and_3d(
    cache_harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = cast(CacheSession, cache_harness.session)
    inline = InlineSkins(cache_harness.service, cache_harness.settings, "minecraft_skin_bot")
    asset = await cache_harness.service.resolve("Notch")
    head = await inline.file_id(cache_harness.bot, asset, "head")
    original = await inline.file_id(cache_harness.bot, asset, "skin")
    session.upload_gate = asyncio.Event()
    monkeypatch.setattr("minecraft_skin_bot.telegram.router.INLINE_QUERY_SECONDS", 0.2)
    monkeypatch.setattr("minecraft_skin_bot.telegram.router.INLINE_ANSWER_SECONDS", 0.05)
    async with asyncio.timeout(0.5):
        await cache_harness.dispatcher().feed_update(cache_harness.bot, inline_update("head Notch"))
    answer = session.calls[-1]
    assert isinstance(answer, AnswerInlineQuery)
    assert [result.type for result in answer.results] == ["photo", "document"]
    assert getattr(answer.results[0], "photo_file_id", None) == head
    assert getattr(answer.results[1], "document_file_id", None) == original
    assert answer.button and answer.button.web_app and "uuid=" in answer.button.web_app.url
    assert answer.cache_time == 0


async def test_media_retry_after_keeps_cached_results_without_retrying_uploads_before_deadline(
    cache_harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = cast(CacheSession, cache_harness.session)
    inline = InlineSkins(cache_harness.service, cache_harness.settings, "minecraft_skin_bot")
    asset = await cache_harness.service.resolve("Notch")
    head = await inline.file_id(cache_harness.bot, asset, "head")
    clock = 100.0
    monkeypatch.setattr("minecraft_skin_bot.telegram.inline.monotonic", lambda: clock)
    session.failure_method, session.retry_after = "sendPhoto", 30
    for _ in range(2):
        async with asyncio.timeout(0.5):
            results, button = await inline.results(cache_harness.bot, SkinQuery("Notch"))
        assert len(results) == 1 and getattr(results[0], "photo_file_id", None) == head
        assert button.web_app and "uuid=" in button.web_app.url
    assert len([call for call in session.calls if isinstance(call, SendPhoto)]) == 2
    clock += 31
    session.failure_method = None
    results, _ = await inline.results(cache_harness.bot, SkinQuery("Notch"))
    assert len(results) == 4


@pytest.mark.parametrize(
    ("state", "diagnostic"),
    [
        ("missing", "full signed chat ID"),
        ("left", "can access that chat"),
        ("posting", "Post Messages"),
        ("migrated", "current supergroup ID"),
    ],
)
async def test_startup_cache_checks_use_read_only_metadata_and_explain_access(
    cache_harness: Harness, state: str, diagnostic: str
) -> None:
    session = cast(CacheSession, cache_harness.session)
    if state in {"missing", "migrated"}:
        session.failure_method = "getChat"
        if state == "migrated":
            session.migrate_to_chat_id = -100456
    elif state == "left":
        session.left = True
    else:
        session.member = session.member.model_copy(update={"can_post_messages": False})
    with pytest.raises(MediaCacheUnavailable, match=diagnostic):
        await validate_media_cache(cache_harness.bot, cache_harness.settings.cache_chat_id)
    assert all(isinstance(call, (GetChat, GetChatMember)) for call in session.calls)
    for call in session.calls:
        if isinstance(call, GetChatMember):
            assert call.user_id == cache_harness.bot.id


async def test_startup_transport_failure_is_not_labelled_as_bad_cache_configuration(
    cache_harness: Harness,
) -> None:
    session = cast(CacheSession, cache_harness.session)
    session.failure_method = "getChat"
    session.network_failure = True
    with pytest.raises(TelegramNetworkError):
        await validate_media_cache(cache_harness.bot, cache_harness.settings.cache_chat_id)
    session.failure_method = None
    await validate_media_cache(cache_harness.bot, cache_harness.settings.cache_chat_id)
    assert [call.__api_method__ for call in session.calls] == [
        "getChat",
        "getChat",
        "getChatMember",
    ]


async def test_unrelated_cache_upload_error_retains_its_original_api_failure(
    cache_harness: Harness,
) -> None:
    session = cast(CacheSession, cache_harness.session)
    session.failure_method = "sendPhoto"
    session.failure_text = "Bad Request: IMAGE_PROCESS_FAILED"
    inline = InlineSkins(cache_harness.service, cache_harness.settings, "minecraft_skin_bot")
    with pytest.raises(TelegramBadRequest, match="IMAGE_PROCESS_FAILED"):
        await inline.results(cache_harness.bot, SkinQuery("Notch"))


@pytest.mark.parametrize("chat_id", ["0", str(2**52), str(-(2**52))])
def test_cache_chat_id_rejects_impossible_numeric_identifiers(
    monkeypatch: pytest.MonkeyPatch, chat_id: str
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "synthetic")
    monkeypatch.setenv("TELEGRAM_CACHE_CHAT_ID", chat_id)
    monkeypatch.setenv("MINI_APP_URL", "https://viewer.example")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://api.example")
    with pytest.raises(ValueError, match="TELEGRAM_CACHE_CHAT_ID.*signed numeric"):
        Settings.from_env()
