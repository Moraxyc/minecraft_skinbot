import asyncio
import hashlib
import shutil
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pytest
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.models import Profile, SkinModel
from minecraft_skin_bot.service import SkinService
from PIL import Image

PLAYER = UUID("069a79f4-44e9-4726-a5be-fca90e38aaf5")


def skin_bytes(color: str, height: int = 64) -> bytes:
    output = BytesIO()
    Image.new("RGBA", (64, height), color).save(output, format="PNG")
    return output.getvalue()


class Provider:
    def __init__(self) -> None:
        self.color = "red"
        self.downloads = 0
        self.has_skin = True
        self.cape: bytes | None = None

    async def resolve_username(self, username: str) -> UUID:
        return PLAYER

    async def get_profile(self, uuid: UUID) -> Profile:
        return Profile(
            PLAYER,
            "Notch",
            SkinModel.CLASSIC,
            self.color if self.has_skin else None,
            "cape:" + hashlib.sha256(self.cape).hexdigest() if self.cape else None,
        )

    async def get_skin(self, url: str) -> bytes:
        self.downloads += 1
        await asyncio.sleep(0.01)
        return self.cape if url.startswith("cape:") and self.cape is not None else skin_bytes(url)


def settings(tmp_path: Path) -> Settings:
    return Settings(
        "synthetic",
        -100123,
        "https://viewer.example",
        "https://api.example",
        cache_dir=tmp_path,
        upload_ttl_seconds=60,
    )


async def test_profile_skin_changes_refresh_content_and_cache_deletion_recovers(
    tmp_path: Path,
) -> None:
    provider = Provider()
    service = SkinService(provider, FileCache(tmp_path / "content"), settings(tmp_path))
    assets = await asyncio.gather(*(service.resolve("Notch") for _ in range(6)))
    assert provider.downloads == 1
    assert len({asset.content_hash for asset in assets}) == 1
    red = await service.preview(assets[0], "front")
    provider.color = "blue"
    changed = await service.resolve(PLAYER.hex)
    assert changed.content_hash != assets[0].content_hash
    assert await service.preview(changed, "front") != red
    await asyncio.to_thread(shutil.rmtree, tmp_path / "content")
    recovered = await service.resolve(PLAYER.hex)
    assert await service.preview(recovered, "front") == await service.preview(changed, "front")
    assert provider.downloads == 3
    await service.close()


async def test_upload_reference_expires_and_original_remains_exact(tmp_path: Path) -> None:
    service = SkinService(Provider(), FileCache(tmp_path / "content"), settings(tmp_path))
    original = skin_bytes("green", height=32)
    asset = await service.upload(original)
    assert asset.uuid is None
    assert asset.model == SkinModel.CLASSIC
    assert await service.preview(asset, "skin") == original
    assert (await service.resolve(asset.reference)).skin == original
    assert "upload=" + asset.content_hash in service.viewer_url(asset)
    await service.uploads.put(asset.content_hash, b"damaged cache file")
    with pytest.raises(UtilityError) as damaged:
        await service.resolve(asset.reference)
    assert damaged.value.status == 410
    assert await service.uploads.get(asset.content_hash) is None
    with pytest.raises(UtilityError) as error:
        await service.resolve(asset.reference)
    assert error.value.status == 410
    with pytest.raises(UtilityError):
        await service.upload(b"invalid PNG")
    await service.close()
