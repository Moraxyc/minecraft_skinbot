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
from minecraft_skin_bot.minecraft import client as client_module
from minecraft_skin_bot.minecraft.client import MojangProfileProvider, texture_url
from minecraft_skin_bot.minecraft.models import SkinModel

NOTCH = UUID("069a79f4-44e9-4726-a5be-fca90e38aaf5")
TEXTURE = "a" * 64


@dataclass
class Harness:
    provider: MojangProfileProvider
    responses: dict[str, tuple[int, object]]
    calls: list[str]
    headers: dict[str, dict[str, str]]


@dataclass
class StreamBody:
    data: bytes


@pytest.fixture
async def upstream() -> AsyncIterator[Harness]:
    responses: dict[str, tuple[int, object]] = {}
    calls: list[str] = []
    headers: dict[str, dict[str, str]] = {}

    async def handle(request: web.Request) -> web.StreamResponse:
        calls.append(request.path)
        status, body = responses[request.path]
        if isinstance(body, StreamBody):
            response = web.StreamResponse(status=status)
            await response.prepare(request)
            await response.write(body.data)
            await response.write_eof()
            return response
        if body == "timeout":
            await asyncio.sleep(0.1)
        if isinstance(body, bytes):
            return web.Response(status=status, body=body, headers=headers.get(request.path))
        return web.json_response(body, status=status, headers=headers.get(request.path))

    app = web.Application()
    app.router.add_get("/{path:.*}", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    await web.SockSite(runner, listener).start()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as session:

        class LocalSession:
            def get(self, url: str, *, allow_redirects: bool) -> Any:
                path = urlsplit(url).path
                timeout = (
                    aiohttp.ClientTimeout(total=0.05)
                    if responses[path][1] == "timeout"
                    else session.timeout
                )
                return session.get(
                    f"http://127.0.0.1:{port}" + path,
                    allow_redirects=allow_redirects,
                    timeout=timeout,
                )

        provider = MojangProfileProvider(cast(aiohttp.ClientSession, LocalSession()))
        yield Harness(provider, responses, calls, headers)
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
    if body == "timeout":
        assert isinstance(error.value.__cause__, TimeoutError)


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


@pytest.mark.parametrize("body", [b"not a PNG", StreamBody(b"\x89PNG\r\n\x1a\n" + b"x" * 1048576)])
async def test_texture_download_rejects_invalid_png_and_oversized_chunked_body(
    upstream: Harness,
    body: object,
) -> None:
    upstream.responses["/texture/" + TEXTURE] = (200, body)
    with pytest.raises(UtilityError) as error:
        await upstream.provider.get_skin("https://textures.minecraft.net/texture/" + TEXTURE)
    assert error.value.status == 502


@pytest.mark.parametrize("lookup", ["username", "profile"])
async def test_missing_players_are_cached_briefly_then_can_be_found(
    upstream: Harness, monkeypatch: pytest.MonkeyPatch, lookup: str
) -> None:
    now = [100.0]
    monkeypatch.setattr(client_module, "monotonic", lambda: now[0])
    path = (
        "/users/profiles/minecraft/Notch"
        if lookup == "username"
        else f"/session/minecraft/profile/{NOTCH.hex}"
    )
    upstream.responses[path] = (404, {})

    async def query() -> object:
        return (
            await upstream.provider.resolve_username("Notch")
            if lookup == "username"
            else await upstream.provider.get_profile(NOTCH)
        )

    for _ in range(2):
        with pytest.raises(UtilityError) as missing:
            await query()
        assert missing.value.status == 404
    assert upstream.calls.count(path) == 1
    upstream.responses[path] = (
        200,
        {"id": NOTCH.hex, "name": "Notch"} if lookup == "username" else profile(),
    )
    now[0] = 131.0
    assert await query() is not None
    assert upstream.calls.count(path) == 2


@pytest.mark.parametrize(
    "retry_after,expected",
    [
        ("5", 5),
        ("9999999999999999", 300),
        ("bad", 30),
        (None, 30),
        ("Thu, 01 Jan 1970 00:16:45 GMT", 5),
    ],
)
async def test_mojang_rate_limits_have_bounded_shared_cooldown_and_recover(
    upstream: Harness, monkeypatch: pytest.MonkeyPatch, retry_after: str | None, expected: int
) -> None:
    now = [100.0]
    monkeypatch.setattr(client_module, "monotonic", lambda: now[0])
    monkeypatch.setattr(client_module, "time", lambda: 1000.0)
    path = f"/session/minecraft/profile/{NOTCH.hex}"
    other = UUID("12345678123456781234567812345678")
    other_path = f"/session/minecraft/profile/{other.hex}"
    upstream.responses[other_path] = (404, {})
    upstream.responses[path] = (429, {})
    if retry_after is not None:
        upstream.headers[path] = {"Retry-After": retry_after}
    with pytest.raises(UtilityError) as limited:
        await upstream.provider.get_profile(NOTCH)
    assert limited.value.status == 429
    assert limited.value.retry_after == expected
    with pytest.raises(UtilityError) as cooling:
        await upstream.provider.get_profile(other)
    assert cooling.value.status == 429
    assert cooling.value.retry_after == expected
    assert other_path not in upstream.calls
    username_path = "/users/profiles/minecraft/Notch"
    upstream.responses[username_path] = (200, {"id": NOTCH.hex, "name": "Notch"})
    assert await upstream.provider.resolve_username("Notch") == NOTCH
    now[0] += expected + 1
    upstream.responses[path] = (200, profile())
    assert (await upstream.provider.get_profile(NOTCH)).name == "Notch"
    assert upstream.calls.count(path) == 2
