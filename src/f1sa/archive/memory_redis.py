"""An in-process stand-in for the few Redis commands the race store and the API state reader use.

The archive builder hands it to the **real** ``serving.redis_store.RaceStore`` (as its client), so
every hash field, sorted-set score and published message is produced by the frozen encoder
(``encode_state`` / ``encode_tyre`` / ``encode_event``) exactly as a live replay sends it to Redis.
The snapshot after each micro-batch is then read back with the API's own
``api.state.read_race_state`` through ``async_view()``.

Supported, with Redis semantics (``decode_responses=True``: everything is ``str``):

* ``pipeline(transaction=False)`` that queues commands and applies them in order on ``execute()``;
* ``hset(key, mapping=...)`` (merge), ``expire`` (0 on a missing key, TTL recorded, never
  enforced), ``zadd`` (score update), ``publish`` (recorded in ``published``);
* ``hgetall``, ``zrange(key, start, end, withscores=)`` (score, then member order), ``scan``
  (glob ``match``; one page), ``exists``.

Anything else raises ``AttributeError``, so an unsupported command can never pass silently. It
is used only by the archive builder and tests; nothing in the live path imports it.
"""

from __future__ import annotations

import fnmatch
from collections.abc import Callable, Mapping
from typing import Any


class MemoryRedis:
    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.zsets: dict[str, dict[str, float]] = {}
        self.ttls: dict[str, int] = {}
        self.published: list[tuple[str, str]] = []
        """Every PUBLISH in order: (channel, message)."""

    # ------------------------------------------------------------------ writes
    def hset(self, key: str, mapping: Mapping[str, Any]) -> int:
        if key in self.zsets:
            raise TypeError(f"WRONGTYPE {key} holds a sorted set")
        if not mapping:
            raise ValueError("hset needs at least one field")
        h = self.hashes.setdefault(key, {})
        added = sum(1 for f in mapping if f not in h)
        h.update({str(f): str(v) for f, v in mapping.items()})
        return added

    def expire(self, key: str, seconds: int) -> bool:
        if key not in self.hashes and key not in self.zsets:
            return False
        self.ttls[key] = int(seconds)
        return True

    def zadd(self, key: str, mapping: Mapping[str, float]) -> int:
        if key in self.hashes:
            raise TypeError(f"WRONGTYPE {key} holds a hash")
        z = self.zsets.setdefault(key, {})
        added = sum(1 for m in mapping if m not in z)
        z.update({str(m): float(s) for m, s in mapping.items()})
        return added

    def publish(self, channel: str, message: str) -> int:
        self.published.append((str(channel), str(message)))
        return 0

    # ------------------------------------------------------------------ reads
    def keys_list(self) -> list[str]:
        return sorted({*self.hashes, *self.zsets})

    def exists(self, *keys: str) -> int:
        return sum(1 for k in keys if k in self.hashes or k in self.zsets)

    def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    def zrange(self, key: str, start: int, end: int, withscores: bool = False) -> list[Any]:
        items = sorted(self.zsets.get(key, {}).items(), key=lambda kv: (kv[1], kv[0]))
        n = len(items)
        lo = start + n if start < 0 else start
        hi = end + n if end < 0 else end
        chosen = items[max(lo, 0) : hi + 1] if n else []
        return [(m, s) for m, s in chosen] if withscores else [m for m, _ in chosen]

    def scan(
        self, cursor: int = 0, match: str | None = None, count: int | None = None
    ) -> tuple[int, list[str]]:
        """One page holding every matching key (cursor 0 = complete)."""
        keys = self.keys_list()
        if match is not None:
            keys = [k for k in keys if fnmatch.fnmatchcase(k, match)]
        return 0, keys

    # ------------------------------------------------------------------ pipelines
    def pipeline(self, transaction: bool = False) -> MemoryPipeline:
        if transaction:
            raise ValueError("only pipeline(transaction=False) is supported")
        return MemoryPipeline(self)

    def async_view(self) -> AsyncMemoryRedis:
        """The same data behind the ``redis.asyncio`` call shapes ``api.state`` uses."""
        return AsyncMemoryRedis(self)


class MemoryPipeline:
    """Queues commands; ``execute()`` applies them in order and returns their results."""

    _COMMANDS = frozenset({"hset", "expire", "zadd", "publish", "hgetall", "zrange", "exists"})

    def __init__(self, owner: MemoryRedis) -> None:
        self._owner = owner
        self._queue: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Callable[..., MemoryPipeline]:
        if name not in self._COMMANDS:
            raise AttributeError(f"MemoryPipeline does not support {name!r}")

        def queue(*args: Any, **kwargs: Any) -> MemoryPipeline:
            self._queue.append((name, args, kwargs))
            return self

        return queue

    def execute(self) -> list[Any]:
        out = [getattr(self._owner, n)(*a, **kw) for n, a, kw in self._queue]
        self._queue = []
        return out


class AsyncMemoryPipeline:
    def __init__(self, owner: MemoryRedis) -> None:
        self._inner = MemoryPipeline(owner)

    def __getattr__(self, name: str) -> Callable[..., Any]:
        queue = getattr(self._inner, name)

        def queued(*args: Any, **kwargs: Any) -> AsyncMemoryPipeline:
            queue(*args, **kwargs)
            return self

        return queued

    async def execute(self) -> list[Any]:
        return self._inner.execute()


class AsyncMemoryRedis:
    def __init__(self, owner: MemoryRedis) -> None:
        self._owner = owner

    def pipeline(self, transaction: bool = False) -> AsyncMemoryPipeline:
        if transaction:
            raise ValueError("only pipeline(transaction=False) is supported")
        return AsyncMemoryPipeline(self._owner)

    async def scan(
        self, cursor: int = 0, match: str | None = None, count: int | None = None
    ) -> tuple[int, list[str]]:
        return self._owner.scan(cursor, match, count)
