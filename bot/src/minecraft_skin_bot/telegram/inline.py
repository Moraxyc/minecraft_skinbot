"""Inline media is cached by skin bytes, view, renderer version and bot identity."""

import logging
import re
from dataclasses import dataclass
from typing import Literal

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import (
    BufferedInputFile,
    InlineQueryResultCachedDocument,
    InlineQueryResultCachedPhoto,
    InlineQueryResultsButton,
    InlineQueryResultUnion,
    InputMediaDocument,
    InputMediaPhoto,
    InputRichMessage,
    InputRichMessageContent,
    WebAppInfo,
)

from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.service import SkinAsset, SkinService
from minecraft_skin_bot.skin.renderer import RenderKind
from minecraft_skin_bot.telegram.formatting import (
    asset_name,
    caption,
    preview_markup,
    rich_profile,
    share_markup,
)
from minecraft_skin_bot.telegram.i18n import tr
from minecraft_skin_bot.telegram.media import MediaCacheUnavailable, cache_access_error

InlineResult = InlineQueryResultUnion
logger = logging.getLogger(__name__)

# Telegram can stop accepting a file_id this bot uploaded, so refresh them well before the
# content cache expires and let a lost or rotated media reference repair itself.
FILE_ID_TTL_SECONDS = 86400


@dataclass(frozen=True, slots=True)
class SkinQuery:
    reference: str
    preferred: Literal["skin", "head", "view"] = "skin"


def parse_query(text: str) -> SkinQuery | None:
    parts = text.strip().split()
    preferred: Literal["skin", "head", "view"] = "skin"
    if len(parts) == 2 and parts[0].lower() in {"skin", "head", "view"}:
        if parts[0].lower() == "head":
            preferred = "head"
        elif parts[0].lower() == "view":
            preferred = "view"
        parts = parts[1:]
    if len(parts) != 1:
        return None
    reference = parts[0]
    if not re.fullmatch(
        r"[A-Za-z0-9_]{3,16}|[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|upload:[0-9a-f]{64}",
        reference,
    ):
        return None
    return SkinQuery(reference, preferred)


class InlineSkins:
    def __init__(self, service: SkinService, settings: Settings, bot_username: str) -> None:
        self.service = service
        self.settings = settings
        self.bot_username = bot_username

    def media_key(self, bot: Bot, asset: SkinAsset, kind: RenderKind) -> str:
        return f"telegram:{bot.id}:{self.service.render_key(asset, kind)}"

    async def invalidate(self, bot: Bot, reference: str) -> None:
        asset = await self.service.resolve(reference)
        kinds: tuple[RenderKind, ...] = ("front", "three-view", "head", "skin")
        for kind in kinds:
            await self.service.cache.delete(self.media_key(bot, asset, kind))

    async def file_id(self, bot: Bot, asset: SkinAsset, kind: RenderKind) -> str:
        async def upload() -> bytes:
            data = await self.service.preview(asset, kind)
            file = BufferedInputFile(data, filename=f"skin-{asset.content_hash[:12]}-{kind}.png")
            try:
                if kind == "skin":
                    message = await bot.send_document(
                        self.settings.cache_chat_id, file, disable_notification=True
                    )
                else:
                    message = await bot.send_photo(
                        self.settings.cache_chat_id, file, disable_notification=True
                    )
            except TelegramAPIError as error:
                cache_error = cache_access_error(error)
                if cache_error is not None:
                    raise cache_error from error
                raise
            if kind == "skin":
                if not message.document:
                    raise RuntimeError("Telegram did not return the uploaded document")
                identifier = message.document.file_id
            else:
                if not message.photo:
                    raise RuntimeError("Telegram did not return the uploaded photo")
                identifier = message.photo[-1].file_id
            return identifier.encode()

        key = self.media_key(bot, asset, kind)
        return (
            await self.service.cache.get_or_create(key, upload, ttl=FILE_ID_TTL_SECONDS)
        ).decode()

    async def results(
        self,
        bot: Bot,
        query: SkinQuery,
        *,
        inline_query_id: str | None = None,
        locale: str | None = None,
    ) -> tuple[list[InlineResult], InlineQueryResultsButton]:
        asset = await self.service.resolve(query.reference)
        markup = share_markup(asset, self.bot_username, locale=locale)
        result_ids = asset.content_hash[:32]
        results: list[InlineResult] = []
        previews: tuple[tuple[str, RenderKind], ...] = (
            ("Skin", "front"),
            ("Three-view", "three-view"),
            ("Head", "head"),
        )
        try:
            for label, kind in previews:
                file_id = await self.file_id(bot, asset, kind)
                rich = (
                    InputRichMessageContent(
                        rich_message=await self.rich_message(bot, asset, kind, locale=locale)
                    )
                    if kind == "front" and self.settings.rich_messages
                    else None
                )
                results.append(
                    InlineQueryResultCachedPhoto(
                        id=f"{kind}:{result_ids}",
                        photo_file_id=file_id,
                        title=tr(label, locale),
                        description=asset_name(asset, locale),
                        caption=caption(asset, locale=locale),
                        parse_mode="HTML",
                        reply_markup=None if rich else markup,
                        input_message_content=rich,
                    )
                )
            results.append(
                InlineQueryResultCachedDocument(
                    id=f"original:{result_ids}",
                    title=tr("Original Skin", locale),
                    description=tr("Minecraft skin PNG", locale),
                    document_file_id=await self.file_id(bot, asset, "skin"),
                    caption=caption(asset, locale=locale),
                    parse_mode="HTML",
                    reply_markup=markup,
                )
            )
        except MediaCacheUnavailable as error:
            logger.warning(
                "Inline media cache unavailable (cache_upload): %s",
                error,
                extra={
                    "operation": "cache_upload",
                    "inline_query_id": inline_query_id,
                    "telegram_method": error.telegram_method,
                },
            )
            return [], InlineQueryResultsButton(
                text=tr("Previews unavailable · Open 3D", locale),
                web_app=WebAppInfo(url=self.service.viewer_url(asset)),
            )
        preferred = {"skin": 0, "view": 1, "head": 2}[query.preferred]
        if preferred:
            results.insert(0, results.pop(preferred))
        return results, InlineQueryResultsButton(
            text=tr("Open interactive 3D", locale),
            web_app=WebAppInfo(url=self.service.viewer_url(asset)),
        )

    async def rich_message(
        self,
        bot: Bot,
        asset: SkinAsset,
        kind: RenderKind,
        *,
        locale: str | None = None,
    ) -> InputRichMessage:
        """Build inline rich content using files already uploaded by this bot."""
        file_id = await self.file_id(bot, asset, kind)
        media = (
            InputMediaDocument(media=file_id) if kind == "skin" else InputMediaPhoto(media=file_id)
        )
        markup = preview_markup(
            asset, self.service, self.bot_username, private=False, locale=locale
        )
        return rich_profile(asset, media, markup, locale=locale)
