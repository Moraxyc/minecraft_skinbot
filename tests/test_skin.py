import struct
from io import BytesIO
from pathlib import Path

import pytest
from minecraft_skin_bot.minecraft.models import SkinModel
from minecraft_skin_bot.skin.parser import InvalidSkin, parse_skin
from minecraft_skin_bot.skin.renderer import RenderKind, render_skin
from PIL import Image, ImageChops, ImageDraw


def png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def coordinate_skin(height: int = 64) -> bytes:
    image = Image.new("RGBA", (64, height))
    for y in range(height):
        for x in range(64):
            # Transparent outer layers leave face coordinates independently visible.
            if (y < 16 and x < 32) or 16 <= y < 32 or (y >= 48 and 16 <= x < 48):
                image.putpixel((x, y), (x * 3, y * 3, (x + y) * 2, 255))
    return png(image)


def color(x: int, y: int) -> tuple[int, int, int]:
    return (x * 3, y * 3, (x + y) * 2)


def test_front_back_side_uv_and_slim_arm_width() -> None:
    classic = parse_skin(coordinate_skin(), SkinModel.CLASSIC)
    front = Image.open(BytesIO(render_skin(classic, "front")))
    back = Image.open(BytesIO(render_skin(classic, "back")))
    side = Image.open(BytesIO(render_skin(classic, "side")))
    # Sample exact face texels in display pixels, independent of renderer helpers.
    assert front.getpixel((8 * 16 + 8, 3 * 16 + 8)) == color(8, 8)
    assert front.getpixel((8 * 16 + 8, 11 * 16 + 8)) == color(20, 20)
    assert front.getpixel((4 * 16 + 8, 11 * 16 + 8)) == color(44, 20)
    assert front.getpixel((16 * 16 + 8, 11 * 16 + 8)) == color(36, 52)
    assert front.getpixel((12 * 16 + 8, 23 * 16 + 8)) == color(20, 52)
    assert back.getpixel((8 * 16 + 8, 3 * 16 + 8)) == color(24, 8)
    assert back.getpixel((8 * 16 + 8, 11 * 16 + 8)) == color(32, 20)
    assert back.getpixel((4 * 16 + 8, 11 * 16 + 8)) == color(44, 52)
    assert back.getpixel((16 * 16 + 8, 11 * 16 + 8)) == color(52, 20)
    assert back.getpixel((8 * 16 + 8, 23 * 16 + 8)) == color(28, 52)
    assert side.getpixel((8 * 16 + 8, 3 * 16 + 8)) == color(0, 8)
    assert side.getpixel((10 * 16 + 8, 11 * 16 + 8)) == color(40, 20)
    assert side.getpixel((10 * 16 + 8, 23 * 16 + 8)) == color(0, 20)

    slim = Image.open(BytesIO(render_skin(parse_skin(coordinate_skin(), SkinModel.SLIM), "back")))
    assert slim.getpixel((5 * 16 + 8, 11 * 16 + 8)) == color(43, 52)
    assert slim.getpixel((16 * 16 + 8, 11 * 16 + 8)) == color(51, 20)
    assert slim.getpixel((4 * 16 + 8, 11 * 16 + 8)) == (239, 243, 248)


def test_legacy_left_limbs_are_reflected_and_original_is_preserved() -> None:
    original = coordinate_skin(32)
    skin = parse_skin(original, SkinModel.SLIM)
    assert skin.model == SkinModel.CLASSIC
    assert skin.image.getpixel((20, 52))[:3] == color(7, 20)
    assert skin.image.getpixel((23, 52))[:3] == color(4, 20)
    assert skin.image.getpixel((36, 52))[:3] == color(47, 20)
    assert skin.image.getpixel((44, 52))[:3] == color(55, 20)
    assert skin.image.getpixel((0, 36))[3] == 0
    assert render_skin(skin, "skin") == original


def test_hat_alpha_and_transparent_base_are_composited() -> None:
    image = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(image)
    draw.rectangle((8, 8, 15, 15), fill=(240, 0, 0, 255))
    draw.rectangle((40, 8, 47, 15), fill=(0, 0, 240, 128))
    result = Image.open(BytesIO(render_skin(parse_skin(png(image)), "head")))
    assert result.getpixel((192, 192)) == (120, 0, 120)
    assert result.getpixel((0, 0)) == (239, 243, 248)
    transparent = Image.open(
        BytesIO(render_skin(parse_skin(png(Image.new("RGBA", (64, 64)))), "head"))
    )
    assert transparent.getpixel((192, 192)) == (239, 243, 248)


def test_opaque_atlas_background_becomes_an_absent_outer_layer() -> None:
    skin = parse_skin(png(Image.new("RGB", (64, 64), "red")))
    assert skin.image.getpixel((8, 8)) == (255, 0, 0, 255)
    assert skin.image.getpixel((40, 8))[3] == 0
    assert skin.image.getpixel((20, 36))[3] == 0
    assert skin.image.getpixel((52, 52))[3] == 0


def test_unknown_upload_arm_detection_preserves_official_model_metadata() -> None:
    image = Image.open(BytesIO(coordinate_skin())).convert("RGBA")
    image.paste((0, 0, 0, 0), (50, 16, 52, 20))
    data = png(image)
    uploaded = parse_skin(data)
    assert uploaded.model == SkinModel.UNKNOWN
    assert uploaded.render_model == SkinModel.SLIM
    inferred_front = Image.open(BytesIO(render_skin(uploaded, "front")))
    assert inferred_front.getpixel((4 * 16 + 8, 11 * 16 + 8)) == (239, 243, 248)
    assert inferred_front.getpixel((5 * 16 + 8, 11 * 16 + 8)) == color(44, 20)
    official = parse_skin(data, SkinModel.CLASSIC)
    assert official.model == official.render_model == SkinModel.CLASSIC


@pytest.mark.parametrize("bad", [b"", b"not a png", b"\x89PNG\r\n\x1a\n" + b"0" * 80])
def test_malformed_png_is_a_clean_validation_error(bad: bytes) -> None:
    with pytest.raises(InvalidSkin):
        parse_skin(bad)


def test_size_header_and_corruption_are_rejected_before_rendering() -> None:
    valid = coordinate_skin()
    for invalid in (
        png(Image.new("RGB", (32, 32))),
        valid[:16] + struct.pack(">II", 100000, 100000) + valid[24:],
        valid[:50],
        valid + b"0" * 1048576,
    ):
        with pytest.raises(InvalidSkin):
            parse_skin(invalid)


@pytest.mark.parametrize("kind", ["head", "front", "back", "three-view"])
@pytest.mark.parametrize("model", [SkinModel.CLASSIC, SkinModel.SLIM])
def test_rendered_views_match_reviewed_golden_images(kind: RenderKind, model: SkinModel) -> None:
    actual = Image.open(BytesIO(render_skin(parse_skin(coordinate_skin(), model), kind)))
    expected = Image.open(Path(__file__).parent / "golden" / f"{model}-{kind}.png")
    assert actual.size == expected.size
    assert ImageChops.difference(actual.convert("RGB"), expected.convert("RGB")).getbbox() is None
