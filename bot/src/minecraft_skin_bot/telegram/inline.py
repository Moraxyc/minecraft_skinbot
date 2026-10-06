"""Inline media is cached by skin bytes, view, renderer version and bot identity."""

import re
from dataclasses import dataclass
from typing import Literal

from aiogram import Bot
from aiogram.types import (
    BufferedInputFile,
    InlineQueryResultCachedDocument,
    InlineQueryResultCachedPhoto,
    InlineQueryResultsButton,
    InlineQueryResultUnion,
    WebAppInfo,
)

from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.service import SkinAsset, SkinService
from minecraft_skin_bot.skin.renderer import RenderKind
from minecraft_skin_bot.telegram.formatting import caption, share_markup

InlineResult = InlineQueryResultUnion

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
            if kind == "skin":
                message = await bot.send_document(
                    self.settings.cache_chat_id, file, disable_notification=True
                )
                if not message.document:
                    raise RuntimeError("Telegram did not return the uploaded document")
                identifier = message.document.file_id
            else:
                message = await bot.send_photo(
                    self.settings.cache_chat_id, file, disable_notification=True
                )
                if not message.photo:
                    raise RuntimeError("Telegram did not return the uploaded photo")
                identifier = message.photo[-1].file_id
            return identifier.encode()

        key = self.media_key(bot, asset, kind)
        return (
            await self.service.cache.get_or_create(key, upload, ttl=FILE_ID_TTL_SECONDS)
        ).decode()

    async def results(
        self, bot: Bot, query: SkinQuery
    ) -> tuple[list[InlineResult], InlineQueryResultsButton]:
        asset = await self.service.resolve(query.reference)
        markup = share_markup(asset, self.bot_username)
        result_ids = asset.content_hash[:32]
        results: list[InlineResult] = []
        previews: tuple[tuple[str, RenderKind], ...] = (
            ("Skin", "front"),
            ("Three-view", "three-view"),
            ("Head", "head"),
        )
        for label, kind in previews:
            file_id = await self.file_id(bot, asset, kind)
            results.append(
                InlineQueryResultCachedPhoto(
                    id=f"{kind}:{result_ids}",
                    photo_file_id=file_id,
                    title=label,
                    description=asset.name,
                    caption=caption(asset),
                    parse_mode="HTML",
                    reply_markup=markup,
                )
            )
        results.append(
            InlineQueryResultCachedDocument(
                id=f"original:{result_ids}",
                title="Original Skin",
                description="Minecraft skin PNG",
                document_file_id=await self.file_id(bot, asset, "skin"),
                caption=caption(asset),
                parse_mode="HTML",
                reply_markup=markup,
            )
        )
        preferred = {"skin": 0, "view": 1, "head": 2}[query.preferred]
        if preferred:
            results.insert(0, results.pop(preferred))
        return results, InlineQueryResultsButton(
            text="Open interactive 3D", web_app=WebAppInfo(url=self.service.viewer_url(asset))
        )
