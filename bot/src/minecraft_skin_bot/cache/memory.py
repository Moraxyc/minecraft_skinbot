import asyncio
import time
from collections.abc import Awaitable, Callable


class AsyncTTLCache[K, V]:
    """Bounded content memoization with one in-flight computation per key."""

    def __init__(self, ttl: float = 60, max_entries: int = 512) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._values: dict[K, tuple[float, V]] = {}
        self._tasks: dict[K, asyncio.Task[V]] = {}

    async def get_or_create(self, key: K, factory: Callable[[], Awaitable[V]]) -> V:
        found = self._values.get(key)
        if found is not None and found[0] > time.monotonic():
            return found[1]
        task = self._tasks.get(key)
        if task is None:
            task = asyncio.create_task(self._produce(key, factory))
            self._tasks[key] = task
            task.add_done_callback(self._observe_exception)
        return await asyncio.shield(task)

    @staticmethod
    def _observe_exception(task: asyncio.Task[V]) -> None:
        if not task.cancelled():
            task.exception()

    async def _produce(self, key: K, factory: Callable[[], Awaitable[V]]) -> V:
        try:
            result = await factory()
            now = time.monotonic()
            expired = [item for item, value in self._values.items() if value[0] <= now]
            for item in expired:
                self._values.pop(item, None)
            while len(self._values) >= self.max_entries:
                self._values.pop(next(iter(self._values)))
            self._values[key] = (now + self.ttl, result)
            return result
        finally:
            self._tasks.pop(key, None)

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
