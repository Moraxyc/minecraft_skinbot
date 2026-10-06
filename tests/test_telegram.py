import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.exceptions import TelegramBadRequest, TelegramNotFound
from aiogram.methods import AnswerInlineQuery, SendPhoto, SendRichMessage
from aiogram.methods.base import TelegramMethod, TelegramType
from aiogram.types import (
    Chat,
    Document,
    File,
    InlineKeyboardMarkup,
    InlineQuery,
    InlineQueryResultCachedDocument,
    InlineQueryResultCachedPhoto,
    InputRichBlockButtons,
    InputRichBlockPhoto,
    Message,
    PhotoSize,
    Update,
    User,
)
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.models import Profile, SkinModel
from minecraft_skin_bot.service import SkinAsset, SkinService
from minecraft_skin_bot.telegram import create_router
from minecraft_skin_bot.telegram.formatting import (
    action_reference,
    caption,
    mini_app_link,
    parse_action,
    preview_markup,
)
from minecraft_skin_bot.telegram.inline import InlineSkins, SkinQuery, parse_query
from minecraft_skin_bot.telegram.router import SkinMessages
from PIL import Image

PLAYER = UUID("069a79f4-44e9-4726-a5be-fca90e38aaf5")
USER = User(id=789, is_bot=False, first_name="Test")


class Provider:
    def __init__(self) -> None:
        self.lookups = 0
        output = BytesIO()
        image = Image.new("RGBA", (64, 64), (120, 160, 80, 255))
        image.putpixel((63, 63), (0, 0, 0, 0))
        image.save(output, format="PNG")
        self.png = output.getvalue()

    async def resolve_username(self, username: str) -> UUID:
        self.lookups += 1
        if username != "Notch":
            raise UtilityError(
                "Player not found", f'No Minecraft profile named "{username}" was found.'
            )
        return PLAYER

    async def get_profile(self, uuid: UUID) -> Profile:
        return Profile(
            uuid, "Notch", SkinModel.CLASSIC, "https://textures.minecraft.net/texture/test", None
        )

    async def get_skin(self, url: str) -> bytes:
        return self.png


class TelegramSession(BaseSession):
    """An in-process Bot API transport with realistic typed method results."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[TelegramMethod[Any]] = []
        self.upload = b"malformed png"
        self.downloaded_bytes = 0
        self.rich_error: str | None = None
        self.inline_error: str | None = None
        self.inline_error_count = 1

    async def close(self) -> None:
        pass

    async def make_request(
        self,
        bot: Bot,
        method: TelegramMethod[TelegramType],
        timeout: int | None = None,  # noqa: ASYNC109
    ) -> TelegramType:
        self.calls.append(method)
        name = method.__api_method__
        if name == "sendRichMessage" and self.rich_error:
            if self.rich_error == "timeout":
                raise TimeoutError("Synthetic transport timeout")
            error_type = TelegramNotFound if self.rich_error == "Not Found" else TelegramBadRequest
            raise error_type(method=method, message=self.rich_error)
        if name == "answerInlineQuery" and self.inline_error and self.inline_error_count:
            self.inline_error_count -= 1
            raise TelegramBadRequest(method=method, message=self.inline_error)
        if name in {"answerInlineQuery", "answerCallbackQuery"}:
            return cast(TelegramType, True)
        if name == "getFile":
            return cast(
                TelegramType, File(file_id="file", file_unique_id="file", file_path="skin.png")
            )
        values: dict[str, Any] = {}
        if name == "sendPhoto":
            values["photo"] = [
                PhotoSize(
                    file_id=f"photo-{len(self.calls)}",
                    file_unique_id="photo",
                    width=384,
                    height=640,
                )
            ]
        elif name == "sendDocument":
            values["document"] = Document(
                file_id=f"doc-{len(self.calls)}", file_unique_id="doc", file_name="skin.png"
            )
        return cast(
            TelegramType,
            Message(
                message_id=len(self.calls),
                date=datetime.now(UTC),
                chat=Chat(id=getattr(method, "chat_id", 789), type="private"),
                **values,
            ),
        )

    async def stream_content(
        self,
        url: str,
        headers: dict[str, Any] | None = None,
        timeout: int = 30,  # noqa: ASYNC109
        chunk_size: int = 65536,
        raise_for_status: bool = True,
    ) -> AsyncGenerator[bytes, None]:
        for offset in range(0, len(self.upload), chunk_size):
            chunk = self.upload[offset : offset + chunk_size]
            self.downloaded_bytes += len(chunk)
            yield chunk


@dataclass
class Harness:
    service: SkinService
    settings: Settings
    provider: Provider
    session: TelegramSession
    bot: Bot

    def dispatcher(self) -> Dispatcher:
        dispatcher = Dispatcher(disable_fsm=True)
        dispatcher.include_router(create_router(self.service, self.settings, "minecraft_skin_bot"))
        return dispatcher


@pytest.fixture
async def harness(tmp_path: Path) -> AsyncIterator[Harness]:
    settings = Settings(
        bot_token="123456:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT",
        cache_chat_id=-100123,
        mini_app_url="https://skin.example/view",
        public_base_url="https://api.example",
        cache_dir=tmp_path,
    )
    provider, session = Provider(), TelegramSession()
    service = SkinService(provider, FileCache(tmp_path / "content"), settings)
    bot = Bot(settings.bot_token, session=session)
    yield Harness(service, settings, provider, session, bot)
    await service.close()
    await bot.session.close()


def message(**data: Any) -> Message:
    return Message(
        message_id=1,
        date=datetime.now(UTC),
        chat=Chat(id=789, type="private"),
        from_user=USER,
        **data,
    )


def inline_update(text: str) -> Update:
    return Update(
        update_id=2, inline_query=InlineQuery(id="inline", from_user=USER, query=text, offset="")
    )


@pytest.mark.parametrize("reference", ["Notch", str(PLAYER)])
async def test_plain_name_and_uuid_send_complete_rich_skin(
    harness: Harness, reference: str
) -> None:
    await harness.dispatcher().feed_update(
        harness.bot, Update(update_id=1, message=message(text=reference))
    )
    output = harness.session.calls[-1]
    assert isinstance(output, SendRichMessage)
    blocks = output.rich_message.blocks or []
    assert any(isinstance(block, InputRichBlockPhoto) for block in blocks)
    rows = [block for block in blocks if isinstance(block, InputRichBlockButtons)]
    assert [button.text for button in rows[-1].buttons] == ["Open 3D", "Share", "Copy UUID"]
    assert rows[-1].buttons[0].web_app is not None
    assert rows[-1].buttons[1].switch_inline_query == PLAYER.hex
    assert rows[-1].buttons[2].copy_text is not None
    assert rows[-1].buttons[2].copy_text.text == str(PLAYER)


async def test_inline_has_four_real_media_results_and_uuid_viewer(harness: Harness) -> None:
    dispatcher = harness.dispatcher()
    await dispatcher.feed_update(harness.bot, inline_update("Notch"))
    answer = harness.session.calls[-1]
    assert isinstance(answer, AnswerInlineQuery)
    assert [result.title for result in answer.results if hasattr(result, "title")] == [
        "Skin",
        "Three-view",
        "Head",
        "Original Skin",
    ]
    assert all(isinstance(result, InlineQueryResultCachedPhoto) for result in answer.results[:3])
    assert isinstance(answer.results[3], InlineQueryResultCachedDocument)
    assert answer.results[3].document_file_id.startswith("doc-")
    assert answer.button and answer.button.web_app
    assert answer.button.web_app.url == f"https://skin.example/view?uuid={PLAYER.hex}"
    for result in answer.results:
        assert result.reply_markup is not None
        assert (
            result.reply_markup.inline_keyboard[0][0].url
            == f"https://t.me/minecraft_skin_bot?startapp={PLAYER.hex}"
        )
    uploads_before = len(
        [
            call
            for call in harness.session.calls
            if call.__api_method__ in {"sendPhoto", "sendDocument"}
        ]
    )
    await dispatcher.feed_update(harness.bot, inline_update("view Notch"))
    reordered = harness.session.calls[-1]
    assert isinstance(reordered, AnswerInlineQuery)
    assert isinstance(reordered.results[0], InlineQueryResultCachedPhoto)
    assert reordered.results[0].title == "Three-view"
    assert (
        len(
            [
                call
                for call in harness.session.calls
                if call.__api_method__ in {"sendPhoto", "sendDocument"}
            ]
        )
        == uploads_before
    )
    lookups = harness.provider.lookups
    await dispatcher.feed_update(harness.bot, inline_update("No"))
    short = harness.session.calls[-1]
    assert isinstance(short, AnswerInlineQuery) and short.results == []
    assert harness.provider.lookups == lookups


async def test_concurrent_inline_uploads_are_deduplicated_and_cache_deletion_recovers(
    harness: Harness,
) -> None:
    inline = InlineSkins(harness.service, harness.settings, "minecraft_skin_bot")
    batches = await asyncio.gather(
        *(inline.results(harness.bot, SkinQuery("Notch")) for _ in range(6))
    )
    uploads = [
        call
        for call in harness.session.calls
        if call.__api_method__ in {"sendPhoto", "sendDocument"}
    ]
    assert len(uploads) == 4
    assert all(
        [result.id for result in batch[0]] == [result.id for result in batches[0][0]]
        for batch in batches
    )
    for path in harness.service.cache.directory.iterdir():
        path.unlink()
    await inline.results(harness.bot, SkinQuery("Notch"))
    assert (
        len(
            [
                call
                for call in harness.session.calls
                if call.__api_method__ in {"sendPhoto", "sendDocument"}
            ]
        )
        == 8
    )


@pytest.mark.parametrize("error", ["Not Found", "Method not found"])
async def test_unsupported_rich_api_sends_one_compatible_photo(
    harness: Harness, error: str
) -> None:
    harness.session.rich_error = error
    asset = await harness.service.resolve("Notch")
    await SkinMessages(harness.service, harness.settings, "minecraft_skin_bot").send(
        harness.bot, message(), asset
    )
    assert [call.__api_method__ for call in harness.session.calls] == [
        "sendRichMessage",
        "sendPhoto",
    ]
    output = harness.session.calls[-1]
    assert isinstance(output, SendPhoto) and isinstance(output.reply_markup, InlineKeyboardMarkup)
    assert "069a79f4-44e9-4726-a5be-fca90e38aaf5" in (output.caption or "")


@pytest.mark.parametrize("error", ["timeout", "Bad Request: chat not found"])
async def test_other_rich_errors_propagate_without_duplicate_send(
    harness: Harness, error: str
) -> None:
    harness.session.rich_error = error
    asset = await harness.service.resolve("Notch")
    with pytest.raises((TimeoutError, TelegramBadRequest)):
        await SkinMessages(harness.service, harness.settings, "minecraft_skin_bot").send(
            harness.bot, message(), asset
        )
    assert [call.__api_method__ for call in harness.session.calls] == ["sendRichMessage"]


async def test_invalid_cached_file_id_reuploads_once(harness: Harness) -> None:
    harness.session.inline_error = "Bad Request: wrong file identifier/HTTP URL specified"
    await harness.dispatcher().feed_update(harness.bot, inline_update("Notch"))
    assert len([call for call in harness.session.calls if call.__api_method__ == "sendPhoto"]) == 6
    assert (
        len([call for call in harness.session.calls if call.__api_method__ == "sendDocument"]) == 2
    )
    assert len([call for call in harness.session.calls if isinstance(call, AnswerInlineQuery)]) == 2


async def test_unrelated_inline_failure_preserves_upload_cache(harness: Harness) -> None:
    harness.session.inline_error = "Bad Request: query is too old"
    await harness.dispatcher().feed_update(harness.bot, inline_update("Notch"))
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
    recovered = harness.session.calls[-1]
    assert isinstance(recovered, AnswerInlineQuery)
    assert recovered.results[0].id == "service-busy"


@pytest.mark.parametrize(
    "metadata",
    [
        {
            "file_name": "skin.PNG",
            "mime_type": "image/png",
            "thumbnail": PhotoSize(
                file_id="thumbnail", file_unique_id="thumbnail", width=320, height=160
            ),
        },
        {"file_name": "skin.jpg", "mime_type": "application/octet-stream"},
        {"file_size": None},
        {"file_name": "skin.png", "mime_type": "text/plain"},
        {"file_name": "skin.jpg", "mime_type": "image/png"},
        {"mime_type": "image/jpeg"},
        {"file_name": "skin.jpg"},
    ],
    ids=[
        "png",
        "generic-mime",
        "missing",
        "mislabelled-mime",
        "mislabelled-name",
        "mime-only",
        "name-only",
    ],
)
async def test_uploaded_png_actions_remain_self_contained(
    harness: Harness, metadata: dict[str, Any]
) -> None:
    harness.session.upload = harness.provider.png
    uploaded = message(
        document=Document(
            file_id="upload",
            file_unique_id="upload",
            **{"file_size": len(harness.provider.png), **metadata},
        )
    )
    await harness.dispatcher().feed_update(harness.bot, Update(update_id=1, message=uploaded))
    output = harness.session.calls[-1]
    assert isinstance(output, SendPhoto)
    assert output.reply_markup and hasattr(output.reply_markup, "inline_keyboard")
    first_action = output.reply_markup.inline_keyboard[0][0].callback_data
    assert first_action and len(first_action.encode()) <= 64
    reference, kind = parse_action(first_action)
    asset = await harness.service.resolve(reference)
    assert kind == "head" and asset.skin == harness.provider.png
    startapp = mini_app_link(asset, "minecraft_skin_bot").split("startapp=", 1)[1]
    assert len(startapp) == 44 and ":" not in startapp
    assert parse_action("p:t:" + startapp) == (reference, "three-view")


@pytest.mark.parametrize(
    "metadata",
    [
        {"file_size": 0},
        {"file_size": 1024 * 1024 + 1},
        {"file_name": "skin.jpg", "mime_type": "image/jpeg"},
    ],
    ids=["empty", "oversize", "non-png"],
)
async def test_upload_metadata_rejects_before_download(
    harness: Harness, metadata: dict[str, Any]
) -> None:
    harness.session.upload = harness.provider.png
    uploaded = message(
        document=Document(
            file_id="upload",
            file_unique_id="upload",
            **{"file_size": len(harness.provider.png), **metadata},
        )
    )
    await harness.dispatcher().feed_update(harness.bot, Update(update_id=1, message=uploaded))
    assert [call.__api_method__ for call in harness.session.calls] == ["sendMessage"]
    assert "Invalid skin" in getattr(harness.session.calls[-1], "text", "")


async def test_standard_photo_prefix_preserves_all_skin_actions(harness: Harness) -> None:
    await harness.dispatcher().feed_update(
        harness.bot, Update(update_id=1, message=message(text="skin Notch"))
    )
    output = harness.session.calls[-1]
    assert isinstance(output, SendPhoto) and isinstance(output.reply_markup, InlineKeyboardMarkup)
    buttons = [button for row in output.reply_markup.inline_keyboard for button in row]
    assert [button.text for button in buttons] == [
        "Head",
        "Front",
        "Back",
        "Side",
        "Three-view",
        "Original",
        "Open 3D",
        "Share",
        "Copy UUID",
    ]
    assert all(parse_action(button.callback_data or "")[0] == PLAYER.hex for button in buttons[:6])


async def test_request_timeout_recovers_without_resending_original_media(harness: Harness) -> None:
    harness.session.rich_error = "timeout"
    await harness.dispatcher().feed_update(
        harness.bot, Update(update_id=1, message=message(text="Notch"))
    )
    assert [call.__api_method__ for call in harness.session.calls] == [
        "sendRichMessage",
        "sendMessage",
    ]
    assert "Skin service is busy" in getattr(harness.session.calls[-1], "text", "")


async def test_file_cache_is_separate_for_bot_identity_and_arm_model(harness: Harness) -> None:
    inline = InlineSkins(harness.service, harness.settings, "minecraft_skin_bot")
    classic = await harness.service.resolve("Notch")
    first = await inline.file_id(harness.bot, classic, "front")
    slim = await inline.file_id(harness.bot, replace(classic, model=SkinModel.SLIM), "front")
    other_bot = Bot("654321:SYNTHETIC_TEST_TOKEN_WITHOUT_ACCOUNT", session=harness.session)
    other = await inline.file_id(other_bot, classic, "front")
    assert len({first, slim, other}) == 3


@pytest.mark.parametrize("oversize", [False, True], ids=["false-png", "unknown-size-overflow"])
async def test_invalid_upload_returns_clean_error_after_bounded_download(
    harness: Harness, oversize: bool
) -> None:
    if oversize:
        harness.session.upload = b"x" * (harness.settings.max_upload_bytes * 2)
    invalid = message(
        document=Document(
            file_id="upload",
            file_unique_id="upload",
            file_size=None if oversize else len(harness.session.upload),
            file_name="skin.png",
            mime_type="image/png",
        )
    )
    await harness.dispatcher().feed_update(harness.bot, Update(update_id=1, message=invalid))
    output = harness.session.calls[-1]
    assert harness.session.calls[0].__api_method__ == "getFile"
    assert output.__api_method__ == "sendMessage"
    assert "Invalid skin" in getattr(output, "text", "")
    if oversize:
        assert harness.session.downloaded_bytes < len(harness.session.upload)


def test_query_and_action_boundaries_and_caption_escaping() -> None:
    assert parse_query("head Notch") == SkinQuery("Notch", "head")
    assert parse_query("skin " + PLAYER.hex) == SkinQuery(PLAYER.hex, "skin")
    assert parse_query("https://example.test/skin.png") is None
    assert parse_query("view Notch extra") is None
    for reference in (PLAYER.hex, "upload:" + "ab" * 32):
        action = "p:h:" + action_reference(reference)
        assert len(action.encode()) <= 64
        assert parse_action(action) == (reference, "head")
    with pytest.raises(ValueError):
        parse_action("p:t:../../outside")
    asset = SkinAsset(PLAYER.hex, "<b>&name</b>", PLAYER, SkinModel.UNKNOWN, "0" * 64, b"", None)
    assert "&lt;b&gt;&amp;name&lt;/b&gt;" in caption(asset)


async def test_group_preview_uses_main_app_link(harness: Harness) -> None:
    asset = await harness.service.resolve("Notch")
    markup = preview_markup(asset, harness.service, "minecraft_skin_bot", private=False)
    assert (
        markup.inline_keyboard[-1][0].url
        == f"https://t.me/minecraft_skin_bot?startapp={PLAYER.hex}"
    )
    alternative = replace(harness.settings, rich_messages=False)
    await SkinMessages(harness.service, alternative, "minecraft_skin_bot").send(
        harness.bot, message(), asset
    )
    assert isinstance(harness.session.calls[-1], SendPhoto)
