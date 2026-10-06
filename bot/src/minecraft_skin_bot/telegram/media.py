"""Validate the technical cache target and classify its access failures."""

from aiogram import Bot
from aiogram.exceptions import (
    TelegramAPIError,
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramMigrateToChat,
)
from aiogram.types import ChatMemberAdministrator, ChatMemberOwner, ChatMemberRestricted

ACCESS_DIAGNOSTIC = (
    "Check TELEGRAM_CACHE_CHAT_ID: use the target's full signed chat ID and ensure the bot "
    "can access that chat. Add it to a group or channel, or start it in a private cache chat."
)
CHANNEL_DIAGNOSTIC = (
    "Grant the bot administrator access with Post Messages in the channel configured by "
    "TELEGRAM_CACHE_CHAT_ID."
)
MEDIA_DIAGNOSTIC = (
    "Allow the bot to send photos and documents in the chat configured by TELEGRAM_CACHE_CHAT_ID."
)


class MediaCacheUnavailable(Exception):
    def __init__(self, diagnostic: str, *, method: str | None = None) -> None:
        super().__init__(diagnostic)
        self.telegram_method = method


def cache_access_error(error: TelegramAPIError) -> MediaCacheUnavailable | None:
    """Recognize access failures at the cache boundary while preserving unrelated errors."""
    if isinstance(error, TelegramMigrateToChat):
        diagnostic = "Update TELEGRAM_CACHE_CHAT_ID to the cache group's current supergroup ID."
    elif isinstance(error, TelegramForbiddenError):
        diagnostic = ACCESS_DIAGNOSTIC
    elif isinstance(error, TelegramBadRequest):
        text = error.message.lower().removeprefix("bad request: ").strip()
        if text == "chat not found":
            diagnostic = ACCESS_DIAGNOSTIC
        elif "not enough rights to send" in text or text in {
            "chat_write_forbidden",
            "chat_admin_required",
        }:
            diagnostic = MEDIA_DIAGNOSTIC
        else:
            return None
    else:
        return None
    return MediaCacheUnavailable(diagnostic, method=error.method.__api_method__)


async def validate_media_cache(bot: Bot, chat_id: int) -> None:
    """Check accessible metadata and explicit permissions without uploading probe media."""
    try:
        chat = await bot.get_chat(chat_id, request_timeout=10)
        if chat.type == "private":
            return
        member = await bot.get_chat_member(chat_id, bot.id, request_timeout=10)
    except TelegramAPIError as error:
        cache_error = cache_access_error(error)
        if cache_error is not None:
            raise cache_error from error
        raise
    if member.status in {"left", "kicked"} or (
        isinstance(member, ChatMemberRestricted) and not member.is_member
    ):
        raise MediaCacheUnavailable(ACCESS_DIAGNOSTIC)
    if chat.type == "channel":
        if isinstance(member, ChatMemberOwner) or (
            isinstance(member, ChatMemberAdministrator) and member.can_post_messages
        ):
            return
        raise MediaCacheUnavailable(CHANNEL_DIAGNOSTIC)
    if isinstance(member, (ChatMemberOwner, ChatMemberAdministrator)):
        return
    permissions = member if isinstance(member, ChatMemberRestricted) else chat.permissions
    if permissions is not None and (
        permissions.can_send_photos is False or permissions.can_send_documents is False
    ):
        raise MediaCacheUnavailable(MEDIA_DIAGNOSTIC)
