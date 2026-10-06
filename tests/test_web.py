from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from minecraft_skin_bot.cache import FileCache
from minecraft_skin_bot.service import SkinService
from minecraft_skin_bot.web import create_web_app
from test_service import Provider, settings, skin_bytes


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
    assert invalid.status == 502
    assert (await invalid.json())["error"] == "Cape unavailable"
