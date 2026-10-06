"""Public captions and self-contained skin action references."""

import base64
import re
from html import escape
from uuid import UUID

from aiogram.types import (
    CopyTextButton,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaDocument,
    InputMediaPhoto,
    InputRichBlockButtons,
    InputRichBlockDocument,
    InputRichBlockParagraph,
    InputRichBlockPhoto,
    InputRichBlockSectionHeading,
    InputRichBlockUnion,
    InputRichMessage,
    RichMessageButton,
    RichTextCode,
    WebAppInfo,
)

from minecraft_skin_bot.service import SkinAsset, SkinService
from minecraft_skin_bot.skin.renderer import RenderKind
from minecraft_skin_bot.telegram.i18n import tr

_ACTIONS: dict[str, RenderKind] = {
    "h": "head",
    "f": "front",
    "b": "back",
    "s": "side",
    "t": "three-view",
    "o": "skin",
}
_LABELS = {"h": "Head", "f": "Front", "b": "Back", "s": "Side", "t": "Three-view", "o": "Original"}


def asset_name(asset: SkinAsset, locale: str | None = None) -> str:
    return asset.name if asset.uuid else tr("Uploaded skin", locale)


def caption(asset: SkinAsset, *, locale: str | None = None) -> str:
    model = tr(asset.model.value.capitalize(), locale)
    text = f"<b>{escape(asset_name(asset, locale))}</b>\n{tr('Model', locale)}: {model}"
    if asset.uuid:
        text += f"\nUUID: <code>{asset.uuid}</code>"
    if asset.cape_url:
        text += "\n" + tr("Cape available in 3D", locale)
    return text


def action_reference(reference: str) -> str:
    if reference.startswith("upload:"):
        digest = bytes.fromhex(reference.removeprefix("upload:"))
        return "u" + base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return "r" + UUID(reference).hex


def parse_action(data: str) -> tuple[str, RenderKind]:
    parts = data.split(":")
    if len(parts) != 3 or parts[0] != "p" or parts[1] not in _ACTIONS:
        raise ValueError("Invalid skin action")
    value = parts[2]
    if re.fullmatch(r"r[0-9a-f]{32}", value):
        reference = UUID(value[1:]).hex
    elif re.fullmatch(r"u[A-Za-z0-9_-]{43}", value):
        digest = base64.b64decode(value[1:] + "=", altchars=b"-_", validate=True)
        reference = "upload:" + digest.hex()
    else:
        raise ValueError("Invalid skin reference")
    return reference, _ACTIONS[parts[1]]


def mini_app_link(asset: SkinAsset, bot_username: str) -> str:
    selector = (
        action_reference(asset.reference)
        if asset.reference.startswith("upload:")
        else asset.reference
    )
    return f"https://t.me/{bot_username}?startapp={selector}"


def share_markup(
    asset: SkinAsset, bot_username: str, *, locale: str | None = None
) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(text=tr("Open 3D", locale), url=mini_app_link(asset, bot_username)),
        InlineKeyboardButton(text=tr("Share", locale), switch_inline_query=asset.reference),
    ]
    if asset.uuid:
        buttons.append(
            InlineKeyboardButton(
                text=tr("Copy UUID", locale), copy_text=CopyTextButton(text=str(asset.uuid))
            )
        )
    return InlineKeyboardMarkup(inline_keyboard=[buttons])


def preview_markup(
    asset: SkinAsset,
    service: SkinService,
    bot_username: str,
    *,
    private: bool,
    locale: str | None = None,
) -> InlineKeyboardMarkup:
    reference = action_reference(asset.reference)
    rows = [
        [
            InlineKeyboardButton(
                text=tr(_LABELS[key], locale), callback_data=f"p:{key}:{reference}"
            )
            for key in keys
        ]
        for keys in (("h", "f", "b"), ("s", "t", "o"))
    ]
    actions = share_markup(asset, bot_username, locale=locale).inline_keyboard[0]
    if private:
        actions[0] = InlineKeyboardButton(
            text=tr("Open 3D", locale), web_app=WebAppInfo(url=service.viewer_url(asset))
        )
    rows.append(actions)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def rich_profile(
    asset: SkinAsset,
    media: InputMediaPhoto | InputMediaDocument,
    markup: InlineKeyboardMarkup,
    *,
    locale: str | None = None,
) -> InputRichMessage:
    blocks: list[InputRichBlockUnion] = [
        InputRichBlockSectionHeading(text=asset_name(asset, locale), size=3),
        (
            InputRichBlockPhoto(photo=media)
            if isinstance(media, InputMediaPhoto)
            else InputRichBlockDocument(document=media)
        ),
        InputRichBlockParagraph(
            text=f"{tr('Model', locale)}: {tr(asset.model.value.capitalize(), locale)}"
        ),
    ]
    if asset.uuid:
        blocks.append(InputRichBlockParagraph(text=["UUID: ", RichTextCode(text=str(asset.uuid))]))
    if asset.cape_url:
        blocks.append(InputRichBlockParagraph(text=tr("Cape available in 3D", locale)))
    for row in markup.inline_keyboard:
        blocks.append(
            InputRichBlockButtons(
                buttons=[
                    RichMessageButton(**button.model_dump(exclude_none=True)) for button in row
                ]
            )
        )
    return InputRichMessage(blocks=blocks)
