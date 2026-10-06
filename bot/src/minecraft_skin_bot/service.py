import asyncio
import hashlib
import re
import struct
from dataclasses import dataclass
from io import BytesIO
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from PIL import Image

from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.config import Settings
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.models import SkinModel
from minecraft_skin_bot.minecraft.provider import MinecraftProfileProvider
from minecraft_skin_bot.skin.parser import InvalidSkin, parse_skin
from minecraft_skin_bot.skin.renderer import RENDERER_VERSION, RenderKind, render_skin

CONTENT_HASH = re.compile(r"[0-9a-f]{64}\Z")
UUID_REFERENCE = re.compile(
    r"(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\Z"
)


@dataclass(frozen=True, slots=True)
class SkinAsset:
    reference: str
    name: str
    uuid: UUID | None
    model: SkinModel
    content_hash: str
    skin: bytes
    cape_url: str | None


class SkinService:
    def __init__(
        self, provider: MinecraftProfileProvider, cache: FileCache, settings: Settings
    ) -> None:
        self.provider = provider
        self.cache = cache
        self.settings = settings
        self.uploads = FileCache(settings.cache_dir / "uploads", ttl=settings.upload_ttl_seconds)

    @staticmethod
    def _model(data: bytes, model: SkinModel) -> SkinModel:
        parsed = parse_skin(data, model)
        parsed.image.close()
        return parsed.model

    async def resolve(self, reference: str) -> SkinAsset:
        if reference.startswith("upload:"):
            digest = reference.removeprefix("upload:")
            if not CONTENT_HASH.fullmatch(digest):
                raise UtilityError("Invalid skin", "Open a skin link or send a Minecraft skin PNG.")
            data = await self.uploads.get(digest)
            if data is None:
                raise UtilityError(
                    "Upload expired", "Send the skin PNG to the bot again.", status=410
                )
            try:
                model = await asyncio.to_thread(self._model, data, SkinModel.UNKNOWN)
            except InvalidSkin as exc:
                await self.uploads.delete(digest)
                raise UtilityError(
                    "Upload expired", "Send the skin PNG to the bot again.", status=410
                ) from exc
            return SkinAsset(reference, "Uploaded skin", None, model, digest, data, None)
        uuid = (
            UUID(reference)
            if UUID_REFERENCE.fullmatch(reference)
            else await self.provider.resolve_username(reference)
        )
        profile = await self.provider.get_profile(uuid)
        skin_url = profile.skin_url
        if skin_url is None:
            raise UtilityError(
                "Skin unavailable", "This profile has no public skin texture.", status=404
            )
        data = await self.cache.get_or_create(
            "texture:" + skin_url, lambda: self.provider.get_skin(skin_url)
        )
        try:
            model = await asyncio.to_thread(self._model, data, profile.model)
        except InvalidSkin as exc:
            raise UtilityError(
                "Skin unavailable", "Minecraft returned an unsupported skin texture.", status=502
            ) from exc
        digest = hashlib.sha256(data).hexdigest()
        await self.cache.put("skin:" + digest, data)
        cape_url = None
        cape_texture_url = profile.cape_url
        if cape_texture_url is not None:
            cape = await self.cache.get_or_create(
                "texture:" + cape_texture_url,
                lambda: self.provider.get_skin(cape_texture_url),
            )
            await asyncio.to_thread(self._validate_cape, cape)
            cape_hash = hashlib.sha256(cape).hexdigest()
            await self.cache.put("cape:" + cape_hash, cape)
            cape_url = self.settings.public_base_url + f"/api/cape/{cape_hash}.png"
        return SkinAsset(uuid.hex, profile.name, uuid, model, digest, data, cape_url)

    @staticmethod
    def _validate_cape(data: bytes) -> None:
        try:
            if (
                len(data) < 33
                or len(data) > 1048576
                or data[:8] != b"\x89PNG\r\n\x1a\n"
                or data[12:16] != b"IHDR"
                or struct.unpack(">II", data[16:24]) not in {(64, 32), (22, 17)}
            ):
                raise ValueError("Unsupported cape")
            with Image.open(BytesIO(data)) as image:
                if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Unsupported cape")
                image.verify()
        except (OSError, ValueError) as exc:
            raise UtilityError(
                "Cape unavailable", "Minecraft returned an unsupported cape texture.", status=502
            ) from exc

    async def upload(self, data: bytes) -> SkinAsset:
        try:
            model = await asyncio.to_thread(self._model, data, SkinModel.UNKNOWN)
        except InvalidSkin as exc:
            raise UtilityError(
                "Invalid skin", "Expected a 64×64 or 64×32 Minecraft skin PNG."
            ) from exc
        digest = hashlib.sha256(data).hexdigest()
        await self.uploads.put(digest, data)
        return SkinAsset("upload:" + digest, "Uploaded skin", None, model, digest, data, None)

    def render_key(self, asset: SkinAsset, kind: RenderKind) -> str:
        return f"render:{asset.content_hash}:{asset.model}:{kind}:v{RENDERER_VERSION}"

    async def preview(self, asset: SkinAsset, kind: RenderKind) -> bytes:
        def render() -> bytes:
            parsed = parse_skin(asset.skin, asset.model)
            try:
                return render_skin(parsed, kind)
            finally:
                parsed.image.close()

        async def produce() -> bytes:
            return await asyncio.to_thread(render)

        return await self.cache.get_or_create(self.render_key(asset, kind), produce)

    def viewer_url(self, asset: SkinAsset, *, locale: str | None = None) -> str:
        parsed = urlsplit(self.settings.mini_app_url)
        params = dict(parse_qsl(parsed.query))
        params.pop("uuid", None)
        params.pop("upload", None)
        params.pop("lang", None)
        params["uuid" if asset.uuid else "upload"] = (
            asset.uuid.hex if asset.uuid else asset.content_hash
        )
        if locale:
            # Mini Apps launched from a keyboard button or inline mode get empty initData, so
            # the caller's language travels in the URL instead of Telegram.WebApp.
            params["lang"] = locale
        return urlunsplit(parsed._replace(query=urlencode(params)))

    async def read_skin(self, digest: str) -> bytes:
        if CONTENT_HASH.fullmatch(digest):
            found = await self.cache.get("skin:" + digest) or await self.uploads.get(digest)
            if found is not None:
                return found
        raise UtilityError(
            "Skin unavailable", "Open the profile or upload the PNG again.", status=404
        )

    async def read_cape(self, digest: str) -> bytes:
        if CONTENT_HASH.fullmatch(digest):
            found = await self.cache.get("cape:" + digest)
            if found is not None:
                return found
        raise UtilityError("Cape unavailable", "Open the profile again.", status=404)

    async def close(self) -> None:
        await self.uploads.close()
        await self.cache.close()
