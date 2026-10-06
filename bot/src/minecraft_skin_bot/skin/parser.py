"""Decode bounded Minecraft PNGs and expand legacy limb textures."""

import struct
from dataclasses import dataclass
from io import BytesIO

from PIL import Image

from minecraft_skin_bot.minecraft.models import SkinModel

MAX_SKIN_BYTES = 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class InvalidSkin(ValueError):
    """The input is not a supported Minecraft skin PNG."""


@dataclass(frozen=True, slots=True)
class ParsedSkin:
    original: bytes
    image: Image.Image
    model: SkinModel
    legacy: bool
    render_model: SkinModel


def _render_model(image: Image.Image, model: SkinModel) -> SkinModel:
    if model != SkinModel.UNKNOWN:
        return model
    areas = [(50, 16, 52, 20), (54, 20, 56, 32), (42, 48, 44, 52), (46, 52, 48, 64)]
    pixels = [
        image.getpixel((x, y))
        for x0, y0, x1, y1 in areas
        for x in range(x0, x1)
        for y in range(y0, y1)
    ]
    # These unused slim texels follow skinview-utils' auto-detection contract.
    if (
        any(pixel[3] != 255 for pixel in pixels)
        or all(pixel == (0, 0, 0, 255) for pixel in pixels)
        or all(pixel == (255, 255, 255, 255) for pixel in pixels)
    ):
        return SkinModel.SLIM
    return SkinModel.CLASSIC


def _expand_legacy(image: Image.Image) -> Image.Image:
    result = Image.new("RGBA", (64, 64))
    result.paste(image, (0, 0))
    for source_x, target_x in ((0, 16), (40, 32)):
        # Legacy limbs share the right limb texture, reflected around the body.
        for source, target in (
            ((source_x + 4, 16, source_x + 8, 20), (target_x + 4, 48)),
            ((source_x + 8, 16, source_x + 12, 20), (target_x + 8, 48)),
            ((source_x + 8, 20, source_x + 12, 32), (target_x, 52)),
            ((source_x + 4, 20, source_x + 8, 32), (target_x + 4, 52)),
            ((source_x, 20, source_x + 4, 32), (target_x + 8, 52)),
            ((source_x + 12, 20, source_x + 16, 32), (target_x + 12, 52)),
        ):
            result.paste(image.crop(source).transpose(Image.Transpose.FLIP_LEFT_RIGHT), target)
    return result


def parse_skin(data: bytes, model: SkinModel = SkinModel.UNKNOWN) -> ParsedSkin:
    """Accept one 64×64 or 64×32 PNG while preserving the original file."""
    if (
        len(data) > MAX_SKIN_BYTES
        or len(data) < 33
        or data[:8] != PNG_SIGNATURE
        or data[12:16] != b"IHDR"
    ):
        raise InvalidSkin("Expected a 64×64 or 64×32 Minecraft skin PNG.")
    dimensions = struct.unpack(">II", data[16:24])
    if dimensions not in ((64, 64), (64, 32)):
        raise InvalidSkin("Expected a 64×64 or 64×32 Minecraft skin PNG.")
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != "PNG" or getattr(source, "n_frames", 1) != 1:
                raise InvalidSkin("Expected a single Minecraft skin PNG.")
            source.verify()
        with Image.open(BytesIO(data)) as source:
            image = source.convert("RGBA")
            image.load()
    except (OSError, ValueError, SyntaxError) as error:
        raise InvalidSkin("The skin PNG could not be decoded.") from error
    legacy = dimensions == (64, 32)
    if sum(image.getchannel("A").histogram()[:255]) == 0:
        # Fully opaque atlases use their background as an absent outer layer.
        image.paste((0, 0, 0, 0), (32, 0, 64, 16))
        if not legacy:
            for bounds in ((0, 32, 64, 48), (0, 48, 16, 64), (48, 48, 64, 64)):
                image.paste((0, 0, 0, 0), bounds)
    if legacy:
        image = _expand_legacy(image)
        model = SkinModel.CLASSIC
    return ParsedSkin(data, image, model, legacy, _render_model(image, model))
