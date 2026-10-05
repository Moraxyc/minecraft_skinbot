import asyncio
import base64
import json
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import UUID

import aiohttp
import pytest
from aiohttp import web
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.client import MojangProfileProvider, texture_url
from minecraft_skin_bot.minecraft.models import SkinModel

NOTCH = UUID("069a79f4-44e9-4726-a5be-fca90e38aaf5")
TEXTURE = "a" * 64


@dataclass
class Harness:
    provider: MojangProfileProvider
    responses: dict[str, tuple[int, object]]
    calls: list[str]


@pytest.fixture
async def upstream() -> AsyncIterator[Harness]:
    responses: dict[str, tuple[int, object]] = {}
    calls: list[str] = []

    async def handle(request: web.Request) -> web.Response:
        calls.append(request.path)
        status, body = responses[request.path]
        if body == "timeout":
            await asyncio.sleep(0.1)
        if isinstance(body, bytes):
            return web.Response(status=status, body=body)
        return web.json_response(body, status=status)

    app = web.Application()
    app.router.add_get("/{path:.*}", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    await web.SockSite(runner, listener).start()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=0.05)) as session:

        class LocalSession:
            def get(self, url: str, *, allow_redirects: bool) -> Any:
                return session.get(
                    f"http://127.0.0.1:{port}" + urlsplit(url).path,
                    allow_redirects=allow_redirects,
                )

        provider = MojangProfileProvider(cast(aiohttp.ClientSession, LocalSession()))
        yield Harness(provider, responses, calls)
        await provider.close()
    await runner.cleanup()


def profile(
    *, model: str | None = None, texture_host: str = "textures.minecraft.net"
) -> dict[str, object]:
    skin: dict[str, object] = {"url": f"http://{texture_host}/texture/{TEXTURE}"}
    if model is not None:
        skin["metadata"] = {"model": model}
    textures = {"profileId": NOTCH.hex, "textures": {"SKIN": skin}}
    return {
        "id": NOTCH.hex,
        "name": "Notch",
        "properties": [
            {
                "name": "textures",
                "value": base64.b64encode(json.dumps(textures).encode()).decode(),
            }
        ],
    }


@pytest.mark.parametrize(
    "model,expected",
    [(None, SkinModel.CLASSIC), ("slim", SkinModel.SLIM), ("future", SkinModel.UNKNOWN)],
)
async def test_exact_profile_lookup_preserves_uuid_and_model(
    upstream: Harness, model: str | None, expected: SkinModel
) -> None:
    upstream.responses["/users/profiles/minecraft/Notch"] = (
        200,
        {"id": NOTCH.hex, "name": "Notch"},
    )
    upstream.responses[f"/session/minecraft/profile/{NOTCH.hex}"] = (200, profile(model=model))
    assert await upstream.provider.resolve_username("Notch") == NOTCH
    found = await upstream.provider.get_profile(NOTCH)
    assert found.uuid == NOTCH
    assert found.name == "Notch"
    assert found.model == expected
    assert found.skin_url == f"https://textures.minecraft.net/texture/{TEXTURE}"
    assert await upstream.provider.resolve_username("Notch") == NOTCH
    assert upstream.calls.count("/users/profiles/minecraft/Notch") == 1


@pytest.mark.parametrize(
    "status,body",
    [
        (204, b""),
        (404, {"error": "missing"}),
        (200, b"not-json"),
        (200, {"id": "wrong"}),
        (200, "timeout"),
        (302, {}),
    ],
)
async def test_missing_malformed_redirect_and_timeout_have_clean_errors(
    upstream: Harness, status: int, body: object
) -> None:
    upstream.responses[f"/session/minecraft/profile/{NOTCH.hex}"] = (status, body)
    with pytest.raises(UtilityError) as error:
        await upstream.provider.get_profile(NOTCH)
    assert error.value.status == (404 if status in {204, 404} else 502)
    assert NOTCH.hex not in error.value.message


async def test_profile_rejects_untrusted_texture_and_oversized_response(upstream: Harness) -> None:
    path = f"/session/minecraft/profile/{NOTCH.hex}"
    upstream.responses[path] = (200, profile(texture_host="127.0.0.1"))
    with pytest.raises(UtilityError):
        await upstream.provider.get_profile(NOTCH)
    upstream.responses[path] = (200, b"x" * 1048577)
    with pytest.raises(UtilityError):
        await upstream.provider.get_profile(NOTCH)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/texture/" + TEXTURE,
        "https://textures.minecraft.net@evil.example/texture/" + TEXTURE,
        "https://textures.minecraft.net:443/texture/" + TEXTURE,
        "https://textures.minecraft.net/texture/" + TEXTURE + "?redirect=evil",
        "https://textures.minecraft.net/texture/../profile",
    ],
)
def test_texture_allowlist_rejects_ssrf_and_arbitrary_paths(url: str) -> None:
    with pytest.raises(ValueError):
        texture_url(url)
