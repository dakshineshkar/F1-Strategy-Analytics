"""Redis serving store: the CLAUDE.md contract, sync (``RaceStore``) and ``redis.asyncio``
(``AsyncRaceStore``) versions (#21-#24).

Encoding of the driver hash (every value is a string; all 9 fields are always written):

=================  ==========================================================================
position           decimal int >= 1
gap_ahead_s        float ``repr`` (seconds, >= 0), ``""`` when unknown (e.g. the leader)
gap_leader_s       float ``repr``, ``""`` when unknown (``"0.0"`` for the leader)
tyre_compound      SOFT | MEDIUM | HARD | INTERMEDIATE | WET | UNKNOWN
tyre_age_laps      decimal int >= 0, ``""`` when unknown
last_lap_time_s    float ``repr``, ``""`` when unknown
undercut_flag      ``"1"`` or ``"0"``
undercut_prob      float ``repr`` in [0, 1], ``""`` when not scored
updated_at         ISO-8601 UTC with milliseconds, ``2024-05-05T20:14:03.125Z`` (set by the store)
=================  ==========================================================================

The additive, display-only tyre hash ``race:{s}:{r}:tyre:{driverId}`` (``keys.TYRE_FIELDS``; all 4
always written, ``""`` when unknown): ``tyre_life_laps`` (int >= 1), ``tyre_life_at_start_laps``
(int >= 0), ``lap`` (int >= 1, the lap the value belongs to) and ``updated_at``. It is queued in the
same pipeline as the driver hashes and follows the same TTL rules.

The additive, display-only timing hash ``race:{s}:{r}:timing:{driverId}`` (Feature 5;
``keys.TIMING_FIELDS``; all 11 always written, ``""`` when unknown): ``lap`` (int >= 1), the lap's
``sector1_s`` .. ``sector3_s`` and ``speed_trap_kph`` (float ``repr`` > 0), the driver's best so far
``pb_sector1_s`` .. ``pb_sector3_s`` / ``pb_speed_trap_kph`` and ``pit_stops`` (int >= 0), and
``updated_at``. Same pipeline, same TTL rules.

Events on ``race:{s}:{r}:events`` are JSON objects with ``type`` (``keys.EVENT_TYPES``),
``season``, ``round``, ``event_ts`` (the caller's event time, ISO-8601 UTC ms, or null),
``published_at`` (set by the store) and ``payload``.

TTL: every write of a race key also sets ``EXPIRE settings.redis_safety_ttl_s`` (so a session that
never sends ``session_end`` still expires). ``expire_race`` SCANs ``race:{s}:{r}:*`` (the sorted
set included) and sets ``EXPIRE settings.redis_ttl_after_session_s``. A write after
``session_end`` would refresh the safety TTL; the stream job stops writing a race after its
``session_end`` (S12). Channels are not keys and have no TTL.

Replay start (lifecycle rule, approved 2026-11-18): ``delete_race`` SCANs ``race:{s}:{r}:*`` and
DELs every match, so a new API replay of a race never shows the keys of an earlier (stopped,
failed or finished) run of it. The API calls it only while no replay of that race runs. It never
reaches another race's keys (the pattern's trailing colon) or ``meta:*``.

Every write of one micro-batch goes through one ``pipeline(transaction=False)`` and one
``execute()`` (``write_batch``). The Redis URL comes only from ``Settings.redis_url``.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import redis
import redis.asyncio as aioredis

from f1sa.config import Settings, get_settings
from f1sa.serving import keys as K

COMPOUNDS: tuple[str, ...] = ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN")
SCAN_COUNT = 500
DELETE_CHUNK = 500
NULL = ""


class StoreError(ValueError):
    """A value outside the serving contract (state, order or event)."""


Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_ms(ts: datetime) -> str:
    """ISO-8601 UTC with milliseconds and ``Z``; a naive datetime is refused."""
    if ts.tzinfo is None or ts.utcoffset() is None:
        raise StoreError(f"timestamp must be timezone-aware, got {ts!r}")
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


def _finite(name: str, value: float | None, lo: float, hi: float = math.inf) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise StoreError(f"{name} must be a number or None, got {value!r}")
    if not math.isfinite(value) or not lo <= value <= hi:
        raise StoreError(f"{name} must be finite and in [{lo}, {hi}], got {value!r}")


def _int(name: str, value: int | None, lo: int, *, nullable: bool) -> None:
    if value is None and nullable:
        return
    if isinstance(value, bool) or not isinstance(value, int) or value < lo:
        raise StoreError(f"{name} must be an int >= {lo}, got {value!r}")


@dataclass(frozen=True)
class DriverState:
    """One driver's live state (the 9 hash fields, ``updated_at`` excluded: the store sets it)."""

    position: int
    gap_ahead_s: float | None
    gap_leader_s: float | None
    tyre_compound: str
    tyre_age_laps: int | None
    last_lap_time_s: float | None
    undercut_flag: bool
    undercut_prob: float | None

    def __post_init__(self) -> None:
        _int("position", self.position, 1, nullable=False)
        _finite("gap_ahead_s", self.gap_ahead_s, 0.0)
        _finite("gap_leader_s", self.gap_leader_s, 0.0)
        _finite("last_lap_time_s", self.last_lap_time_s, 0.0)
        _finite("undercut_prob", self.undercut_prob, 0.0, 1.0)
        _int("tyre_age_laps", self.tyre_age_laps, 0, nullable=True)
        if self.tyre_compound not in COMPOUNDS:
            raise StoreError(
                f"tyre_compound must be one of {COMPOUNDS}, got {self.tyre_compound!r}"
            )
        if not isinstance(self.undercut_flag, bool):
            raise StoreError(f"undercut_flag must be a bool, got {self.undercut_flag!r}")


def _num(value: float | None) -> str:
    return NULL if value is None else repr(float(value))


def encode_state(state: DriverState, now: datetime) -> dict[str, str]:
    """The 9 hash fields as strings, in ``keys.DRIVER_FIELDS`` order."""
    out = {
        "position": str(state.position),
        "gap_ahead_s": _num(state.gap_ahead_s),
        "gap_leader_s": _num(state.gap_leader_s),
        "tyre_compound": state.tyre_compound,
        "tyre_age_laps": NULL if state.tyre_age_laps is None else str(state.tyre_age_laps),
        "last_lap_time_s": _num(state.last_lap_time_s),
        "undercut_flag": "1" if state.undercut_flag else "0",
        "undercut_prob": _num(state.undercut_prob),
        "updated_at": iso_ms(now),
    }
    assert tuple(out) == K.DRIVER_FIELDS
    return out


@dataclass(frozen=True)
class TyreLife:
    """The real tyre life of one driver at ``lap`` (display only; ``updated_at`` set by the
    store). ``None`` values mean unknown."""

    lap: int
    tyre_life_laps: int | None
    tyre_life_at_start_laps: int | None

    def __post_init__(self) -> None:
        _int("lap", self.lap, 1, nullable=False)
        _int("tyre_life_laps", self.tyre_life_laps, 1, nullable=True)
        _int("tyre_life_at_start_laps", self.tyre_life_at_start_laps, 0, nullable=True)


def _opt(value: int | None) -> str:
    return NULL if value is None else str(value)


def encode_tyre(tyre: TyreLife, now: datetime) -> dict[str, str]:
    """The 4 tyre-hash fields as strings, in ``keys.TYRE_FIELDS`` order."""
    out = {
        "tyre_life_laps": _opt(tyre.tyre_life_laps),
        "tyre_life_at_start_laps": _opt(tyre.tyre_life_at_start_laps),
        "lap": str(tyre.lap),
        "updated_at": iso_ms(now),
    }
    assert tuple(out) == K.TYRE_FIELDS
    return out


TIMING_VALUES: tuple[str, ...] = K.TIMING_FIELDS[1:9]
"""The 8 float fields of the timing hash (sectors, speed trap and their bests so far)."""


@dataclass(frozen=True)
class TimingRow:
    """The timing-tower values of one driver's lap ``lap`` (Feature 5, display only;
    ``updated_at`` set by the store). ``None`` means unknown."""

    lap: int
    sector1_s: float | None = None
    sector2_s: float | None = None
    sector3_s: float | None = None
    speed_trap_kph: float | None = None
    pb_sector1_s: float | None = None
    pb_sector2_s: float | None = None
    pb_sector3_s: float | None = None
    pb_speed_trap_kph: float | None = None
    pit_stops: int | None = None

    def __post_init__(self) -> None:
        _int("lap", self.lap, 1, nullable=False)
        for name in TIMING_VALUES:
            value = getattr(self, name)
            _finite(name, value, 0.0)
            if value is not None and value <= 0:
                raise StoreError(f"{name} must be > 0, got {value!r}")
        _int("pit_stops", self.pit_stops, 0, nullable=True)


def encode_timing(row: TimingRow, now: datetime) -> dict[str, str]:
    """The 11 timing-hash fields as strings, in ``keys.TIMING_FIELDS`` order."""
    out = {
        "lap": str(row.lap),
        **{name: _num(getattr(row, name)) for name in TIMING_VALUES},
        "pit_stops": _opt(row.pit_stops),
        "updated_at": iso_ms(now),
    }
    assert tuple(out) == K.TIMING_FIELDS
    return out


@dataclass(frozen=True)
class StoredTiming:
    timing: TimingRow
    updated_at: str


def decode_timing(raw: Mapping[Any, Any]) -> StoredTiming | None:
    """The inverse of ``encode_timing``; ``None`` for an empty hash. Raises ``StoreError`` (or
    ``ValueError``) on a hash outside the 11 fields."""
    if not raw:
        return None
    h = {_text(k): _text(v) for k, v in raw.items()}
    if set(h) != set(K.TIMING_FIELDS):
        raise StoreError(f"timing hash fields {sorted(h)} differ from {K.TIMING_FIELDS}")
    if h["lap"] == NULL:
        raise StoreError("timing hash lap is empty")
    row = TimingRow(
        lap=int(h["lap"]),
        **{name: None if h[name] == NULL else float(h[name]) for name in TIMING_VALUES},
        pit_stops=None if h["pit_stops"] == NULL else int(h["pit_stops"]),
    )
    return StoredTiming(timing=row, updated_at=h["updated_at"])


@dataclass(frozen=True)
class StoredTyreLife:
    tyre: TyreLife
    updated_at: str


def decode_tyre(raw: Mapping[Any, Any]) -> StoredTyreLife | None:
    """The inverse of ``encode_tyre``; ``None`` for an empty hash. Raises ``StoreError`` (or
    ``ValueError``) on a hash outside the 4 fields."""
    if not raw:
        return None
    h = {_text(k): _text(v) for k, v in raw.items()}
    if set(h) != set(K.TYRE_FIELDS):
        raise StoreError(f"tyre hash fields {sorted(h)} differ from {K.TYRE_FIELDS}")

    def i(name: str) -> int | None:
        return None if h[name] == NULL else int(h[name])

    lap = i("lap")
    if lap is None:
        raise StoreError("tyre hash lap is empty")
    tyre = TyreLife(
        lap=lap,
        tyre_life_laps=i("tyre_life_laps"),
        tyre_life_at_start_laps=i("tyre_life_at_start_laps"),
    )
    return StoredTyreLife(tyre=tyre, updated_at=h["updated_at"])


@dataclass(frozen=True)
class StoredDriverState:
    """A decoded hash: the state plus its ``updated_at`` string."""

    state: DriverState
    updated_at: str


def _text(v: str | bytes) -> str:
    return v.decode() if isinstance(v, bytes) else v


def decode_state(raw: Mapping[Any, Any]) -> StoredDriverState | None:
    """The inverse of ``encode_state``; ``None`` for an empty hash (missing or expired key)."""
    if not raw:
        return None
    h = {_text(k): _text(v) for k, v in raw.items()}
    if set(h) != set(K.DRIVER_FIELDS):
        raise StoreError(f"hash fields {sorted(h)} differ from the contract {K.DRIVER_FIELDS}")

    def f(name: str) -> float | None:
        return None if h[name] == NULL else float(h[name])

    def i(name: str) -> int | None:
        return None if h[name] == NULL else int(h[name])

    if h["undercut_flag"] not in ("0", "1"):
        raise StoreError(f"undercut_flag must be '0' or '1', got {h['undercut_flag']!r}")
    position = i("position")
    if position is None:
        raise StoreError("position is empty")
    state = DriverState(
        position=position,
        gap_ahead_s=f("gap_ahead_s"),
        gap_leader_s=f("gap_leader_s"),
        tyre_compound=h["tyre_compound"],
        tyre_age_laps=i("tyre_age_laps"),
        last_lap_time_s=f("last_lap_time_s"),
        undercut_flag=h["undercut_flag"] == "1",
        undercut_prob=f("undercut_prob"),
    )
    return StoredDriverState(state=state, updated_at=h["updated_at"])


def validate_order(order: Mapping[str, int]) -> dict[str, float]:
    """``{driverId: position}`` → ZADD mapping. Positions are unique ints >= 1. Drivers stay in
    the order for the whole session (a DNF keeps its classified position), so ZADD (upsert) is
    the complete update."""
    if not order:
        raise StoreError("order is empty")
    for driver_id, pos in order.items():
        K.validate_driver_id(driver_id)
        _int(f"position of {driver_id}", pos, 1, nullable=False)
    if len(set(order.values())) != len(order):
        raise StoreError(f"duplicate positions in order {dict(order)}")
    return {d: float(p) for d, p in order.items()}


@dataclass(frozen=True)
class Event:
    """One Pub/Sub message of a micro-batch."""

    type: str
    payload: Mapping[str, Any] = field(default_factory=dict)
    event_ts: datetime | None = None


def encode_event(
    season: int,
    round_: int,
    event: Event,
    now: datetime,
) -> str:
    if event.type not in K.EVENT_TYPES:
        raise StoreError(f"event type must be one of {K.EVENT_TYPES}, got {event.type!r}")
    body = {
        "type": event.type,
        "season": K.validate_season(season),
        "round": K.validate_round(round_),
        "event_ts": None if event.event_ts is None else iso_ms(event.event_ts),
        "published_at": iso_ms(now),
        "payload": dict(event.payload),
    }
    try:
        return json.dumps(body, allow_nan=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise StoreError(f"event payload is not finite JSON: {exc}") from exc


Commands = redis.client.Pipeline | aioredis.client.Pipeline
"""A sync or async pipeline: both queue commands synchronously; only ``execute`` differs."""


@dataclass(frozen=True)
class Batch:
    """One micro-batch: driver states, optional full order, events and (display only) tyre
    lives and timing-tower rows."""

    states: Mapping[str, DriverState] = field(default_factory=dict)
    order: Mapping[str, int] | None = None
    events: Sequence[Event] = ()
    tyres: Mapping[str, TyreLife] = field(default_factory=dict)
    timings: Mapping[str, TimingRow] = field(default_factory=dict)


class _Base:
    def __init__(self, settings: Settings | None = None, *, now: Clock = utc_now) -> None:
        self.settings = settings or get_settings()
        self.now = now

    # -- queueing (shared by both stores; nothing is sent until execute) --
    def upsert_driver_state(
        self, pipe: Commands, season: int, round_: int, driver_id: str, state: DriverState
    ) -> int:
        """HSET all 9 fields, then EXPIRE with the safety TTL. Returns the commands queued."""
        key = K.driver_key(season, round_, driver_id)
        fields: dict[Any, Any] = encode_state(state, self.now())  # redis-py's Mapping is invariant
        pipe.hset(key, mapping=fields)
        pipe.expire(key, self.settings.redis_safety_ttl_s)
        return 2

    def upsert_tyre(
        self, pipe: Commands, season: int, round_: int, driver_id: str, tyre: TyreLife
    ) -> int:
        """HSET the 4 tyre fields, then EXPIRE with the safety TTL (same pipeline as the batch)."""
        key = K.tyre_key(season, round_, driver_id)
        fields: dict[Any, Any] = encode_tyre(tyre, self.now())
        pipe.hset(key, mapping=fields)
        pipe.expire(key, self.settings.redis_safety_ttl_s)
        return 2

    def upsert_timing(
        self, pipe: Commands, season: int, round_: int, driver_id: str, row: TimingRow
    ) -> int:
        """HSET the 11 timing fields, then EXPIRE with the safety TTL (same pipeline)."""
        key = K.timing_key(season, round_, driver_id)
        fields: dict[Any, Any] = encode_timing(row, self.now())
        pipe.hset(key, mapping=fields)
        pipe.expire(key, self.settings.redis_safety_ttl_s)
        return 2

    def set_order(self, pipe: Commands, season: int, round_: int, order: Mapping[str, int]) -> int:
        """ZADD (member = driverId, score = position), then EXPIRE with the safety TTL."""
        key = K.order_key(season, round_)
        pipe.zadd(key, validate_order(order))
        pipe.expire(key, self.settings.redis_safety_ttl_s)
        return 2

    def publish_event(self, pipe: Commands, season: int, round_: int, event: Event) -> int:
        """PUBLISH the JSON event on ``race:{s}:{r}:events``."""
        pipe.publish(
            K.events_channel(season, round_), encode_event(season, round_, event, self.now())
        )
        return 1

    def _queue_batch(self, pipe: Commands, season: int, round_: int, batch: Batch) -> int:
        if not (batch.states or batch.order or batch.events or batch.tyres or batch.timings):
            raise StoreError("empty micro-batch")
        n = 0
        for driver_id, state in batch.states.items():
            n += self.upsert_driver_state(pipe, season, round_, driver_id, state)
        for driver_id, tyre in batch.tyres.items():
            n += self.upsert_tyre(pipe, season, round_, driver_id, tyre)
        for driver_id, row in batch.timings.items():
            n += self.upsert_timing(pipe, season, round_, driver_id, row)
        if batch.order is not None:
            n += self.set_order(pipe, season, round_, batch.order)
        for event in batch.events:
            n += self.publish_event(pipe, season, round_, event)
        return n

    def _expire_all(self, pipe: Commands, keys: Iterable[str]) -> int:
        n = 0
        for key in keys:
            pipe.expire(key, self.settings.redis_ttl_after_session_s)
            n += 1
        return n

    @staticmethod
    def _delete_all(pipe: Commands, keys: Sequence[str]) -> int:
        """Queue one DEL per ``DELETE_CHUNK`` keys; returns the number of commands queued."""
        n = 0
        for i in range(0, len(keys), DELETE_CHUNK):
            pipe.delete(*keys[i : i + DELETE_CHUNK])
            n += 1
        return n


def _decode_order(rows: Iterable[Any]) -> list[tuple[str, int]]:
    """ZRANGE WITHSCORES rows ``(member, score)`` → ``(driverId, position)``."""
    out: list[tuple[str, int]] = []
    for row in rows:
        member, score = row
        out.append((_text(member), int(score)))
    return out


class RaceStore(_Base):
    """Synchronous store (Structured Streaming ``foreachBatch`` sink, benchmarks)."""

    def __init__(
        self, client: redis.Redis, settings: Settings | None = None, *, now: Clock = utc_now
    ) -> None:
        super().__init__(settings, now=now)
        self.client = client

    @classmethod
    def from_settings(cls, settings: Settings | None = None, **kwargs: Any) -> RaceStore:
        s = settings or get_settings()
        return cls(redis.Redis.from_url(s.redis_url, decode_responses=True, **kwargs), s)

    def write_batch(self, season: int, round_: int, batch: Batch) -> int:
        """Every write of the micro-batch in one ``pipeline(transaction=False)``, one execute."""
        pipe = self.client.pipeline(transaction=False)
        n = self._queue_batch(pipe, season, round_, batch)
        pipe.execute()
        return n

    def race_keys(self, season: int, round_: int) -> list[str]:
        """Every key matching ``race:{s}:{r}:*`` (SCAN, never KEYS)."""
        found: set[str] = set()
        cursor = 0
        while True:
            cursor, batch = self.client.scan(
                cursor=cursor, match=K.race_pattern(season, round_), count=SCAN_COUNT
            )
            found.update(_text(k) for k in batch)
            if int(cursor) == 0:
                return sorted(found)

    def expire_race(self, season: int, round_: int) -> int:
        """EXPIRE ``redis_ttl_after_session_s`` on every race key (the sorted set included)."""
        keys = self.race_keys(season, round_)
        if keys:
            pipe = self.client.pipeline(transaction=False)
            self._expire_all(pipe, keys)
            pipe.execute()
        return len(keys)

    def delete_race(self, season: int, round_: int) -> int:
        """DEL every ``race:{s}:{r}:*`` key (replay start); returns the number deleted."""
        keys = self.race_keys(season, round_)
        if not keys:
            return 0
        pipe = self.client.pipeline(transaction=False)
        self._delete_all(pipe, keys)
        return sum(int(n) for n in pipe.execute())

    def end_session(self, season: int, round_: int, event_ts: datetime | None = None) -> int:
        """Publish ``session_end``, then ``expire_race``. Returns the number of keys expired."""
        self.write_batch(season, round_, Batch(events=(Event("session_end", {}, event_ts),)))
        return self.expire_race(season, round_)

    def get_driver_state(
        self, season: int, round_: int, driver_id: str
    ) -> StoredDriverState | None:
        return decode_state(self.client.hgetall(K.driver_key(season, round_, driver_id)))

    def get_tyre(self, season: int, round_: int, driver_id: str) -> StoredTyreLife | None:
        return decode_tyre(self.client.hgetall(K.tyre_key(season, round_, driver_id)))

    def get_timing(self, season: int, round_: int, driver_id: str) -> StoredTiming | None:
        return decode_timing(self.client.hgetall(K.timing_key(season, round_, driver_id)))

    def get_order(self, season: int, round_: int) -> list[tuple[str, int]]:
        """``[(driverId, position), ...]`` by position."""
        return _decode_order(
            self.client.zrange(K.order_key(season, round_), 0, -1, withscores=True)
        )


class AsyncRaceStore(_Base):
    """``redis.asyncio`` store (FastAPI, S13). Same commands and encoding as ``RaceStore``."""

    def __init__(
        self, client: aioredis.Redis, settings: Settings | None = None, *, now: Clock = utc_now
    ) -> None:
        super().__init__(settings, now=now)
        self.client = client

    @classmethod
    def from_settings(cls, settings: Settings | None = None, **kwargs: Any) -> AsyncRaceStore:
        s = settings or get_settings()
        return cls(aioredis.Redis.from_url(s.redis_url, decode_responses=True, **kwargs), s)

    async def write_batch(self, season: int, round_: int, batch: Batch) -> int:
        pipe = self.client.pipeline(transaction=False)
        n = self._queue_batch(pipe, season, round_, batch)
        await pipe.execute()
        return n

    async def race_keys(self, season: int, round_: int) -> list[str]:
        found: set[str] = set()
        cursor = 0
        while True:
            cursor, batch = await self.client.scan(
                cursor=cursor, match=K.race_pattern(season, round_), count=SCAN_COUNT
            )
            found.update(_text(k) for k in batch)
            if int(cursor) == 0:
                return sorted(found)

    async def expire_race(self, season: int, round_: int) -> int:
        keys = await self.race_keys(season, round_)
        if keys:
            pipe = self.client.pipeline(transaction=False)
            self._expire_all(pipe, keys)
            await pipe.execute()
        return len(keys)

    async def delete_race(self, season: int, round_: int) -> int:
        """DEL every ``race:{s}:{r}:*`` key (replay start); returns the number deleted."""
        keys = await self.race_keys(season, round_)
        if not keys:
            return 0
        pipe = self.client.pipeline(transaction=False)
        self._delete_all(pipe, keys)
        return sum(int(n) for n in await pipe.execute())

    async def end_session(self, season: int, round_: int, event_ts: datetime | None = None) -> int:
        await self.write_batch(season, round_, Batch(events=(Event("session_end", {}, event_ts),)))
        return await self.expire_race(season, round_)

    async def get_driver_state(
        self, season: int, round_: int, driver_id: str
    ) -> StoredDriverState | None:
        return decode_state(await self.client.hgetall(K.driver_key(season, round_, driver_id)))

    async def get_tyre(self, season: int, round_: int, driver_id: str) -> StoredTyreLife | None:
        return decode_tyre(await self.client.hgetall(K.tyre_key(season, round_, driver_id)))

    async def get_timing(self, season: int, round_: int, driver_id: str) -> StoredTiming | None:
        return decode_timing(await self.client.hgetall(K.timing_key(season, round_, driver_id)))

    async def get_order(self, season: int, round_: int) -> list[tuple[str, int]]:
        rows = await self.client.zrange(K.order_key(season, round_), 0, -1, withscores=True)
        return _decode_order(rows)
