import asyncio
import shutil
from pathlib import Path

import pytest
from minecraft_skin_bot.cache import AsyncTTLCache, FileCache


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
