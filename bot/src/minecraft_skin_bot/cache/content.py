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

    def _read(self, key: str, ttl: int) -> tuple[bytes, float] | None:
        path = self._path(key)
        try:
            with path.open("rb") as file:
                expires_at = os.fstat(file.fileno()).st_mtime + ttl
                if time.time() >= expires_at:
                    path.unlink(missing_ok=True)
                    return None
                return file.read(), expires_at
        except FileNotFoundError:
            return None

    async def get(self, key: str, *, ttl: int | None = None) -> bytes | None:
        found = await self.get_with_expiry(key, ttl=ttl)
        return found[0] if found is not None else None

    async def get_with_expiry(
        self, key: str, *, ttl: int | None = None
    ) -> tuple[bytes, float] | None:
        return await asyncio.to_thread(self._read, key, self.ttl if ttl is None else ttl)

    def _write(self, key: str, data: bytes) -> float:
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".write-", dir=self.directory)
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(data)
            expires_at = Path(temporary).stat().st_mtime + self.ttl
            os.replace(temporary, self._path(key))
            return expires_at
        finally:
            Path(temporary).unlink(missing_ok=True)

    async def put(self, key: str, data: bytes) -> float:
        return await asyncio.to_thread(self._write, key, data)

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
