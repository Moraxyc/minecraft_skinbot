import asyncio
import hashlib
import os
import tempfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from minecraft_skin_bot.cache.memory import AsyncTTLCache


class FileCache:
    """Disposable, atomically written files addressed by hashed content keys."""

    def __init__(self, directory: Path, ttl: int = 604800) -> None:
        self.directory = directory
        self.ttl = ttl
        self._flights: AsyncTTLCache[str, bytes] = AsyncTTLCache(ttl=0)

    def _path(self, key: str) -> Path:
        return self.directory / hashlib.sha256(key.encode()).hexdigest()

    def _read(self, key: str, ttl: int) -> bytes | None:
        path = self._path(key)
        try:
            if time.time() - path.stat().st_mtime >= ttl:
                path.unlink(missing_ok=True)
                return None
            return path.read_bytes()
        except FileNotFoundError:
            return None

    async def get(self, key: str, *, ttl: int | None = None) -> bytes | None:
        return await asyncio.to_thread(self._read, key, self.ttl if ttl is None else ttl)

    def _write(self, key: str, data: bytes) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".write-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(data)
            os.replace(temporary, self._path(key))
        finally:
            Path(temporary).unlink(missing_ok=True)

    async def put(self, key: str, data: bytes) -> None:
        await asyncio.to_thread(self._write, key, data)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._path(key).unlink, missing_ok=True)

    async def get_or_create(
        self, key: str, factory: Callable[[], Awaitable[bytes]], *, ttl: int | None = None
    ) -> bytes:
        async def produce() -> bytes:
            cached = await self.get(key, ttl=ttl)
            if cached is not None:
                return cached
            value = await factory()
            await self.put(key, value)
            return value

        return await self._flights.get_or_create(key, produce)

    def _prune(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        now = time.time()
        for path in self.directory.iterdir():
            if path.is_file() and (len(path.name) == 64 or path.name.startswith(".write-")):
                try:
                    if now - path.stat().st_mtime >= self.ttl:
                        path.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass

    async def prune(self) -> None:
        await asyncio.to_thread(self._prune)

    async def close(self) -> None:
        await self._flights.close()
