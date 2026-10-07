from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import AnswerCallbackQuery, AnswerInlineQuery, EditMessageText, SendPhoto
from aiogram.methods.base import TelegramMethod, TelegramType
from aiogram.types import (
    CallbackQuery,
    CopyTextButton,
    InlineQueryResultCachedDocument,
    InlineQueryResultCachedPhoto,
    InputRichBlockButtons,
    InputRichBlockDivider,
    InputRichBlockDocument,
    InputRichBlockFooter,
    InputRichBlockParagraph,
    InputRichBlockPhoto,
    InputRichMessageContent,
    RichTextBold,
    RichTextButton,
    Update,
)
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.telegram.formatting import action_reference, parse_action
from minecraft_skin_bot.telegram.inline import InlineSkins
from test_media_cache import CacheSession
from test_service import settings
from test_telegram import PLAYER, USER, Harness, Provider, copy_button_paragraph, inline_update


class InlineSession(CacheSession):
    def __init__(self) -> None:
        super().__init__()
        self.edit_failures: list[str] = []

    async def make_request(
        self,
        bot: Bot,
        method: TelegramMethod[TelegramType],
        timeout: int | None = None,  # noqa: ASYNC109
    ) -> TelegramType:
        if isinstance(method, EditMessageText) and method.inline_message_id:
            self.calls.append(method)
            if self.edit_failures:
                raise TelegramBadRequest(method=method, message=self.edit_failures.pop(0))
            return cast(TelegramType, True)
        return await super().make_request(bot, method, timeout)


@pytest.fixture
async def rich_harness(tmp_path: Path) -> AsyncIterator[Harness]:
    runtime = replace(settings(tmp_path), bot_token="123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT")
    provider, session = Provider(), InlineSession()
    service = SkinService(provider, FileCache(tmp_path / "content"), runtime)
    bot = Bot(runtime.bot_token, session=session)
    try:
        yield Harness(service, runtime, provider, session, bot)
    finally:
        await service.close()
        await bot.session.close()


def inline_callback(data: str, language: str = "en") -> Update:
    return Update(
        update_id=3,
        callback_query=CallbackQuery(
            id="inline-callback",
            from_user=USER.model_copy(update={"language_code": language}),
            chat_instance="shared-chat",
            inline_message_id="inline-message",
            data=data,
        ),
    )


@pytest.mark.parametrize("rich_enabled", [True, False])
async def test_only_inline_skin_uses_rich_content_with_cached_photo_and_actions(
    rich_harness: Harness, rich_enabled: bool
) -> None:
    rich_harness.settings = replace(rich_harness.settings, rich_messages=rich_enabled)
    await rich_harness.dispatcher().feed_update(rich_harness.bot, inline_update("Notch"))
    answer = rich_harness.session.calls[-1]
    assert isinstance(answer, AnswerInlineQuery) and answer.is_personal is True
    assert [result.type for result in answer.results] == ["photo", "photo", "photo", "document"]
    skin = answer.results[0]
    assert isinstance(skin, InlineQueryResultCachedPhoto)
    for result in answer.results[1:]:
        assert isinstance(result, (InlineQueryResultCachedPhoto, InlineQueryResultCachedDocument))
        assert result.input_message_content is None
    assert isinstance(answer.results[3], InlineQueryResultCachedDocument)
    assert answer.results[3].document_file_id.startswith("doc-")
    assert (
        answer.button
        and answer.button.web_app
        and f"uuid={PLAYER.hex}" in answer.button.web_app.url
    )
    if not rich_enabled:
        assert skin.input_message_content is None and skin.reply_markup is not None
        return
    assert isinstance(skin.input_message_content, InputRichMessageContent)
    assert skin.reply_markup is None
    blocks = skin.input_message_content.rich_message.blocks or []
    photo = next(block for block in blocks if isinstance(block, InputRichBlockPhoto))
    assert photo.photo.media == skin.photo_file_id
    model_line = next(block for block in blocks if isinstance(block, InputRichBlockParagraph))
    assert isinstance(model_line.text, list)
    assert model_line.text[0] == "Model: "
    assert isinstance(model_line.text[-1], RichTextBold)
    assert model_line.text[-1].text == "Classic"
    assert any(isinstance(block, InputRichBlockDivider) for block in blocks)
    rows = [block for block in blocks if isinstance(block, InputRichBlockButtons)]
    assert [button.text for row in rows[:2] for button in row.buttons] == [
        "Front",
        "Back",
        "Side",
        "Head",
        "Three-view",
    ]
    for row in rows[:2]:
        for button in row.buttons:
            assert button.callback_data and len(button.callback_data.encode()) <= 64
            assert parse_action(button.callback_data)[0] == PLAYER.hex
    actions = rows[-1].buttons
    assert [button.text for button in actions] == ["Original", "Open 3D", "Share"]
    assert actions[1].url == f"https://t.me/minecraft_skin_bot?startapp={PLAYER.hex}"
    assert all(button.web_app is None for button in actions)
    assert actions[2].switch_inline_query == PLAYER.hex
    uuid_line = copy_button_paragraph(blocks)
    assert isinstance(uuid_line.text, list)
    copy = uuid_line.text[-1]
    assert isinstance(copy, RichTextButton) and isinstance(copy.button.copy_text, CopyTextButton)
    assert copy.button.copy_text.text == str(PLAYER)


@pytest.mark.parametrize("uploaded", [False, True])
async def test_inline_callback_without_message_rebuilds_cached_rich_for_clickers_language(
    rich_harness: Harness, uploaded: bool
) -> None:
    asset = (
        await rich_harness.service.upload(rich_harness.provider.png)
        if uploaded
        else await rich_harness.service.resolve("Notch")
    )
    reference = action_reference(asset.reference)
    await rich_harness.dispatcher().feed_update(
        rich_harness.bot, inline_callback(f"p:b:{reference}", "zh-CN")
    )
    edits = [call for call in rich_harness.session.calls if isinstance(call, EditMessageText)]
    assert len(edits) == 1
    edit = edits[0]
    assert (
        edit.inline_message_id == "inline-message"
        and edit.chat_id is None
        and edit.message_id is None
    )
    assert edit.rich_message and edit.text is None
    blocks = edit.rich_message.blocks or []
    if uploaded:
        expiry = next(block for block in blocks if isinstance(block, InputRichBlockFooter))
        assert "到期。到期后请重新发送 PNG。" in expiry.text
    photo = next(block for block in blocks if isinstance(block, InputRichBlockPhoto))
    assert isinstance(photo.photo.media, str) and photo.photo.media.startswith("photo-")
    rows = [block for block in blocks if isinstance(block, InputRichBlockButtons)]
    assert [button.text for button in rows[0].buttons] == ["正面", "背面", "侧面"]
    assert [button.text for button in rows[1].buttons] == ["头像", "三视图"]
    assert rows[0].buttons[1].style == "primary"
    assert all(
        parse_action(button.callback_data or "")[0] == asset.reference
        for row in rows[:2]
        for button in row.buttons
    )
    assert rows[-1].buttons[1].url == (
        f"https://t.me/minecraft_skin_bot?startapp={reference if uploaded else PLAYER.hex}"
    )
    ack = rich_harness.session.calls[-1]
    assert isinstance(ack, AnswerCallbackQuery) and not ack.show_alert
    uploads = [call for call in rich_harness.session.calls if call.__api_method__ == "sendPhoto"]
    assert len(uploads) == 1
    assert isinstance(uploads[0], SendPhoto)
    assert uploads[0].chat_id == rich_harness.settings.cache_chat_id
    await rich_harness.dispatcher().feed_update(
        rich_harness.bot, inline_callback(f"p:o:{reference}")
    )
    original = next(
        call for call in reversed(rich_harness.session.calls) if isinstance(call, EditMessageText)
    )
    assert original.rich_message
    document = next(
        block
        for block in original.rich_message.blocks or []
        if isinstance(block, InputRichBlockDocument)
    )
    assert isinstance(document.document.media, str) and document.document.media.startswith("doc-")
    assert all(
        call.__api_method__ not in {"sendMessage", "sendRichMessage", "editMessageMedia"}
        for call in rich_harness.session.calls
    )


async def test_inline_callback_keeps_the_scope_of_the_chat_it_was_sent_from(
    rich_harness: Harness,
) -> None:
    reference = action_reference(PLAYER.hex)
    await rich_harness.dispatcher().feed_update(
        rich_harness.bot, inline_callback(f"p:h:private:{reference}", "zh-CN")
    )
    edit = next(call for call in rich_harness.session.calls if isinstance(call, EditMessageText))
    assert edit.rich_message is not None
    rows = [
        block
        for block in edit.rich_message.blocks or []
        if isinstance(block, InputRichBlockButtons)
    ]
    head = next(button for row in rows for button in row.buttons if button.text == "头像")
    assert parse_action(head.callback_data or "") == (PLAYER.hex, "head", True)
    assert head.style == "primary"
    opened = next(button for button in rows[-1].buttons if button.text == "打开 3D")
    assert opened.web_app is not None
    assert opened.web_app.url == f"https://viewer.example?uuid={PLAYER.hex}&lang=zh_Hans"


@pytest.mark.parametrize("data", ["p:h:bad", "p:h:" + action_reference("upload:" + "0" * 64)])
async def test_invalid_or_expired_inline_action_answers_with_alert_without_editing(
    rich_harness: Harness, data: str
) -> None:
    await rich_harness.dispatcher().feed_update(rich_harness.bot, inline_callback(data))
    assert len(rich_harness.session.calls) == 1
    answer = rich_harness.session.calls[0]
    assert isinstance(answer, AnswerCallbackQuery) and answer.show_alert
    assert answer.text in {
        "Send the player name or upload the skin again.",
        "Send the skin PNG to the bot again.",
    }


async def test_inline_edit_repairs_expired_file_id_once_for_the_selected_view(
    rich_harness: Harness,
) -> None:
    inline = InlineSkins(rich_harness.service, rich_harness.settings, "minecraft_skin_bot")
    asset = await rich_harness.service.resolve("Notch")
    stale = await inline.file_id(rich_harness.bot, asset, "head")
    original = await inline.file_id(rich_harness.bot, asset, "skin")
    session = cast(InlineSession, rich_harness.session)
    session.edit_failures = ["Bad Request: wrong remote file identifier specified: expired"]
    await rich_harness.dispatcher().feed_update(
        rich_harness.bot, inline_callback(f"p:h:{action_reference(PLAYER.hex)}")
    )
    edits = [call for call in session.calls if isinstance(call, EditMessageText)]
    assert len(edits) == 2
    photos = [
        block.photo.media
        for edit in edits
        for block in (edit.rich_message.blocks if edit.rich_message else []) or []
        if isinstance(block, InputRichBlockPhoto)
    ]
    assert photos[0] == stale and photos[1] != stale
    assert await inline.file_id(rich_harness.bot, asset, "skin") == original
    assert isinstance(session.calls[-1], AnswerCallbackQuery)
    assert len([call for call in session.calls if isinstance(call, AnswerCallbackQuery)]) == 1


@pytest.mark.parametrize("failure", ["message is not modified", "reply markup is too long"])
async def test_inline_edit_handles_unchanged_or_api_failure_with_one_callback_answer(
    rich_harness: Harness, failure: str
) -> None:
    session = cast(InlineSession, rich_harness.session)
    session.edit_failures = ["Bad Request: " + failure]
    await rich_harness.dispatcher().feed_update(
        rich_harness.bot, inline_callback(f"p:h:{action_reference(PLAYER.hex)}")
    )
    answers = [call for call in session.calls if isinstance(call, AnswerCallbackQuery)]
    assert len(answers) == 1
    if "not modified" in failure:
        assert not answers[0].show_alert
    else:
        assert answers[0].show_alert and answers[0].text == "Try again in a moment."


async def test_inline_callback_cache_access_failure_alerts_and_recovers(
    rich_harness: Harness,
) -> None:
    session = cast(InlineSession, rich_harness.session)
    session.failure_method = "sendPhoto"
    update = inline_callback(f"p:b:{action_reference(PLAYER.hex)}")
    await rich_harness.dispatcher().feed_update(rich_harness.bot, update)
    answer = session.calls[-1]
    assert isinstance(answer, AnswerCallbackQuery) and answer.show_alert
    assert answer.text == "Send the player name again in a moment."
    assert not any(isinstance(call, EditMessageText) for call in session.calls)
    session.failure_method = None
    await rich_harness.dispatcher().feed_update(rich_harness.bot, update)
    assert any(isinstance(call, EditMessageText) for call in session.calls)
