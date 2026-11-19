"""The lap history of a race, recorded from its Redis channel for the what-if simulator (S15).

The Redis hash holds only each car's latest state, but the simulator needs the current lap and
each car's recent laps. ``LapLog`` keeps the last ``MAX_LAPS_PER_DRIVER`` laps of every car from
the ``lap`` / ``pit_in`` / ``pit_out`` messages of ``race:{s}:{r}:events`` (the same channel the
SSE stream forwards; no other data source). ``LapLogManager`` keeps one log per race, fed by:

* the SSE stream of a connected dashboard: ``attach()`` returns the log and the route passes its
  ``observe`` to the stream's ``on_sent`` hook, so no second subscription is opened;
* one Pub/Sub subscriber task per race, started without waiting by a replay start
  (``start_soon(fresh=True)`` drops an older log of the same race) and by the what-if route
  (``ensure()``, which waits until the subscription is active).

A message seen by both feeds is applied twice with the same result (laps are keyed by lap number).
A subscriber stops after ``session_end`` (the log is kept for later what-if requests), after
``idle_s`` without use, when more than ``max_races`` races are kept (least recently used first),
and on API shutdown.

Pub/Sub keeps no history: laps published before the subscriber started are not in the log. The
what-if then works with fewer laps or none (``history: none``) and says so.

Display-only additions for the engineer view (Feature 3; ``records()``, the what-if input, is
unchanged):

* ``lap_rows()``: the same laps plus the real tyre life of the lap payload (``tyre_life_laps``,
  ``tyre_life_at_start_laps``);
* ``probs_at(lap)``: the stream's published ``undercut_flag`` / ``undercut_prob`` of every driver,
  read (never written) from the driver hashes by the subscriber task when the leader's first lap
  event of that lap arrives (``read_published_probs``). Only laps seen by the subscriber have it.

Alert history (F09, additive, Step 3 of the UI redesign): the log also keeps the race's
``undercut_alert`` messages as SSE frames (``{**message, event_id, sse_sent_at_ms}``, the same id
``sse.event_id_for`` gives the live frame), deduplicated by ``event_id`` and capped at
``MAX_ALERTS``. ``LapLogManager.history`` serves the newest ``RECENT_ALERTS`` of them with the
connect snapshot, but only for a log started by an API replay (``run_id`` set by the replay route
with ``fresh=True``), so they are this run's alerts and nothing else. Before reading, it sends a
PING on the subscriber's own connection and waits for its PONG: Redis answers in order, so every
message published before the caller subscribed has then been recorded. The history is in memory:
an API restart loses it (and stops the API's replays with it).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import anyio
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from f1sa.api.sse import event_id_for
from f1sa.serving import keys as K
from f1sa.sim.whatif import LapRecord
from f1sa.streaming.redis_sink import now_ms

log = logging.getLogger(__name__)

MAX_LAPS_PER_DRIVER = 30
MAX_RACES = 4
IDLE_S = 1800.0
POLL_S = 1.0
SUBSCRIBE_TIMEOUT_S = 5.0
MAX_ALERTS = 1000
"""Alerts kept per run (a race has a few hundred at most; 141 for the sample 2024 R5)."""
RECENT_ALERTS = 50
"""Alerts sent with the connect snapshot (newest, oldest first)."""
BARRIER_TIMEOUT_S = 1.0
ALERT_REASONS = ("opportunity", "attempt")


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _float(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
        return None
    return float(v)


@dataclass(frozen=True)
class LapRow:
    """One recorded lap with its display-only tyre life (``LapLog.lap_rows``)."""

    driver_id: str
    lap: int
    race_time_s: float
    lap_time_s: float | None
    position: int | None
    compound: str | None
    tyre_age: int | None
    tyre_life_laps: int | None
    tyre_life_at_start_laps: int | None
    pit_in: bool
    pit_out: bool


Probs = dict[str, tuple[bool, float | None]]
"""driverId -> (undercut_flag, undercut_prob) as published in the driver hash."""


@dataclass
class LapLog:
    """The recorded laps of one race (pure; fed one parsed channel message at a time)."""

    season: int
    round: int
    max_laps: int = MAX_LAPS_PER_DRIVER
    ended: bool = False
    messages: int = 0
    skipped: int = 0
    _laps: dict[str, dict[int, dict[str, Any]]] = field(default_factory=dict, repr=False)
    _pit_in: dict[str, set[int]] = field(default_factory=dict, repr=False)
    _pit_out: dict[str, set[int]] = field(default_factory=dict, repr=False)
    _display: dict[str, dict[int, tuple[int | None, int | None]]] = field(
        default_factory=dict, repr=False
    )
    _probs: dict[int, Probs] = field(default_factory=dict, repr=False)
    _max_lap: int = 0
    _new_laps: list[int] = field(default_factory=list, repr=False)
    run_id: str | None = None
    """The API replay this log was started for (``fresh=True``); None for any other log."""
    max_alerts: int = MAX_ALERTS
    _alerts: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict, repr=False)

    def observe(self, msg: Mapping[str, Any], event_id: str | None = None) -> bool:
        """Apply one message (the stored JSON envelope, or an SSE frame that carries its
        ``event_id``); ``False`` if it was skipped. An ``undercut_alert`` needs ``event_id`` (the
        argument or the frame's) and is recorded once per id."""
        if msg.get("season") != self.season or msg.get("round") != self.round:
            self.skipped += 1
            return False
        kind = msg.get("type")
        if kind == "session_end":
            self.ended = True
            self.messages += 1
            return True
        if kind == "undercut_alert":
            return self._alert(msg, event_id)
        payload = msg.get("payload")
        if kind not in ("lap", "pit_in", "pit_out") or not isinstance(payload, Mapping):
            self.skipped += 1
            return False
        driver, lap = payload.get("driver_id"), _int(payload.get("lap"))
        try:
            driver = K.validate_driver_id(driver) if isinstance(driver, str) else None
        except K.InvalidKeyError:
            driver = None
        if driver is None or lap is None or lap < 1:
            self.skipped += 1
            return False
        self.messages += 1
        if kind == "pit_in":
            self._pit_in.setdefault(driver, set()).add(lap)
        elif kind == "pit_out":
            self._pit_out.setdefault(driver, set()).add(lap)
        else:
            t = _float(payload.get("race_time_s"))
            if t is None:
                self.skipped += 1
                return False
            compound = payload.get("compound")
            self._laps.setdefault(driver, {})[lap] = {
                "race_time_s": t,
                "lap_time_s": _float(payload.get("lap_time_s")),
                "position": _int(payload.get("position")),
                "compound": compound if isinstance(compound, str) else None,
                "tyre_age": _int(payload.get("tyre_age")),
            }
            self._display.setdefault(driver, {})[lap] = (
                _int(payload.get("tyre_life_laps")),
                _int(payload.get("tyre_life_at_start_laps")),
            )
            if lap > self._max_lap:
                self._max_lap = lap
                self._new_laps.append(lap)
        self._prune(driver)
        return True

    def _alert(self, msg: Mapping[str, Any], event_id: str | None) -> bool:
        eid = event_id if event_id is not None else msg.get("event_id")
        payload = msg.get("payload")
        if not isinstance(eid, str) or not eid or not _valid_alert(payload):
            self.skipped += 1
            return False
        self.messages += 1
        if eid in self._alerts:
            return True
        frame = dict(msg)
        frame["event_id"] = eid
        if _int(frame.get("sse_sent_at_ms")) is None:
            frame["sse_sent_at_ms"] = now_ms()
        self._alerts[eid] = frame
        while len(self._alerts) > self.max_alerts:
            self._alerts.popitem(last=False)
        return True

    def recent_alerts(self, n: int = RECENT_ALERTS) -> list[dict[str, Any]]:
        """The newest ``n`` alert frames recorded, oldest first (copies)."""
        if n <= 0:
            return []
        return [dict(f) for f in list(self._alerts.values())[-n:]]

    @property
    def alert_count(self) -> int:
        return len(self._alerts)

    def _prune(self, driver: str) -> None:
        laps = self._laps.get(driver, {})
        if len(laps) <= self.max_laps:
            return
        keep = sorted(laps)[-self.max_laps :]
        floor = keep[0]
        self._laps[driver] = {n: laps[n] for n in keep}
        shown = self._display.get(driver, {})
        self._display[driver] = {n: shown[n] for n in keep if n in shown}
        for flags in (self._pit_in, self._pit_out):
            if driver in flags:
                flags[driver] = {n for n in flags[driver] if n >= floor}

    def latest_lap(self, driver_id: str) -> int | None:
        laps = self._laps.get(driver_id)
        return max(laps) if laps else None

    @property
    def max_lap(self) -> int:
        """The highest lap of any lap event (the leader's lap); 0 before the first."""
        return self._max_lap

    def take_new_laps(self) -> list[int]:
        """Leader laps first seen since the last call (the subscriber snapshots their probs)."""
        out, self._new_laps = self._new_laps, []
        return out

    def set_probs(self, lap: int, probs: Probs) -> None:
        """Record the published probabilities for ``lap`` (the oldest beyond ``max_laps`` go)."""
        self._probs[lap] = dict(probs)
        for old in sorted(self._probs)[: -self.max_laps]:
            del self._probs[old]

    def probs_at(self, lap: int) -> Probs | None:
        """The probabilities published when the leader completed ``lap``; None if not recorded."""
        p = self._probs.get(lap)
        return None if p is None else dict(p)

    def lap_rows(self) -> list[LapRow]:
        """``records()`` plus the display-only tyre life (sorted by driver, lap)."""
        out: list[LapRow] = []
        for d in sorted(self._laps):
            pin, pout = self._pit_in.get(d, set()), self._pit_out.get(d, set())
            shown = self._display.get(d, {})
            for lap, v in sorted(self._laps[d].items()):
                life, life0 = shown.get(lap, (None, None))
                out.append(
                    LapRow(
                        driver_id=d,
                        lap=lap,
                        pit_in=lap in pin,
                        pit_out=lap in pout,
                        tyre_life_laps=life,
                        tyre_life_at_start_laps=life0,
                        **v,
                    )
                )
        return out

    def records(self) -> list[LapRecord]:
        """Every recorded lap, with the pit flags merged in (sorted by driver, lap)."""
        out: list[LapRecord] = []
        for d in sorted(self._laps):
            pin, pout = self._pit_in.get(d, set()), self._pit_out.get(d, set())
            for lap, v in sorted(self._laps[d].items()):
                out.append(
                    LapRecord(driver_id=d, lap=lap, pit_in=lap in pin, pit_out=lap in pout, **v)
                )
        return out


def _valid_alert(payload: Any) -> bool:
    """The fields the dashboard reads from an alert payload are present and well-formed."""
    if not isinstance(payload, Mapping) or payload.get("reason") not in ALERT_REASONS:
        return False
    if not isinstance(payload.get("trigger"), str):
        return False
    ids = []
    for key in ("attacker_id", "defender_id"):
        v = payload.get(key)
        try:
            ids.append(K.validate_driver_id(v) if isinstance(v, str) else None)
        except K.InvalidKeyError:
            return False
    lap = _int(payload.get("decision_lap"))
    return None not in ids and ids[0] != ids[1] and lap is not None and lap >= 1


def _text(v: Any) -> str | None:
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return v if isinstance(v, str) else None


def _pong_token(response: Any) -> str | None:
    """The token of a PING reply on a subscribed connection (RESP3: the bare token; RESP2:
    ``["pong", token]``), else None."""
    text = _text(response)
    if text is not None:
        return text
    if isinstance(response, list) and len(response) == 2 and _text(response[0]) == "pong":
        return _text(response[1])
    return None


def _flag(v: Any) -> bool:
    text = v.decode() if isinstance(v, bytes) else v
    return text == "1"


def _prob(v: Any) -> float | None:
    text = v.decode() if isinstance(v, bytes) else v
    if not isinstance(text, str) or text == "":
        return None
    try:
        p = float(text)
    except ValueError:
        return None
    return p if math.isfinite(p) and 0.0 <= p <= 1.0 else None


async def read_published_probs(client: aioredis.Redis, season: int, round_: int) -> Probs:
    """``undercut_flag`` / ``undercut_prob`` of every driver in the order zset (read only: ZRANGE
    plus one HMGET per driver in a pipeline). Unknown or malformed values read as unscored."""
    members = await client.zrange(K.order_key(season, round_), 0, -1)
    ids: list[str] = []
    for m in members:
        text = m.decode() if isinstance(m, bytes) else m
        try:
            ids.append(K.validate_driver_id(text))
        except K.InvalidKeyError:
            continue
    if not ids:
        return {}
    pipe = client.pipeline(transaction=False)
    for d in ids:
        pipe.hmget(K.driver_key(season, round_, d), "undercut_flag", "undercut_prob")
    values = await pipe.execute()
    return {d: (_flag(v[0]), _prob(v[1])) for d, v in zip(ids, values, strict=True)}


@dataclass
class _Entry:
    log: LapLog
    last_used: float
    task: asyncio.Task[None] | None = None
    subscribed: asyncio.Event = field(default_factory=asyncio.Event)
    pubsub: Any = None
    """The subscriber's Pub/Sub connection while it is subscribed (the history barrier pings it)."""
    pongs: dict[str, asyncio.Future[None]] = field(default_factory=dict)


class LapLogManager:
    """One log per race, fed by attached SSE streams and/or one subscriber task (see the module
    docstring). All methods run on the event loop thread."""

    def __init__(
        self,
        client: aioredis.Redis,
        *,
        max_races: int = MAX_RACES,
        idle_s: float = IDLE_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.max_races = max_races
        self.idle_s = idle_s
        self._clock = clock
        self._races: dict[tuple[int, int], _Entry] = {}
        self._cancelled: set[asyncio.Task[None]] = set()

    def get(self, season: int, round_: int) -> LapLog | None:
        entry = self._races.get((season, round_))
        return None if entry is None else entry.log

    def running(self) -> list[tuple[int, int]]:
        """Races whose subscriber task is running."""
        return sorted(k for k, v in self._races.items() if v.task is not None and not v.task.done())

    def attach(self, season: int, round_: int) -> LapLog:
        """The race's log, created if needed, without starting a subscriber (for the SSE feed)."""
        return self._entry(season, round_, fresh=False).log

    def start_soon(
        self, season: int, round_: int, *, fresh: bool = False, run_id: str | None = None
    ) -> LapLog:
        """The race's log with its subscriber task scheduled (not awaited). ``fresh`` drops an
        older log of the race first and tags the new one with ``run_id`` (an API replay start);
        an ended log is not restarted unless ``fresh``."""
        entry = self._entry(season, round_, fresh=fresh)
        if fresh:
            entry.log.run_id = run_id
        if (entry.task is None or entry.task.done()) and not entry.log.ended:
            entry.subscribed = asyncio.Event()
            entry.task = asyncio.create_task(
                self._run(entry, entry.subscribed), name=f"laplog-{season}-{round_}"
            )
        return entry.log

    async def ensure(
        self, season: int, round_: int, *, fresh: bool = False, run_id: str | None = None
    ) -> LapLog:
        """``start_soon``, then wait (at most ``SUBSCRIBE_TIMEOUT_S``) until it is subscribed."""
        log_ = self.start_soon(season, round_, fresh=fresh, run_id=run_id)
        entry = self._races[(season, round_)]
        if entry.task is not None and not entry.task.done():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(entry.subscribed.wait(), SUBSCRIBE_TIMEOUT_S)
        return log_

    def _entry(self, season: int, round_: int, *, fresh: bool) -> _Entry:
        key = (season, round_)
        now = self._clock()
        for k in [
            k for k, v in self._races.items() if k != key and now - v.last_used > self.idle_s
        ]:
            self._drop(k)
        if fresh and key in self._races:
            self._drop(key)
        entry = self._races.get(key)
        if entry is None:
            entry = self._races[key] = _Entry(LapLog(season, round_), now)
        entry.last_used = now
        while len(self._races) > self.max_races:
            self._drop(
                min((k for k in self._races if k != key), key=lambda k: self._races[k].last_used)
            )
        return entry

    async def history(
        self, season: int, round_: int, n: int = RECENT_ALERTS
    ) -> list[dict[str, Any]]:
        """The race's newest ``n`` alert frames of the current API replay run, oldest first; ``[]``
        when the log was not started by an API replay. While the subscriber runs, a PING/PONG on
        its connection first makes sure every message published before this call is recorded
        (at most ``BARRIER_TIMEOUT_S``; on a timeout or a Redis error the alerts recorded so far
        are returned)."""
        entry = self._races.get((season, round_))
        if entry is None or entry.log.run_id is None:
            return []
        entry.last_used = self._clock()
        await self._barrier(entry)
        return entry.log.recent_alerts(n)

    async def _barrier(self, entry: _Entry) -> None:
        if entry.task is None or entry.task.done() or entry.pubsub is None:
            return
        token = f"f1sa-history-{uuid.uuid4().hex}"
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        entry.pongs[token] = fut
        try:
            await entry.pubsub.ping(token)
            await asyncio.wait_for(asyncio.shield(fut), BARRIER_TIMEOUT_S)
        except (TimeoutError, RedisError, OSError) as exc:
            log.warning(
                "history barrier incomplete",
                extra={
                    "season": entry.log.season,
                    "round": entry.log.round,
                    "exc_class": type(exc).__name__,
                },
            )
        finally:
            entry.pongs.pop(token, None)

    def _drop(self, key: tuple[int, int]) -> None:
        entry = self._races.pop(key, None)
        if entry is not None and entry.task is not None and not entry.task.done():
            entry.task.cancel()
            self._cancelled.add(entry.task)
            entry.task.add_done_callback(self._cancelled.discard)

    async def _run(self, entry: _Entry, subscribed: asyncio.Event) -> None:
        log_ = entry.log
        channel = K.events_channel(log_.season, log_.round)
        pubsub: Any = self.client.pubsub(ignore_subscribe_messages=True)
        try:
            await pubsub.subscribe(channel)
            entry.pubsub = pubsub
            subscribed.set()
            while not log_.ended:
                # get_message, minus its PING handling: redis-py 8 on RESP3 with decoded responses
                # returns a subscribed PING's reply as a bare string, which handle_message drops;
                # RESP2 gives ["pong", token]. Both are recognised here as the barrier's token.
                response = await pubsub.parse_response(block=False, timeout=POLL_S)
                token = _pong_token(response)
                if token is not None:
                    self._pong(entry, token)
                    continue
                msg = (
                    None
                    if response is None
                    else await pubsub.handle_message(response, ignore_subscribe_messages=True)
                )
                if msg is None or msg.get("type") != "message":
                    await asyncio.sleep(0.05)
                    continue
                entry.last_used = self._clock()  # a race that still receives messages is in use
                data = msg.get("data")
                raw = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
                try:
                    parsed = json.loads(raw) if isinstance(raw, str) else None
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    log_.observe(parsed, event_id_for(raw, parsed))
                    for lap in log_.take_new_laps():
                        log_.set_probs(
                            lap, await read_published_probs(self.client, log_.season, log_.round)
                        )
                else:
                    log_.skipped += 1
        except (RedisError, OSError) as exc:
            log.warning(
                "lap log subscriber stopped",
                extra={"channel": channel, "exc_class": type(exc).__name__},
            )
        finally:
            entry.pubsub = None
            for fut in entry.pongs.values():
                if not fut.done():
                    fut.set_result(None)  # nothing more can arrive: the barrier is over
            subscribed.set()
            with anyio.CancelScope(shield=True):
                with contextlib.suppress(RedisError, OSError):
                    await pubsub.unsubscribe(channel)
                with contextlib.suppress(RedisError, OSError):
                    await pubsub.aclose()

    @staticmethod
    def _pong(entry: _Entry, token: str) -> None:
        fut = entry.pongs.get(token)
        if fut is not None and not fut.done():
            fut.set_result(None)

    async def aclose(self) -> None:
        """Stop every subscriber and wait for them (API shutdown)."""
        for key in list(self._races):
            self._drop(key)
        pending = list(self._cancelled)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
