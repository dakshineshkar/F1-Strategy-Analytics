"""Server-Sent Events from a race's Pub/Sub channel (``GET /api/races/{s}/{r}/events``).

Framing (one frame per Redis message, UTF-8)::

    event: <type>             lap | pit_in | pit_out | undercut_alert | session_end
    id: <event_id>
    data: <the stored JSON message + "event_id" + "sse_sent_at_ms">

* The stream subscribes first, then sends ``retry: 3000`` and a ``: connected`` comment, so
  nothing published after the client sees ``connected`` is missed.
* ``event_id`` is ``payload.event_id`` for ``lap``, ``pit_in`` and ``pit_out`` (the producer's
  uuid4). ``undercut_alert`` and ``session_end`` carry no id in the Step 12 payload, so they get
  a deterministic ``uuid5`` of the raw message: the same message always gets the same id.
* A ``: heartbeat`` comment is sent every ``heartbeat_s`` seconds (15 by default), whatever the
  traffic.
* Messages that are not JSON, have an unknown type or belong to another race are skipped and
  counted.
* After ``session_end`` the stream ends. Pub/Sub keeps no history, so ``Last-Event-ID`` cannot
  be honoured and is ignored; ``/state`` gives the current state after a reconnect.

Snapshots (pushed, never polled): the stream reads the race's full state from Redis (every
driver hash + the order set, one pipeline, ``api/state.py``) and sends it as::

    event: snapshot
    id: snapshot-<lap>
    data: {"type": "snapshot", "season", "round", "lap", "drivers", "order", "tyres",
           "event_id", "sse_sent_at_ms"}

* once right after connect (``snapshot-0``; the drivers are found with one SCAN);
* once per race lap: when a ``lap`` event arrives whose lap number is higher than the lap of the
  last snapshot, **before** that lap frame. The sink writes a batch's hashes and order set before
  its PUBLISH in one pipeline, so this snapshot already lists the event's car (and every car of
  that batch). A client therefore never receives an event for a car before a snapshot that lists
  it, unless Redis itself lacks the car; the dashboard's "unknown drivers" counter counts only
  those. (Fix D: with the frame first, a fresh race's first lap frame always followed an empty
  connect snapshot and was counted unknown.)
* Per-lap snapshots read the drivers already known (the previous snapshot and the events since),
  so they need no SCAN, except while the last snapshot found no driver (a race that had not
  started at connect): then they SCAN again, so the first lap's snapshot holds every hash.

Alert history (F09, additive): the **connect** snapshot (``snapshot-0``) also carries
``recent_alerts``, the race's newest alerts of the current API replay run (at most 50, oldest
first), each in the exact shape and with the exact ``event_id`` of its live ``undercut_alert``
frame. They come from the API's own recorder (``api/lap_log.py``: the Pub/Sub subscriber the
replay start runs), read after this stream subscribed and after the Redis state; an alert in both
the history and the live stream has the same id, so the client keeps it once. It is ``[]`` when the
race has no state in Redis (a cleared or expired race) or no API replay recorded it. Per-lap
snapshots do not carry the key; every other snapshot field is unchanged.

The alert stream only says when a pair *becomes* a candidate, so these snapshots are what clears a
stale ``undercut_flag`` in the browser. A snapshot that cannot be read (Redis error, a hash that
breaks the contract) is skipped and logged; the event stream goes on.

Clean-up: Starlette does not close the body iterator when the client goes away. So
``SSEResponse`` closes the subscription itself, in a ``finally`` shielded from cancellation. That
covers ASGI spec < 2.4 (disconnect cancels the stream), >= 2.4 (``send`` raises ``OSError``) and
the normal end after ``session_end``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

import anyio
import redis.asyncio as aioredis
from redis.exceptions import RedisError
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from f1sa.api.state import (
    StateContractError,
    driver_ids_from_keys,
    read_race_state,
    scan_race_keys,
)
from f1sa.serving import keys as K
from f1sa.streaming.redis_sink import now_ms

log = logging.getLogger(__name__)

PREAMBLE = b"retry: 3000\n: connected\n\n"
HEARTBEAT = b": heartbeat\n\n"
IDLE_BACKOFF_S = 0.02
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
SNAPSHOT = "snapshot"
SSE_EVENTS: tuple[str, ...] = (*K.EVENT_TYPES, SNAPSHOT)
"""Event names on the SSE stream: the Pub/Sub types plus the API's own ``snapshot``."""
ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "f1sa:race-events")
"""Namespace of the derived ids of messages without ``payload.event_id``."""
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

OnSent = Callable[[str, Mapping[str, Any]], None]
History = Callable[[], Awaitable[list[dict[str, Any]]]]
"""The race's recent alert frames for the connect snapshot (``LapLogManager.history``)."""
RECENT_ALERTS_KEY = "recent_alerts"


def event_id_for(raw: str, message: Mapping[str, Any]) -> str:
    """``payload.event_id`` when it is a canonical uuid, else ``uuid5(ID_NAMESPACE, raw)``."""
    payload = message.get("payload")
    if isinstance(payload, Mapping):
        eid = payload.get("event_id")
        if isinstance(eid, str) and _UUID.fullmatch(eid):
            return eid
    return str(uuid.uuid5(ID_NAMESPACE, raw))


def format_event(name: str, event_id: str, data: Mapping[str, Any]) -> bytes:
    """One SSE frame; ``json.dumps`` never emits a newline, so ``data`` is a single line."""
    if name not in SSE_EVENTS or "\n" in event_id or "\r" in event_id:
        raise ValueError(f"invalid SSE event {name!r} / id {event_id!r}")
    body = json.dumps(data, allow_nan=False, separators=(",", ":"), sort_keys=True)
    return f"event: {name}\nid: {event_id}\ndata: {body}\n\n".encode()


class EventStream:
    """One client's subscription to ``race:{s}:{r}:events``."""

    def __init__(
        self,
        client: aioredis.Redis,
        season: int,
        round_: int,
        *,
        heartbeat_s: float,
        on_sent: OnSent | None = None,
        clock_ms: Callable[[], int] = now_ms,
        history: History | None = None,
    ) -> None:
        if not heartbeat_s > 0:
            raise ValueError(f"heartbeat_s must be > 0, got {heartbeat_s}")
        self.client = client
        self.season = K.validate_season(season)
        self.round = K.validate_round(round_)
        self.channel = K.events_channel(season, round_)
        self.heartbeat_s = heartbeat_s
        self.on_sent = on_sent
        self.clock_ms = clock_ms
        self.history = history
        self.pubsub: Any = None
        self.closed = False
        self.sent = 0
        self.skipped = 0
        self.heartbeats = 0
        self.snapshots = 0
        self.snapshot_errors = 0
        self.snapshot_lap: int | None = None
        """Lap of the last snapshot (0 = the connect snapshot); a higher lap event triggers one."""
        self.known_drivers: set[str] = set()
        self._last_snapshot_empty = True
        """The last snapshot (or none yet) found no driver hash: the next one SCANs again."""

    async def snapshot(self, lap: int) -> bytes | None:
        """The ``snapshot`` frame of the race's current Redis state, or ``None`` when it cannot be
        read. The first one, and any after a snapshot that found no driver (a race that had not
        started), find the drivers with one SCAN; later ones read the known drivers."""
        try:
            if self.snapshot_lap is None or self._last_snapshot_empty:
                keys = await scan_race_keys(self.client, self.season, self.round)
                self.known_drivers |= set(driver_ids_from_keys(keys, self.season, self.round))
            state = await read_race_state(
                self.client, self.season, self.round, sorted(self.known_drivers)
            )
        except (StateContractError, RedisError, OSError) as exc:
            self.snapshot_errors += 1
            log.warning(
                "snapshot skipped",
                extra={"channel": self.channel, "lap": lap, "exc_class": type(exc).__name__},
            )
            return None
        finally:
            self.snapshot_lap = lap
        self.known_drivers |= set(state.drivers) | {o.driver_id for o in state.order}
        self._last_snapshot_empty = not state.drivers
        extra: dict[str, Any] = {}
        if lap == 0 and self.history is not None:
            extra[RECENT_ALERTS_KEY] = await self._recent_alerts(bool(state.drivers))
        event_id = f"snapshot-{lap}"
        data = {
            "type": SNAPSHOT,
            "lap": lap,
            **state.model_dump(),
            **extra,
            "event_id": event_id,
            "sse_sent_at_ms": self.clock_ms(),
        }
        self.snapshots += 1
        return format_event(SNAPSHOT, event_id, data)

    async def _recent_alerts(self, has_state: bool) -> list[dict[str, Any]]:
        """The connect snapshot's alert history: ``[]`` without race state (never an old run's
        alerts beside a cleared race) or when it cannot be read."""
        if not has_state or self.history is None:
            return []
        try:
            frames = await self.history()
        except (RedisError, OSError) as exc:
            log.warning(
                "alert history skipped",
                extra={"channel": self.channel, "exc_class": type(exc).__name__},
            )
            return []
        return [
            f
            for f in frames
            if f.get("type") == "undercut_alert"
            and f.get("season") == self.season
            and f.get("round") == self.round
        ]

    def _note(self, msg: Mapping[str, Any]) -> int | None:
        """Remember the event's driver; the lap number of a ``lap`` event that needs a snapshot."""
        payload = msg.get("payload")
        if not isinstance(payload, Mapping):
            return None
        driver = payload.get("driver_id")
        if isinstance(driver, str) and K.DRIVER_ID_RE.fullmatch(driver):
            self.known_drivers.add(driver)
        lap = payload.get("lap")
        if msg.get("type") != "lap" or isinstance(lap, bool) or not isinstance(lap, int):
            return None
        if self.snapshot_lap is not None and lap <= self.snapshot_lap:
            return None
        return lap

    def parse(self, data: str | bytes) -> tuple[dict[str, Any], str] | None:
        """``(message, event_id)`` of one Pub/Sub message body of this race, or ``None`` if it is
        skipped (counted)."""
        raw = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
        try:
            msg = json.loads(raw)
        except ValueError:
            msg = None
        if (
            not isinstance(msg, dict)
            or msg.get("type") not in K.EVENT_TYPES
            or msg.get("season") != self.season
            or msg.get("round") != self.round
        ):
            self.skipped += 1
            log.warning("skipped message", extra={"channel": self.channel, "skipped": self.skipped})
            return None
        return msg, event_id_for(raw, msg)

    def frame(self, msg: Mapping[str, Any], eid: str) -> bytes | None:
        """The SSE frame of a parsed message, stamped with ``sse_sent_at_ms`` right before it is
        sent, or ``None`` if it cannot be framed (counted)."""
        out = {**msg, "event_id": eid, "sse_sent_at_ms": self.clock_ms()}
        try:
            frame = format_event(str(msg["type"]), eid, out)
        except ValueError:
            self.skipped += 1
            log.warning("skipped message", extra={"channel": self.channel, "skipped": self.skipped})
            return None
        if self.on_sent is not None:
            self.on_sent(eid, out)
        return frame

    async def frames(self) -> AsyncIterator[bytes]:
        """Subscribe, then yield the preamble, event frames and heartbeats until ``session_end``."""
        self.pubsub = self.client.pubsub(ignore_subscribe_messages=True)
        try:
            await self.pubsub.subscribe(self.channel)
            yield PREAMBLE
            first = await self.snapshot(0)
            if first is not None:
                yield first
            loop = asyncio.get_running_loop()
            next_beat = loop.time() + self.heartbeat_s
            while True:
                remaining = next_beat - loop.time()
                if remaining <= 0:
                    self.heartbeats += 1
                    yield HEARTBEAT
                    next_beat += self.heartbeat_s
                    continue
                msg = await self.pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=remaining
                )
                if msg is None or msg.get("type") != "message":
                    # get_message returns early for subscribe confirmations (and some clients
                    # do not block at all): back off briefly instead of spinning.
                    await asyncio.sleep(min(IDLE_BACKOFF_S, max(next_beat - loop.time(), 0.0)))
                    continue
                parsed = self.parse(msg["data"])
                if parsed is None:
                    continue
                body, eid = parsed
                # A lap of a new race lap: its snapshot goes first (see the module docstring).
                lap = self._note(body)
                if lap is not None:
                    snap = await self.snapshot(lap)
                    if snap is not None:
                        yield snap
                framed = self.frame(body, eid)
                if framed is None:
                    continue
                self.sent += 1
                yield framed
                if body["type"] == "session_end":
                    return
        finally:
            await self.close()

    async def close(self) -> None:
        """Unsubscribe and release the connection; idempotent, shielded from cancellation."""
        if self.closed:
            return
        self.closed = True
        pubsub, self.pubsub = self.pubsub, None
        if pubsub is None:
            return
        with anyio.CancelScope(shield=True):
            try:
                await pubsub.unsubscribe(self.channel)
            except (RedisError, OSError) as exc:
                log.warning("unsubscribe failed", extra={"exc_class": type(exc).__name__})
            try:
                await pubsub.aclose()
            except (RedisError, OSError) as exc:
                log.warning("pubsub close failed", extra={"exc_class": type(exc).__name__})
        log.info(
            "event stream closed",
            extra={
                "channel": self.channel,
                "sent": self.sent,
                "skipped": self.skipped,
                "heartbeats": self.heartbeats,
                "snapshots": self.snapshots,
            },
        )


class SSEResponse(StreamingResponse):
    """A ``text/event-stream`` response that always closes its ``EventStream``."""

    media_type = "text/event-stream"

    def __init__(self, stream: EventStream, status_code: int = 200) -> None:
        super().__init__(
            stream.frames(), status_code, headers=SSE_HEADERS, media_type=self.media_type
        )
        self.stream = stream

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.stream.close()
