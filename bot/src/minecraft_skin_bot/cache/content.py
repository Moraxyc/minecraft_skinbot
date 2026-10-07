import asyncio
import hashlib
import os
import tempfile
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from minecraft_skin_bot.cache.memory import AsyncTTLCache
from minecraft_skin_bot.errors import UtilityError


class CacheBudget:
    """A shared byte budget for one process's atomic cache writes."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.lock = threading.Lock()
        self._directories: dict[Path, tuple[int, bool]] = {}

    def register(self, directory: Path, ttl: int, protected: bool) -> None:
        self._directories[directory] = (ttl, protected)

    def prepare(self, size: int) -> None:
        entries: list[tuple[float, Path, int, bool]] = []
        now = time.time()
        for directory, (ttl, protected) in self._directories.items():
            if not directory.exists():
                continue
            for path in directory.iterdir():
                if not path.is_file():
                    continue
                if path.name.startswith(".write-"):
                    path.unlink(missing_ok=True)
                    continue
                if len(path.name) != 64 or any(c not in "0123456789abcdef" for c in path.name):
                    continue
                try:
                    info = path.stat()
                    if now - info.st_mtime >= ttl:
                        path.unlink(missing_ok=True)
                    else:
                        entries.append((info.st_mtime, path, info.st_size, protected))
                except FileNotFoundError:
                    continue
        total = sum(entry[2] for entry in entries)
        # Include the temporary file until replace; an existing committed upload stays intact.
        for _, path, existing_size, protected in sorted(entries):
            if total + size <= self.max_bytes:
                return
            if not protected:
                path.unlink(missing_ok=True)
                total -= existing_size
        if total + size > self.max_bytes:
            raise UtilityError(
                "Cache full",
                "Try again after temporary uploads expire or increase the cache budget.",
                status=503,
            )


class FileCache:
    """Disposable, atomically written files addressed by hashed content keys."""

    def __init__(self, directory: Path, ttl: int = 604800) -> None:
        self.directory = directory
        self.ttl = ttl
        self._flights: AsyncTTLCache[str, bytes] = AsyncTTLCache(ttl=0)
        self._lock = threading.Lock()
        self._budget: CacheBudget | None = None

    def attach_budget(self, budget: CacheBudget, *, protected: bool = False) -> None:
        self._budget = budget
        self._lock = budget.lock
        budget.register(self.directory, self.ttl, protected)

    def _path(self, key: str) -> Path:
        return self.directory / hashlib.sha256(key.encode()).hexdigest()

    def _read(self, key: str, ttl: int) -> tuple[bytes, float] | None:
        with self._lock:
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
        with self._lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            target = self._path(key)
            try:
                if target.stat().st_size == len(data) and target.read_bytes() == data:
                    os.utime(target, None)
                    return target.stat().st_mtime + self.ttl
            except FileNotFoundError:
                pass
            if self._budget is not None:
                self._budget.prepare(len(data))
            fd, temporary = tempfile.mkstemp(prefix=".write-", dir=self.directory)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data)
                expires_at = Path(temporary).stat().st_mtime + self.ttl
                os.replace(temporary, target)
                return expires_at
            finally:
                Path(temporary).unlink(missing_ok=True)

    async def put(self, key: str, data: bytes) -> float:
        return await asyncio.to_thread(self._write, key, data)

    async def delete(self, key: str) -> None:
        def remove() -> None:
            with self._lock:
                self._path(key).unlink(missing_ok=True)

        await asyncio.to_thread(remove)

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
        with self._lock:
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
