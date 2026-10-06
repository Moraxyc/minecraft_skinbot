import asyncio
from typing import Any

import pytest
from aiogram.methods import AnswerInlineQuery, EditMessageMedia, SendMessage, SendPhoto
from aiogram.types import Document, InlineKeyboardMarkup, InlineQuery, Update, User
from minecraft_skin_bot.telegram.formatting import action_reference
from test_telegram import PLAYER, Harness, callback_update, message
from test_telegram import harness as harness


def user(language: str | None, identifier: int = 789) -> User:
    return User(id=identifier, is_bot=False, first_name="Viewer", language_code=language)


def query_message(text: str, language: str | None, **values: Any) -> Update:
    incoming = message(text=text, **values).model_copy(update={"from_user": user(language)})
    return Update(update_id=1, message=incoming)


@pytest.mark.parametrize(
    ("language", "chinese"),
    [
        (None, False),
        ("en-US", False),
        ("zh", True),
        ("zh-CN", True),
        ("zh-SG", True),
        ("zh-Hans", True),
        ("zh-Hans-CN", True),
        ("zh-Hant", False),
        ("zh-TW", False),
        ("fr", False),
        ("invalid_tag", False),
    ],
)
async def test_locale_follows_each_update_with_english_fallback(
    harness: Harness, language: str | None, chinese: bool
) -> None:
    dispatcher = harness.dispatcher()
    await dispatcher.feed_update(harness.bot, query_message("/help", language))
    help_reply = harness.session.calls[-1]
    assert isinstance(help_reply, SendMessage)
    assert ("发送 <code>Notch</code>" if chinese else "Send <code>Notch</code>") in help_reply.text
    assert "@minecraft_skin_bot Notch" in help_reply.text
    await dispatcher.feed_update(harness.bot, query_message("skin Notch", language))
    reply = harness.session.calls[-1]
    assert isinstance(reply, SendPhoto) and isinstance(reply.reply_markup, InlineKeyboardMarkup)
    assert ("模型: 经典" if chinese else "Model: Classic") in (reply.caption or "")
    assert "Notch" in (reply.caption or "") and str(PLAYER) in (reply.caption or "")
    head = reply.reply_markup.inline_keyboard[0][0]
    assert head.text == ("头像" if chinese else "Head")
    assert head.callback_data == f"p:h:private:{action_reference(PLAYER.hex)}"


async def test_callback_edits_use_the_clickers_language_not_the_message_sender(
    harness: Harness,
) -> None:
    incoming = callback_update(f"p:b:{action_reference(PLAYER.hex)}")
    assert incoming.callback_query
    callback = incoming.callback_query.model_copy(update={"from_user": user("zh-CN", 987)})
    await harness.dispatcher().feed_update(
        harness.bot, incoming.model_copy(update={"callback_query": callback})
    )
    edited = harness.session.calls[-1]
    assert isinstance(edited, EditMessageMedia)
    assert "模型: 经典" in (edited.media.caption or "")
    assert isinstance(edited.reply_markup, InlineKeyboardMarkup)
    assert edited.reply_markup.inline_keyboard[0][0].text == "头像"


async def test_concurrent_inline_languages_keep_personal_text_and_share_media_cache(
    harness: Harness,
) -> None:
    dispatcher = harness.dispatcher()
    await asyncio.gather(
        *(
            dispatcher.feed_update(
                harness.bot,
                Update(
                    update_id=index,
                    inline_query=InlineQuery(
                        id=language,
                        from_user=user(language, index),
                        query="Notch",
                        offset="",
                    ),
                ),
            )
            for index, language in enumerate(("en", "zh-CN"), start=1)
        )
    )
    answers = {
        call.inline_query_id: call
        for call in harness.session.calls
        if isinstance(call, AnswerInlineQuery)
    }
    english, chinese = answers["en"], answers["zh-CN"]
    assert all(answer.is_personal is True for answer in answers.values())
    assert [getattr(result, "title", None) for result in english.results] == [
        "Skin",
        "Three-view",
        "Head",
        "Original Skin",
    ]
    assert [getattr(result, "title", None) for result in chinese.results] == [
        "皮肤",
        "三视图",
        "头像",
        "原始皮肤",
    ]
    assert chinese.button and chinese.button.text == "打开交互式 3D 查看器"
    assert (
        len(
            [
                call
                for call in harness.session.calls
                if call.__api_method__ in {"sendPhoto", "sendDocument"}
            ]
        )
        == 4
    )
    assert [result.id for result in english.results] == [result.id for result in chinese.results]


async def test_localized_errors_preserve_named_data_and_escape_html(harness: Harness) -> None:
    dispatcher = harness.dispatcher()
    await dispatcher.feed_update(harness.bot, query_message("<missing&>", "zh"))
    failure = harness.session.calls[-1]
    assert isinstance(failure, SendMessage)
    assert "找不到玩家" in failure.text and "找不到名为" in failure.text
    assert "&lt;missing&amp;&gt;" in failure.text

    uploaded = message(
        document=Document(file_id="upload", file_unique_id="upload", file_size=0)
    ).model_copy(update={"from_user": user("zh")})
    await dispatcher.feed_update(harness.bot, Update(update_id=2, message=uploaded))
    rejected = harness.session.calls[-1]
    assert isinstance(rejected, SendMessage) and "皮肤无效" in rejected.text
    assert "小于 1 MiB" in rejected.text

    harness.session.rich_error = "timeout"
    await dispatcher.feed_update(harness.bot, query_message("Notch", "zh"))
    busy = harness.session.calls[-1]
    assert isinstance(busy, SendMessage) and "皮肤服务繁忙" in busy.text

    await dispatcher.feed_update(
        harness.bot,
        Update(
            update_id=3,
            inline_query=InlineQuery(
                id="missing", from_user=user("zh"), query="missing_player", offset=""
            ),
        ),
    )
    inline_failure = harness.session.calls[-1]
    assert isinstance(inline_failure, AnswerInlineQuery) and inline_failure.is_personal is True
    assert getattr(inline_failure.results[0], "title", None) == "找不到玩家"
    detail = getattr(inline_failure.results[0], "description", "") or ""
    assert "missing_player" in detail and "找不到名为" in detail
