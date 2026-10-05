"""Render flat skin faces using Minecraft's box texture coordinates."""

from io import BytesIO
from typing import Literal

from PIL import Image, ImageDraw

from minecraft_skin_bot.minecraft.models import SkinModel
from minecraft_skin_bot.skin.parser import ParsedSkin

RenderKind = Literal["head", "front", "back", "side", "three-view", "skin"]
RENDERER_VERSION = "1"
_SCALE = 16
_BACKGROUND = (239, 243, 248, 255)


def _face(
    image: Image.Image, origin: tuple[int, int], width: int, height: int, depth: int, view: str
) -> Image.Image:
    u, v = origin
    if view == "front":
        x, face_width = u + depth, width
    elif view == "back":
        x, face_width = u + width + 2 * depth, width
    else:
        x, face_width = u, depth
    return image.crop((x, v + depth, x + face_width, v + depth + height))


def _part(
    canvas: Image.Image,
    skin: ParsedSkin,
    view: str,
    base: tuple[int, int],
    outer: tuple[int, int],
    dimensions: tuple[int, int, int],
    position: tuple[float, float],
) -> None:
    width, height, depth = dimensions
    face_width = depth if view == "side" else width
    x, y = (round(value * _SCALE) for value in position)
    face = _face(skin.image, base, width, height, depth, view)
    canvas.alpha_composite(
        face.resize((face_width * _SCALE, height * _SCALE), Image.Resampling.NEAREST), (x, y)
    )
    if skin.legacy and base != (0, 0):
        return
    inflation = 1 if base == (0, 0) else 0.5
    overlay = _face(skin.image, outer, width, height, depth, view).resize(
        (round((face_width + inflation) * _SCALE), round((height + inflation) * _SCALE)),
        Image.Resampling.NEAREST,
    )
    offset = round(inflation * _SCALE / 2)
    canvas.alpha_composite(overlay, (x - offset, y - offset))


def _body(skin: ParsedSkin, view: str) -> Image.Image:
    canvas = Image.new("RGBA", (24 * _SCALE, 40 * _SCALE), _BACKGROUND)
    _part(canvas, skin, view, (0, 0), (32, 0), (8, 8, 8), (8, 3))
    arm_width = 3 if skin.model == SkinModel.SLIM else 4
    if view == "side":
        _part(canvas, skin, view, (16, 16), (16, 32), (8, 12, 4), (10, 11))
        _part(canvas, skin, view, (40, 16), (40, 32), (arm_width, 12, 4), (10, 11))
        _part(canvas, skin, view, (0, 16), (0, 32), (4, 12, 4), (10, 23))
    else:
        _part(canvas, skin, view, (16, 16), (16, 32), (8, 12, 4), (8, 11))
        arms = [((40, 16), (40, 32)), ((32, 48), (48, 48))]
        legs = [((0, 16), (0, 32)), ((16, 48), (0, 48))]
        if view == "back":
            arms.reverse()
            legs.reverse()
        for (base, outer), x in zip(arms, (8 - arm_width, 16), strict=True):
            _part(canvas, skin, view, base, outer, (arm_width, 12, 4), (x, 11))
        for (base, outer), x in zip(legs, (8, 12), strict=True):
            _part(canvas, skin, view, base, outer, (4, 12, 4), (x, 23))
    return canvas


def render_skin(skin: ParsedSkin, kind: RenderKind) -> bytes:
    """Return a Telegram-sized PNG, or the exact original skin PNG."""
    if kind == "skin":
        return skin.original
    if kind == "head":
        canvas = Image.new("RGBA", (12 * _SCALE, 12 * _SCALE), _BACKGROUND)
        _part(canvas, skin, "front", (0, 0), (32, 0), (8, 8, 8), (2, 2))
        canvas = canvas.resize((384, 384), Image.Resampling.NEAREST)
    elif kind in ("front", "back", "side"):
        canvas = _body(skin, kind)
    elif kind == "three-view":
        canvas = Image.new("RGBA", (72 * _SCALE, 42 * _SCALE), _BACKGROUND)
        draw = ImageDraw.Draw(canvas)
        for index, view in enumerate(("front", "side", "back")):
            canvas.alpha_composite(_body(skin, view), (index * 24 * _SCALE, 0))
            label = view.capitalize()
            draw.text(
                ((index * 24 + 12) * _SCALE, 38 * _SCALE),
                label,
                fill=(51, 65, 85),
                anchor="mm",
                font_size=22,
            )
    else:
        raise ValueError(f"Unsupported render kind: {kind}")
    output = BytesIO()
    canvas.convert("RGB").save(output, format="PNG", optimize=True)
    return output.getvalue()
