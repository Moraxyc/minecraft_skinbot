"""Public captions and self-contained skin action references."""

import base64
import re
from datetime import UTC, datetime
from html import escape
from uuid import UUID

from aiogram.types import (
    CopyTextButton,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaDocument,
    InputMediaPhoto,
    InputRichBlockButtons,
    InputRichBlockDivider,
    InputRichBlockDocument,
    InputRichBlockFooter,
    InputRichBlockParagraph,
    InputRichBlockPhoto,
    InputRichBlockSectionHeading,
    InputRichBlockUnion,
    InputRichMessage,
    RichMessageButton,
    RichTextBold,
    RichTextButton,
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

# Preview switchers read as the orthographic body angles, then the head crop with the
# composite three-view. Original, Open 3D and Share leave or forward the current render.
_VIEW_ROWS: tuple[tuple[str, ...], ...] = (("f", "b", "s"), ("h", "t"))

# A preview callback carries the scope of the chat its message lives in, because a rebuilt
# inline message must keep the button type that chat accepts: web_app works in private chats
# only, so every other chat keeps the Main Mini App deep link.
_SCOPE_PRIVATE = "private"
_SCOPE_PUBLIC = "public"


def asset_name(asset: SkinAsset, locale: str | None = None) -> str:
    if asset.uuid:
        return asset.name
    return tr("Uploaded skin" if asset.reference.startswith("upload:") else "Shared skin", locale)


def upload_expiry(asset: SkinAsset, locale: str | None = None) -> str | None:
    if asset.upload_expires_at is None:
        return None
    expires = datetime.fromtimestamp(asset.upload_expires_at, UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    return tr("Link expires at {expires}. Send the PNG again after expiry.", locale).format(
        expires=expires
    )


def caption(asset: SkinAsset, *, locale: str | None = None) -> str:
    model = tr(asset.model.value.capitalize(), locale)
    text = f"<b>{escape(asset_name(asset, locale))}</b>\n{tr('Model', locale)}: {model}"
    if asset.uuid:
        text += f"\nUUID: <code>{asset.uuid}</code>"
    if asset.cape_url:
        text += "\n" + tr("Cape available in 3D", locale)
    expiry = upload_expiry(asset, locale)
    if expiry:
        text += "\n" + expiry
    return text


def action_reference(reference: str) -> str:
    if reference.startswith("upload:"):
        digest = bytes.fromhex(reference.removeprefix("upload:"))
        return "u" + base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return "r" + UUID(reference).hex


def parse_action(data: str) -> tuple[str, RenderKind, bool]:
    """Decode a preview callback into its reference, renderer and private-chat scope."""
    parts = data.split(":")
    if len(parts) not in {3, 4} or parts[0] != "p" or parts[1] not in _ACTIONS:
        raise ValueError("Invalid skin action")
    private = False
    if len(parts) == 4:
        if parts[2] not in {_SCOPE_PRIVATE, _SCOPE_PUBLIC}:
            raise ValueError("Invalid skin scope")
        private = parts[2] == _SCOPE_PRIVATE
        value = parts[3]
    else:
        value = parts[2]
    if re.fullmatch(r"r[0-9a-f]{32}", value):
        reference = UUID(value[1:]).hex
    elif re.fullmatch(r"u[A-Za-z0-9_-]{43}", value):
        digest = base64.b64decode(value[1:] + "=", altchars=b"-_", validate=True)
        reference = "upload:" + digest.hex()
    else:
        raise ValueError("Invalid skin reference")
    return reference, _ACTIONS[parts[1]], private


def mini_app_link(asset: SkinAsset, bot_username: str) -> str:
    reference = asset.snapshot_reference or asset.reference
    if reference.startswith("texture:"):
        selector = "t-" + reference.removeprefix("texture:")
    elif reference.startswith("upload:"):
        selector = action_reference(reference)
    else:
        selector = reference
    return f"https://t.me/{bot_username}?startapp={selector}"


def parse_start_reference(value: str) -> str:
    if re.fullmatch(r"[0-9a-fA-F]{32}", value):
        return UUID(value).hex
    if re.fullmatch(r"r[0-9a-f]{32}|u[A-Za-z0-9_-]{43}", value):
        return parse_action("p:f:" + value)[0]
    raise ValueError("Invalid skin start parameter")


def open_button(
    asset: SkinAsset,
    service: SkinService,
    bot_username: str,
    *,
    private: bool,
    locale: str | None = None,
) -> InlineKeyboardButton:
    """Open the viewer as a Mini App in private chats and by deep link elsewhere."""
    text = tr("Open 3D", locale)
    if private:
        return InlineKeyboardButton(
            text=text, web_app=WebAppInfo(url=service.viewer_url(asset, locale=locale))
        )
    return InlineKeyboardButton(text=text, url=mini_app_link(asset, bot_username))


def preview_button(
    asset: SkinAsset, key: str, *, private: bool, locale: str | None = None
) -> InlineKeyboardButton:
    """Switch the message to one render in the chat scope whose callbacks it accepts."""
    scope = _SCOPE_PRIVATE if private else _SCOPE_PUBLIC
    return InlineKeyboardButton(
        text=tr(_LABELS[key], locale),
        callback_data=f"p:{key}:{scope}:{action_reference(asset.reference)}",
    )


def action_buttons(
    asset: SkinAsset,
    service: SkinService,
    bot_username: str,
    *,
    private: bool,
    locale: str | None = None,
) -> list[InlineKeyboardButton]:
    """Open the 3D viewer, share the skin, and copy the UUID where no paragraph shows it."""
    buttons = [
        open_button(asset, service, bot_username, private=private, locale=locale),
        InlineKeyboardButton(
            text=tr("Share", locale),
            switch_inline_query=asset.snapshot_reference or asset.reference,
        ),
    ]
    if asset.uuid:
        buttons.append(
            InlineKeyboardButton(
                text=tr("Copy UUID", locale), copy_text=CopyTextButton(text=str(asset.uuid))
            )
        )
    return buttons


def share_markup(
    asset: SkinAsset,
    service: SkinService,
    bot_username: str,
    *,
    private: bool,
    locale: str | None = None,
) -> InlineKeyboardMarkup:
    row = action_buttons(asset, service, bot_username, private=private, locale=locale)
    return InlineKeyboardMarkup(inline_keyboard=[row])


def preview_markup(
    asset: SkinAsset,
    service: SkinService,
    bot_username: str,
    *,
    private: bool,
    locale: str | None = None,
) -> InlineKeyboardMarkup:
    if asset.reference.startswith("texture:"):
        return share_markup(asset, service, bot_username, private=private, locale=locale)
    rows = [
        [preview_button(asset, key, private=private, locale=locale) for key in keys]
        for keys in _VIEW_ROWS
    ]
    rows.append(
        [
            preview_button(asset, "o", private=private, locale=locale),
            *action_buttons(asset, service, bot_username, private=private, locale=locale),
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def switch_target(button: InlineKeyboardButton) -> RenderKind | None:
    """The render a preview callback button opens, or None for buttons that do something else."""
    if not button.callback_data:
        return None
    try:
        return parse_action(button.callback_data)[1]
    except ValueError:
        return None


def rich_button(button: InlineKeyboardButton, active: RenderKind | None) -> RichMessageButton:
    """Carry a keyboard button into the card, marking the shown view and the 3D entry point."""
    target = switch_target(button)
    style: str | None = None
    if target is not None and target == active:
        style = "primary"
    elif button.url is not None or button.web_app is not None:
        style = "success"
    return RichMessageButton(**button.model_dump(exclude_none=True, exclude={"style"}), style=style)


def rich_profile(
    asset: SkinAsset,
    media: InputMediaPhoto | InputMediaDocument,
    markup: InlineKeyboardMarkup,
    *,
    active: RenderKind | None = None,
    locale: str | None = None,
) -> InputRichMessage:
    """Lay the skin out as a card: title, render, profile details, then the control rows."""
    blocks: list[InputRichBlockUnion] = [
        InputRichBlockSectionHeading(text=asset_name(asset, locale), size=2),
        (
            InputRichBlockPhoto(photo=media)
            if isinstance(media, InputMediaPhoto)
            else InputRichBlockDocument(document=media)
        ),
        InputRichBlockParagraph(
            text=[
                f"{tr('Model', locale)}: ",
                RichTextBold(text=tr(asset.model.value.capitalize(), locale)),
            ]
        ),
    ]
    if asset.uuid:
        blocks.append(
            InputRichBlockParagraph(
                text=[
                    "UUID: ",
                    RichTextButton(
                        button=RichMessageButton(
                            text=str(asset.uuid),
                            copy_text=CopyTextButton(text=str(asset.uuid)),
                        )
                    ),
                ]
            )
        )
    if asset.cape_url:
        # A hint about the viewer rather than a profile fact, so it stays visually quiet.
        blocks.append(InputRichBlockFooter(text=tr("Cape available in 3D", locale)))
    expiry = upload_expiry(asset, locale)
    if expiry:
        blocks.append(InputRichBlockFooter(text=expiry))
    blocks.append(InputRichBlockDivider())
    for row in markup.inline_keyboard:
        # The UUID paragraph copies itself, so its duplicate button is dropped here. The
        # view rows sit above, leaving Original, Open 3D and Share as the action row.
        buttons = [rich_button(button, active) for button in row if button.copy_text is None]
        if not buttons:
            continue
        blocks.append(InputRichBlockButtons(buttons=buttons, align="center"))
    return InputRichMessage(blocks=blocks)
