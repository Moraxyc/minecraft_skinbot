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
    InlineQuery,
    InlineQueryResultArticle,
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


def error_text(error: UtilityError) -> str:
    return f"<b>{escape(error.title)}</b>\n\n{escape(error.message)}"


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

    async def send(
        self,
        bot: Bot,
        message: Message,
        asset: SkinAsset,
        kind: RenderKind = "front",
        *,
        rich: bool = True,
    ) -> None:
        data = await self.service.preview(asset, kind)
        file = BufferedInputFile(data, filename=f"skin-{asset.content_hash[:12]}-{kind}.png")
        markup = preview_markup(
            asset, self.service, self.bot_username, private=message.chat.type == "private"
        )
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


def create_router(service: SkinService, settings: Settings, bot_username: str) -> Router:
    router = Router(name="minecraft-skins")
    messages = SkinMessages(service, settings, bot_username)
    inline = InlineSkins(service, settings, bot_username)

    @router.message(CommandStart())
    async def start(message: Message) -> None:
        await message.answer(
            "<b>Minecraft Skin Bot</b>\n\n"
            "Send a Minecraft username, UUID, or skin PNG.\n"
            f"Share skins in any chat with <code>@{escape(bot_username)} Notch</code>.\n"
            "Open 3D on a result to rotate, zoom and animate the skin.\n\n/help",
            parse_mode="HTML",
        )

    @router.message(Command("help"))
    async def help_message(message: Message) -> None:
        await message.answer(
            "Send <code>Notch</code> or a Minecraft UUID to see a skin.\n"
            "For a standard photo, send <code>skin Notch</code>.\n"
            "Upload a 64×64 or 64×32 skin PNG as a file.\n"
            f"Use <code>@{escape(bot_username)} Notch</code> to share "
            "Skin, Three-view, Head or Original.\n"
            "Open 3D for rotation, zoom, layers, cape and animation.\n"
            f"Uploaded skin links stay available for {settings.upload_ttl_seconds / 3600:g} hours.",
            parse_mode="HTML",
        )

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

    @router.message(F.photo)
    async def compressed_upload(message: Message) -> None:
        await message.answer("Send the skin PNG as a file to preserve its original pixels.")

    @router.message(F.text)
    async def lookup(message: Message, bot: Bot) -> None:
        text = message.text or ""
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
            await messages.send(bot, callback.message, asset, kind)
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
            try:
                await query.answer(results, button=button, cache_time=60, is_personal=False)
            except TelegramBadRequest as error:
                if error.message.lower().removeprefix("bad request: ") not in {
                    "wrong file identifier/http url specified",
                    "wrong remote file identifier specified",
                    "file reference expired",
                }:
                    raise
                await inline.invalidate(bot, parsed.reference)
                results, button = await inline.results(bot, parsed)
                await query.answer(results, button=button, cache_time=60, is_personal=False)
        except UtilityError as error:
            await query.answer(
                [
                    InlineQueryResultArticle(
                        id="lookup-error",
                        title=error.title,
                        description=error.message,
                        input_message_content=InputTextMessageContent(
                            message_text=error_text(error), parse_mode="HTML"
                        ),
                    )
                ],
                cache_time=5,
                is_personal=False,
            )

    @router.errors()
    async def recover_request(event: ErrorEvent, bot: Bot) -> bool:
        if not isinstance(event.exception, (TelegramAPIError, TimeoutError)):
            return False
        logger.warning("Telegram request failed (%s)", type(event.exception).__name__)
        error = UtilityError("Skin service is busy", "Try again in a moment.")
        try:
            if event.update.inline_query:
                await event.update.inline_query.answer(
                    [
                        InlineQueryResultArticle(
                            id="service-busy",
                            title=error.title,
                            description=error.message,
                            input_message_content=InputTextMessageContent(
                                message_text=error_text(error), parse_mode="HTML"
                            ),
                        )
                    ],
                    cache_time=1,
                    is_personal=False,
                )
            else:
                target = event.update.message
                if target is None and event.update.callback_query:
                    callback_message = event.update.callback_query.message
                    target = callback_message if isinstance(callback_message, Message) else None
                if target:
                    await bot.send_message(target.chat.id, error_text(error), parse_mode="HTML")
        except (TelegramAPIError, TimeoutError) as recovery_error:
            logger.warning("Telegram recovery failed (%s)", type(recovery_error).__name__)
        return True

    return router
