import base64
import json
import math
import re
from email.utils import parsedate_to_datetime
from time import monotonic, time
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import aiohttp

from minecraft_skin_bot.cache import AsyncTTLCache
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.models import Profile, SkinModel

USERNAME = re.compile(r"[A-Za-z0-9_]{3,16}\Z")
TEXTURE_PATH = re.compile(r"/texture/[0-9a-f]{32,64}\Z")
MAX_RESPONSE_BYTES = 1048576
MAX_RETRY_AFTER_SECONDS = 300


def texture_url(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Missing texture URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname != "textures.minecraft.net"
        or parsed.username
        or parsed.password
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or not TEXTURE_PATH.fullmatch(parsed.path)
    ):
        raise ValueError("Untrusted texture URL")
    return "https://textures.minecraft.net" + parsed.path


def unavailable() -> UtilityError:
    return UtilityError("Minecraft is unavailable", "Try the lookup again in a moment.", status=502)


def retry_after_seconds(value: str | None) -> int:
    seconds = 30.0
    if value is not None:
        if value.isascii() and value.isdigit():
            seconds = float(value) if len(value) < 10 else float(MAX_RETRY_AFTER_SECONDS)
        else:
            try:
                seconds = parsedate_to_datetime(value).timestamp() - time()
            except (TypeError, ValueError, OverflowError):
                pass
    return max(1, min(MAX_RETRY_AFTER_SECONDS, math.ceil(seconds)))


def rate_limited(seconds: int) -> UtilityError:
    return UtilityError(
        "Minecraft rate limited",
        "Try the lookup again in {seconds} seconds.",
        status=429,
        params={"seconds": str(seconds)},
        retry_after=seconds,
    )


class MojangProfileProvider:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session
        self._usernames: AsyncTTLCache[str, UUID] = AsyncTTLCache(ttl=60)
        self._profiles: AsyncTTLCache[UUID, Profile] = AsyncTTLCache(ttl=60)
        self._textures: AsyncTTLCache[str, bytes] = AsyncTTLCache(ttl=300, max_entries=128)
        self._missing: dict[str, float] = {}
        self._cooldowns: dict[str, float] = {}

    async def _request(self, url: str, *, missing: UtilityError) -> bytes:
        now = monotonic()
        missing_key = url.casefold()
        if self._missing.get(missing_key, 0) > now:
            raise missing
        host = urlsplit(url).netloc
        cooldown = self._cooldowns.get(host, 0) - now
        if cooldown > 0:
            raise rate_limited(math.ceil(cooldown))
        try:
            async with self.session.get(url, allow_redirects=False) as response:
                if response.status in {204, 404}:
                    if missing.status == 404:
                        self._missing = {
                            key: expiry for key, expiry in self._missing.items() if expiry > now
                        }
                        if len(self._missing) >= 512:
                            self._missing.pop(next(iter(self._missing)))
                        self._missing[missing_key] = monotonic() + 30
                    raise missing
                if response.status == 429:
                    seconds = retry_after_seconds(response.headers.get("Retry-After"))
                    self._cooldowns[host] = max(self._cooldowns.get(host, 0), monotonic() + seconds)
                    raise rate_limited(seconds)
                if response.status != 200:
                    raise unavailable()
                if response.content_length and response.content_length > MAX_RESPONSE_BYTES:
                    raise unavailable()
                data = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise unavailable()
                return bytes(data)
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise unavailable() from exc

    async def _json(self, url: str, *, missing: UtilityError) -> dict[str, Any]:
        payload = await self._request(url, missing=missing)
        try:
            value: object = json.loads(payload)
            if not isinstance(value, dict):
                raise ValueError("Expected an object")
            return value
        except ValueError as exc:
            raise unavailable() from exc

    async def resolve_username(self, username: str) -> UUID:
        if not USERNAME.fullmatch(username):
            raise UtilityError(
                "Invalid player", "Send a Minecraft username (3–16 characters) or UUID."
            )

        async def lookup() -> UUID:
            data = await self._json(
                "https://api.mojang.com/users/profiles/minecraft/" + username,
                missing=UtilityError(
                    "Player not found",
                    'No Minecraft profile named "{username}" was found.',
                    status=404,
                    params={"username": username},
                ),
            )
            try:
                uuid = UUID(hex=data["id"])
                name = data["name"]
                if not isinstance(name, str) or name.casefold() != username.casefold():
                    raise ValueError("Profile name mismatch")
                return uuid
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                raise unavailable() from exc

        return await self._usernames.get_or_create(username.casefold(), lookup)

    async def get_profile(self, uuid: UUID) -> Profile:
        async def lookup() -> Profile:
            data = await self._json(
                "https://sessionserver.mojang.com/session/minecraft/profile/" + uuid.hex,
                missing=UtilityError(
                    "Player not found", "No Minecraft profile with this UUID was found.", status=404
                ),
            )
            try:
                if UUID(hex=data["id"]) != uuid or not USERNAME.fullmatch(data["name"]):
                    raise ValueError("Invalid profile identity")
                properties = data.get("properties", [])
                texture_properties = [p for p in properties if p["name"] == "textures"]
                if len(texture_properties) > 1:
                    raise ValueError("Ambiguous texture properties")
                textures: dict[str, Any] = {}
                if texture_properties:
                    encoded = texture_properties[0]["value"]
                    texture_data = json.loads(base64.b64decode(encoded, validate=True))
                    if UUID(hex=texture_data["profileId"]) != uuid:
                        raise ValueError("Texture profile mismatch")
                    textures = texture_data["textures"]
                    if not isinstance(textures, dict):
                        raise ValueError("Invalid texture object")
                skin = textures.get("SKIN")
                cape = textures.get("CAPE")
                model = SkinModel.UNKNOWN
                skin_url = None
                if skin is not None:
                    skin_url = texture_url(skin["url"])
                    metadata = skin.get("metadata", {})
                    declared = metadata.get("model", "classic")
                    model = {"classic": SkinModel.CLASSIC, "slim": SkinModel.SLIM}.get(
                        declared, SkinModel.UNKNOWN
                    )
                cape_url = texture_url(cape["url"]) if cape is not None else None
                return Profile(uuid, data["name"], model, skin_url, cape_url)
            except (
                KeyError,
                TypeError,
                ValueError,
                AttributeError,
            ) as exc:
                raise unavailable() from exc

        return await self._profiles.get_or_create(uuid, lookup)

    async def get_skin(self, url: str) -> bytes:
        try:
            safe_url = texture_url(url)
        except ValueError as exc:
            raise unavailable() from exc

        async def download() -> bytes:
            data = await self._request(safe_url, missing=unavailable())
            if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                raise unavailable()
            return data

        return await self._textures.get_or_create(safe_url, download)

    async def close(self) -> None:
        await self._usernames.close()
        await self._profiles.close()
        await self._textures.close()
