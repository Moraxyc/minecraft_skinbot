import asyncio
import os
import shutil
from pathlib import Path

import pytest
from minecraft_skin_bot.cache import AsyncTTLCache, FileCache
from minecraft_skin_bot.cache.content import CacheBudget
from minecraft_skin_bot.errors import UtilityError


async def test_content_cache_deduplicates_and_recovers_after_deletion(tmp_path: Path) -> None:
    cache = FileCache(tmp_path / "cache")
    calls = 0

    async def compute() -> bytes:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return b"rendered skin"

    values = await asyncio.gather(
        *(cache.get_or_create("../user/texture:head:v1", compute) for _ in range(8))
    )
    assert values == [b"rendered skin"] * 8
    assert calls == 1
    assert all(len(path.name) == 64 for path in cache.directory.iterdir())
    shutil.rmtree(cache.directory)
    assert await cache.get_or_create("../user/texture:head:v1", compute) == b"rendered skin"
    assert calls == 2


async def test_cancelled_waiter_preserves_shared_work_and_failed_work_can_retry() -> None:
    cache: AsyncTTLCache[str, bytes] = AsyncTTLCache()
    entered = asyncio.Event()
    finish = asyncio.Event()
    calls = 0

    async def compute() -> bytes:
        nonlocal calls
        calls += 1
        entered.set()
        await finish.wait()
        return b"skin"

    first = asyncio.create_task(cache.get_or_create("skin", compute))
    await entered.wait()
    second = asyncio.create_task(cache.get_or_create("skin", compute))
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    finish.set()
    assert await second == b"skin"
    assert calls == 1

    async def failure() -> bytes:
        raise RuntimeError("upstream unavailable")

    with pytest.raises(RuntimeError):
        await cache.get_or_create("retry", failure)
    assert await cache.get_or_create("retry", compute) == b"skin"
    await cache.close()


async def test_expired_files_are_regenerated(tmp_path: Path) -> None:
    cache = FileCache(tmp_path)
    await cache.put("upload:content", b"old skin")
    assert await cache.get("upload:content", ttl=0) is None
    assert await asyncio.to_thread(lambda: list(tmp_path.iterdir())) == []


async def test_shared_budget_evicts_rebuildable_entries_and_preserves_active_uploads(
    tmp_path: Path,
) -> None:
    budget = CacheBudget(10)
    content = FileCache(tmp_path / "content")
    uploads = FileCache(tmp_path / "uploads", ttl=60)
    content.attach_budget(budget)
    uploads.attach_budget(budget, protected=True)
    await content.put("telegram-file-id", b"cached")
    original_expiry = await uploads.put("original", b"123456")
    assert await content.get("telegram-file-id") is None
    results = await asyncio.gather(
        uploads.put("new-a", b"abcd"), uploads.put("new-b", b"ABCD"), return_exceptions=True
    )
    assert sum(isinstance(value, UtilityError) for value in results) == 1
    assert sum(path.stat().st_size for path in uploads.directory.iterdir()) == 10
    assert await uploads.get("original") == b"123456"
    for path in uploads.directory.iterdir():
        if path.read_bytes() == b"123456":
            modified_at = path.stat().st_mtime - 30
            os.utime(path, (modified_at, modified_at))
    assert await uploads.put("original", b"123456") > original_expiry - 30
    assert sum(path.stat().st_size for path in uploads.directory.iterdir()) == 10
    for path in uploads.directory.iterdir():
        os.utime(path, (0, 0))
    await uploads.put("after-expiry", b"abcdefghij")
    assert await uploads.get("original") is None
    assert await uploads.get("after-expiry") == b"abcdefghij"
    await content.close()
    await uploads.close()


async def test_failed_atomic_upload_write_preserves_previous_bytes_and_expiration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = FileCache(tmp_path)
    cache.attach_budget(CacheBudget(20), protected=True)
    expiry = await cache.put("upload", b"original")

    def failed_replace(source: str, target: Path) -> None:
        raise OSError("Synthetic disk error")

    monkeypatch.setattr(os, "replace", failed_replace)
    with pytest.raises(OSError, match="Synthetic disk error"):
        await cache.put("upload", b"replacement")
    assert await cache.get_with_expiry("upload") == (b"original", expiry)
    assert sum(path.stat().st_size for path in tmp_path.iterdir()) == len(b"original")
    await cache.close()
