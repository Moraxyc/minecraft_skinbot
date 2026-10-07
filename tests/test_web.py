from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.errors import UtilityError
from minecraft_skin_bot.minecraft.models import Profile
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.web import create_web_app
from test_service import Provider, TextureProvider, settings, skin_bytes


@pytest.fixture
async def api(
    tmp_path: Path,
) -> AsyncIterator[tuple[TestClient[web.Request, web.Application], SkinService]]:
    service = SkinService(Provider(), FileCache(tmp_path / "content"), settings(tmp_path))
    async with TestClient(TestServer(create_web_app(service, "runtime_skin_bot"))) as client:
        yield client, service
    await service.close()


async def test_viewer_profile_uses_public_content_urls_and_expected_cors(
    api: tuple[TestClient[web.Request, web.Application], SkinService],
) -> None:
    client, _ = api
    uuid = UUID("069a79f4-44e9-4726-a5be-fca90e38aaf5").hex
    response = await client.get(
        f"/api/profile/{uuid}", headers={"Origin": "https://viewer.example"}
    )
    data = await response.json()
    assert response.status == 200
    assert data["uuid"] == uuid
    assert data["reference"] == uuid
    assert data["model"] == "classic"
    assert data["upload_expires_at"] is None
    assert data["cape_unavailable"] is False
    assert data["bot_username"] == "runtime_skin_bot"
    assert response.headers["Access-Control-Allow-Origin"] == "https://viewer.example"
    media = await client.get(data["skin_url"].replace("https://api.example", ""))
    assert media.content_type == "image/png"
    assert media.headers["X-Content-Type-Options"] == "nosniff"
    assert await media.read() == skin_bytes("red")
    denied = await client.get(f"/api/profile/{uuid}", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in denied.headers


async def test_expired_upload_and_invalid_public_paths_return_clean_errors(
    api: tuple[TestClient[web.Request, web.Application], SkinService],
) -> None:
    client, service = api
    uploaded = await service.upload(skin_bytes("blue"))
    response = await client.get("/api/upload/" + uploaded.content_hash)
    assert response.status == 200
    data = await response.json()
    assert data["reference"] == uploaded.reference
    assert data["upload_expires_at"] == uploaded.upload_expires_at
    assert response.headers["Cache-Control"] == "no-store"
    assert data["bot_username"] == "runtime_skin_bot"
    expired = await client.get("/api/upload/" + "0" * 64)
    assert expired.status == 410
    assert (await expired.json())["message"] == "Send the skin PNG to the bot again."
    invalid = await client.get("/api/profile/not-a-uuid")
    assert invalid.status == 400
    media = await client.get("/api/skin/not-a-hash.png")
    assert media.status == 404


async def test_missing_skin_and_cape_content_have_public_viewer_contracts(
    api: tuple[TestClient[web.Request, web.Application], SkinService],
) -> None:
    client, service = api
    provider = cast(Provider, service.provider)
    provider.has_skin = False
    path = "/api/profile/069a79f444e94726a5befca90e38aaf5"
    missing = await client.get(path)
    assert missing.status == 404
    assert (await missing.json())["error"] == "Skin unavailable"
    provider.has_skin = True
    provider.cape = skin_bytes("yellow", height=32)
    response = await client.get(path)
    data = await response.json()
    cape = await client.get(data["cape_url"].replace("https://api.example", ""))
    assert cape.content_type == "image/png"
    assert await cape.read() == provider.cape
    provider.cape = skin_bytes("yellow", height=64)
    invalid = await client.get(path)
    assert invalid.status == 200
    degraded = await invalid.json()
    assert degraded["cape_url"] is None
    assert degraded["cape_unavailable"] is True
    assert degraded["skin_url"] == data["skin_url"]


async def test_snapshot_api_returns_the_shared_texture_after_player_changes(
    api: tuple[TestClient[web.Request, web.Application], SkinService],
) -> None:
    client, service = api
    provider = TextureProvider()
    service.provider = provider
    original = await (await client.get("/api/profile/069a79f444e94726a5befca90e38aaf5")).json()
    provider.color = "blue"
    changed = await (await client.get("/api/profile/069a79f444e94726a5befca90e38aaf5")).json()
    assert changed["skin_url"] != original["skin_url"]
    snapshot = original["snapshot_reference"]
    response = await client.get("/api/texture/" + snapshot.removeprefix("texture:"))
    fixed = await response.json()
    assert response.status == 200
    assert fixed["reference"] == fixed["snapshot_reference"] == snapshot
    assert fixed["skin_url"] == original["skin_url"]
    assert fixed["upload_expires_at"] is None
    assert fixed["uuid"] is None
    assert fixed["name"] == "Shared skin"


async def test_public_rate_limit_response_carries_the_retry_delay(
    api: tuple[TestClient[web.Request, web.Application], SkinService],
) -> None:
    client, service = api

    class LimitedProvider(Provider):
        async def get_profile(self, uuid: UUID) -> Profile:
            raise UtilityError("Minecraft rate limited", "Retry later.", status=429, retry_after=5)

    service.provider = LimitedProvider()
    response = await client.get(
        "/api/profile/069a79f444e94726a5befca90e38aaf5",
        headers={"Origin": "https://viewer.example"},
    )
    assert response.status == 429
    assert response.headers["Retry-After"] == "5"
    assert response.headers["Access-Control-Expose-Headers"] == "Retry-After"
    assert (await response.json())["error"] == "Minecraft rate limited"
