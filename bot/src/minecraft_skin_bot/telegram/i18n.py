"""Per-update translations with no stored language preferences."""

from pathlib import Path
from typing import Any

from aiogram.types import TelegramObject, User
from aiogram.utils.i18n import I18n, SimpleI18nMiddleware

i18n = I18n(path=Path(__file__).resolve().parents[1] / "locales", default_locale="en")


def locale_from_user(user: User | None) -> str:
    tag = (user.language_code or "").replace("_", "-").lower() if user else ""
    parts = tag.split("-")
    if parts[0] == "zh" and "hant" not in parts:
        if "hans" in parts or tag == "zh" or (len(parts) == 2 and parts[1] in {"cn", "sg"}):
            return "zh_Hans"
    return "en"


def tr(message: str, locale: str | None = None) -> str:
    return i18n.gettext(message, locale=locale)


class SkinI18nMiddleware(SimpleI18nMiddleware):
    async def get_locale(self, event: TelegramObject, data: dict[str, Any]) -> str:
        return locale_from_user(data.get("event_from_user"))
