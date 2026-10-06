"""Stateless query, upload, preview and inline Telegram entry points."""

import logging
from html import escape
from io import BytesIO
from pathlib import PurePath
from typing import Any

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramNotFound
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    BufferedInputFile,
    CallbackQuery,
    ErrorEvent,
    InlineKeyboardMarkup,
    InlineQuery,
    InlineQueryResultArticle,
    InputMediaDocument,
    InputMediaPhoto,
    InputTextMessageContent,
    Message,
)

from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.service import SkinAsset, SkinService
from minecraft_skin_bot.skin.renderer import RenderKind
from minecraft_skin_bot.telegram.formatting import (
    caption,
    parse_action,
    preview_markup,
    rich_profile,
)
from minecraft_skin_bot.telegram.inline import InlineSkins, parse_query

logger = logging.getLogger(__name__)

# Telegram varies the tail of these 400 descriptions, for example
# "wrong remote file identifier specified: Wrong padding in the string", so match prefixes.
FILE_ID_ERROR_PREFIXES = (
    "wrong file identifier",
    "wrong remote file identifier",
    "wrong remote file id",
    "file reference expired",
)
FILE_ID_DETAIL_HINTS = ("padding in the string", "wrong last symbol", "can't unserialize")
STALE_QUERY_MARKERS = ("query is too old", "query id is invalid", "response timeout expired")

MEDIA_ERROR = UtilityError("Skins unavailable", "Send the player name again in a moment.")


def error_text(error: UtilityError) -> str:
    return f"<b>{escape(error.title)}</b>\n\n{escape(error.message)}"


def description(error: TelegramAPIError) -> str:
    """Telegram description without the transport's "Bad Request: " label."""
    return error.message.lower().removeprefix("bad request: ").strip()


def brief(error: BaseException) -> str:
    """Short failure detail for logs; the safe-log filter strips credentials and transport URLs."""
    return description(error)[:200] if isinstance(error, TelegramAPIError) else type(error).__name__


def invalid_file_id(error: TelegramAPIError) -> bool:
    """A cached file_id that this bot can no longer reuse, which a fresh upload repairs."""
    text = description(error)
    if text.startswith(FILE_ID_ERROR_PREFIXES):
        return True
    return "file" in text and any(hint in text for hint in FILE_ID_DETAIL_HINTS)


def stale_query(error: TelegramAPIError) -> bool:
    """The update's query expired before the bot answered, so no answer can reach the user."""
    text = description(error)
    return any(marker in text for marker in STALE_QUERY_MARKERS)


def failure_article(identifier: str, error: UtilityError) -> InlineQueryResultArticle:
    return InlineQueryResultArticle(
        id=identifier,
        title=error.title,
        description=error.message,
        input_message_content=InputTextMessageContent(
            message_text=error_text(error), parse_mode="HTML"
        ),
    )


def input_media(
    file: BufferedInputFile, asset: SkinAsset, kind: RenderKind
) -> InputMediaPhoto | InputMediaDocument:
    caption_text = caption(asset)
    if kind == "skin":
        return InputMediaDocument(media=file, caption=caption_text, parse_mode="HTML")
    return InputMediaPhoto(media=file, caption=caption_text, parse_mode="HTML")


def unchanged(error: TelegramBadRequest) -> bool:
    """Telegram rejects an edit that would change nothing, which is not a failure."""
    return "not modified" in error.message.lower()


def addressed_query(message: Message, bot: Bot, bot_username: str) -> str | None:
    """Keep explicit bot addressing separate from the Minecraft query."""
    text = message.text if message.text is not None else message.caption or ""
    entities = message.entities if message.text is not None else message.caption_entities
    spans = []
    for entity in entities or []:
        own_mention = entity.type == "mention" and entity.extract_from(text).lower() == (
            "@" + bot_username.lower()
        )
        own_user = (
            entity.type == "text_mention" and entity.user is not None and entity.user.id == bot.id
        )
        if own_mention or own_user:
            spans.append((entity.offset * 2, (entity.offset + entity.length) * 2))
    # Telegram offsets count UTF-16 units, including both units of an emoji.
    encoded = text.encode("utf-16-le")
    for start, end in sorted(spans, reverse=True):
        encoded = encoded[:start] + b" \x00" + encoded[end:]
    query = encoded.decode("utf-16-le").strip()
    command = query.split(maxsplit=1)[0] if query else ""
    addressed_command = False
    if command.startswith("/") and "@" in command:
        target = command.partition("@")[2]
        if target.lower() != bot_username.lower():
            return None
        addressed_command = True
    if message.chat.type != "private" and not (spans or addressed_command):
        return None
    return query


class BoundedDownload(BytesIO):
    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit

    def write(self, data: Any) -> int:
        if self.tell() + len(data) > self.limit:
            raise UtilityError("Invalid skin", "Expected a skin PNG smaller than 1 MiB.")
        return super().write(data)


class SkinMessages:
    def __init__(self, service: SkinService, settings: Settings, bot_username: str) -> None:
        self.service = service
        self.settings = settings
        self.bot_username = bot_username

    async def _media(self, asset: SkinAsset, kind: RenderKind) -> BufferedInputFile:
        data = await self.service.preview(asset, kind)
        return BufferedInputFile(data, filename=f"skin-{asset.content_hash[:12]}-{kind}.png")

    def _markup(self, asset: SkinAsset, message: Message) -> InlineKeyboardMarkup:
        return preview_markup(
            asset, self.service, self.bot_username, private=message.chat.type == "private"
        )

    async def send(
        self,
        bot: Bot,
        message: Message,
        asset: SkinAsset,
        kind: RenderKind = "front",
        *,
        rich: bool = True,
    ) -> None:
        file = await self._media(asset, kind)
        markup = self._markup(asset, message)
        if kind == "skin":
            await bot.send_document(
                message.chat.id,
                file,
                caption=caption(asset),
                parse_mode="HTML",
                reply_markup=markup,
            )
            return
        if self.settings.rich_messages and rich:
            try:
                await bot.send_rich_message(
                    message.chat.id,
                    rich_profile(asset, InputMediaPhoto(media=file), markup),
                )
                return
            except (TelegramNotFound, TelegramBadRequest) as error:
                # Only unsupported-method responses prove that sending did not occur.
                if error.message.lower().removeprefix("bad request: ") not in {
                    "not found",
                    "method not found",
                    "unknown method",
                }:
                    raise
        await bot.send_photo(
            message.chat.id, file, caption=caption(asset), parse_mode="HTML", reply_markup=markup
        )

    async def edit(
        self,
        bot: Bot,
        message: Message,
        asset: SkinAsset,
        kind: RenderKind = "front",
    ) -> None:
        """Keep this message's layout in place; a rejected edit falls back to the default one."""
        file = await self._media(asset, kind)
        markup = self._markup(asset, message)
        media = input_media(file, asset, kind)
        if self.settings.rich_messages and message.rich_message is not None:
            try:
                await bot.edit_message_text(
                    chat_id=message.chat.id,
                    message_id=message.message_id,
                    rich_message=rich_profile(asset, media, markup),
                )
                return
            except (TelegramNotFound, TelegramBadRequest) as error:
                if isinstance(error, TelegramBadRequest) and unchanged(error):
                    return
        try:
            await bot.edit_message_media(
                media=media,
                chat_id=message.chat.id,
                message_id=message.message_id,
                reply_markup=markup,
            )
            return
        except (TelegramNotFound, TelegramBadRequest) as error:
            if isinstance(error, TelegramBadRequest) and unchanged(error):
                return
        await self.send(bot, message, asset, kind, rich=False)


def create_router(service: SkinService, settings: Settings, bot_username: str) -> Router:
    router = Router(name="minecraft-skins")
    messages = SkinMessages(service, settings, bot_username)
    inline = InlineSkins(service, settings, bot_username)

    async def addressed(message: Message, bot: Bot) -> bool | dict[str, str]:
        query = addressed_query(message, bot, bot_username)
        return False if query is None else {"query_text": query}

    router.message.filter(addressed)
    router.channel_post.filter(addressed)

    @router.channel_post(CommandStart(ignore_mention=True))
    @router.message(CommandStart(ignore_mention=True))
    async def start(message: Message) -> None:
        await message.answer(
            "<b>Minecraft Skin Bot</b>\n\n"
            "Send a Minecraft username, UUID, or skin PNG.\n"
            f"Share skins in any chat with <code>@{escape(bot_username)} Notch</code>.\n"
            "Open 3D on a result to rotate, zoom and animate the skin.\n\n/help",
            parse_mode="HTML",
        )

    @router.channel_post(Command("help", ignore_mention=True))
    @router.message(Command("help", ignore_mention=True))
    async def help_message(message: Message) -> None:
        await message.answer(
            "Send <code>Notch</code> or a Minecraft UUID to see a skin.\n"
            "For a standard photo, send <code>skin Notch</code>.\n"
            "In groups and channels, mention this bot in the query or file caption.\n"
            "Upload a 64×64 or 64×32 skin PNG as a file.\n"
            f"Use <code>@{escape(bot_username)} Notch</code> to share "
            "Skin, Three-view, Head or Original.\n"
            "Open 3D for rotation, zoom, layers, cape and animation.\n"
            f"Uploaded skin links stay available for {settings.upload_ttl_seconds / 3600:g} hours.",
            parse_mode="HTML",
        )

    @router.channel_post(F.document)
    @router.message(F.document)
    async def upload(message: Message, bot: Bot) -> None:
        document = message.document
        if not document:
            return
        try:
            if document.file_size is not None and not (
                0 < document.file_size <= settings.max_upload_bytes
            ):
                raise UtilityError("Invalid skin", "Expected a skin PNG smaller than 1 MiB.")
            mime_type = (document.mime_type or "").partition(";")[0].strip().lower()
            suffix = PurePath(document.file_name or "").suffix.lower()
            # Sender-defined hints can disagree; confirm the format from the bytes.
            if mime_type not in {"", "image/png", "application/octet-stream"} and suffix not in {
                "",
                ".png",
            }:
                raise UtilityError("Invalid skin", "Send a 64×64 or 64×32 Minecraft skin PNG.")
            destination = BoundedDownload(settings.max_upload_bytes)
            await bot.download(document, destination=destination, timeout=20)
            asset = await service.upload(destination.getvalue())
            await messages.send(bot, message, asset, "three-view", rich=False)
        except UtilityError as error:
            await message.answer(error_text(error), parse_mode="HTML")

    @router.channel_post(F.photo)
    @router.message(F.photo)
    async def compressed_upload(message: Message) -> None:
        await message.answer("Send the skin PNG as a file to preserve its original pixels.")

    @router.channel_post(F.text)
    @router.message(F.text)
    async def lookup(message: Message, bot: Bot, query_text: str) -> None:
        text = query_text
        if text.startswith("/"):
            await help_message(message)
            return
        try:
            parsed = parse_query(text)
            reference = parsed.reference if parsed else text.strip()
            standard_photo = text.strip().lower().startswith("skin ")
            asset = await service.resolve(reference)
            await messages.send(bot, message, asset, rich=not standard_photo)
        except UtilityError as error:
            await message.answer(error_text(error), parse_mode="HTML")

    @router.callback_query(F.data.startswith("p:"))
    async def preview(callback: CallbackQuery, bot: Bot) -> None:
        await callback.answer()
        if not isinstance(callback.message, Message):
            return
        try:
            try:
                reference, kind = parse_action(callback.data or "")
            except ValueError as error:
                raise UtilityError(
                    "Skin unavailable", "Send the player name or upload the skin again."
                ) from error
            asset = await service.resolve(reference)
            await messages.edit(bot, callback.message, asset, kind)
        except UtilityError as error:
            await callback.message.answer(error_text(error), parse_mode="HTML")

    @router.inline_query()
    async def inline_query(query: InlineQuery, bot: Bot) -> None:
        parsed = parse_query(query.query)
        if parsed is None:
            await query.answer([], cache_time=3, is_personal=False)
            return
        try:
            results, button = await inline.results(bot, parsed)
        except UtilityError as error:
            await query.answer(
                [failure_article("lookup-error", error)], cache_time=5, is_personal=False
            )
            return
        try:
            await query.answer(results, button=button, cache_time=60, is_personal=False)
            return
        except TelegramBadRequest as error:
            if stale_query(error):
                logger.debug("Inline query expired before it was answered")
                return
            if not invalid_file_id(error):
                raise
            logger.warning(
                "Inline media rejected, refreshing the cached uploads (%s)", brief(error)
            )
        try:
            await inline.invalidate(bot, parsed.reference)
            results, button = await inline.results(bot, parsed)
            await query.answer(results, button=button, cache_time=60, is_personal=False)
        except TelegramBadRequest as error:
            if stale_query(error):
                logger.debug("Inline query expired before it was answered")
                return
            if not invalid_file_id(error):
                raise
            # Fresh uploads were rejected too, so the media is not the problem; degrade instead.
            logger.warning("Inline media rejected after refreshing (%s)", brief(error))
            await query.answer(
                [failure_article("media-error", MEDIA_ERROR)], cache_time=5, is_personal=False
            )
        except UtilityError as error:
            await query.answer(
                [failure_article("lookup-error", error)], cache_time=5, is_personal=False
            )

    @router.errors()
    async def recover_request(event: ErrorEvent, bot: Bot) -> bool:
        if not isinstance(event.exception, (TelegramAPIError, TimeoutError)):
            return False
        if isinstance(event.exception, TelegramAPIError) and stale_query(event.exception):
            logger.debug("Telegram query expired before it was answered")
            return True
        if isinstance(event.exception, TelegramAPIError):
            logger.warning(
                "Telegram request failed (%s, %s: %s)",
                event.exception.method.__api_method__,
                type(event.exception).__name__,
                brief(event.exception),
            )
        else:
            logger.warning("Telegram request failed (%s)", type(event.exception).__name__)
        error = UtilityError("Skin service is busy", "Try again in a moment.")
        try:
            if event.update.inline_query:
                await event.update.inline_query.answer(
                    [failure_article("service-busy", error)],
                    cache_time=1,
                    is_personal=False,
                )
            else:
                target = event.update.message or event.update.channel_post
                if target is None and event.update.callback_query:
                    callback_message = event.update.callback_query.message
                    target = callback_message if isinstance(callback_message, Message) else None
                if target:
                    await bot.send_message(target.chat.id, error_text(error), parse_mode="HTML")
        except (TelegramAPIError, TimeoutError) as recovery_error:
            logger.warning("Telegram recovery failed (%s)", type(recovery_error).__name__)
        return True

    return router
