"""Writes one micro-batch of one race to Redis via ``serving.redis_store`` (#21-#24, S12 caller).

Per micro-batch and race, ``RedisSink.write`` queues every write in **one** ``Batch`` and calls
``RaceStore.write_batch`` once (one ``pipeline(transaction=False)``, one ``execute()``):

* the driver hash of every car seen so far (all 9 fields): live position, the timing-line gaps of
  its latest lap, compound (``UNKNOWN`` when null), tyre age, last lap time, ``undercut_flag``
  (1 when the car is a rule-eligible attacker at its latest evaluated decision lap) and
  ``undercut_prob`` (its calibrated P, ``""`` otherwise);
* the full order sorted set (unique live positions);
* (additive, display only) the tyre hash ``race:{s}:{r}:tyre:{driverId}`` of every car with a
  ``lap`` event in this batch that is its latest received lap: the event's real tyre life (null
  values written too, so a stint with unknown life clears the previous one). Nothing
  model-related reads it;
* (additive, display only; Feature 5) the timing hash ``race:{s}:{r}:timing:{driverId}`` of the
  same cars, from the same lap event: its sector times, speed trap, the driver's best so far and
  its stop count (``events.TOWER_FIELDS``; computed causally by the producer, so the sink keeps no
  state). Nothing model-related reads it;
* one ``lap`` / ``pit_in`` / ``pit_out`` event per event received, and the ``undercut_alert``
  messages chosen by the alert policy (``streaming.alerts``; payload ``events.UndercutAlert``).

Every published payload carries ``produced_at_ms`` (the producer's clock), ``batch_received_at_ms``
(when ``foreachBatch`` started) and ``redis_written_at_ms``. A PUBLISH inside the pipeline cannot
carry the time the pipeline finished, so ``redis_written_at_ms`` is the client time just before the
batch is queued and sent. Redis runs one connection's pipeline in order, so a subscriber receives
the event only after the batch's HSET/ZADD were applied. The measured ``write_batch`` duration is
returned for ``results/stream_batches.jsonl``.

A gap that the store contract refuses (negative or not finite, which inconsistent timing can give)
is written as ``""``; the features keep the raw value.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from f1sa.serving.redis_store import COMPOUNDS, Batch, DriverState, Event, TimingRow, TyreLife
from f1sa.streaming.events import TOWER_FIELDS, RaceEvent, UndercutAlert
from f1sa.streaming.live_state import RaceState

PUBLISHED_TYPES = ("lap", "pit_in", "pit_out")


class Store(Protocol):
    def write_batch(self, season: int, round_: int, batch: Batch) -> int: ...

    def end_session(self, season: int, round_: int, event_ts: datetime | None = None) -> int: ...


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def ms_to_datetime(ms: int | None) -> datetime | None:
    return None if ms is None else datetime.fromtimestamp(ms / 1000, tz=UTC)


def contract_gap(value: float | None) -> float | None:
    """``value`` if the store contract accepts it as a gap (finite, >= 0), else None."""
    if value is None or not math.isfinite(value) or value < 0:
        return None
    return value


def driver_states(state: RaceState) -> dict[str, DriverState]:
    """The hash of every car that has completed a lap."""
    timing = state.timing()
    order = state.live_order()
    out: dict[str, DriverState] = {}
    for driver, row in sorted(state.latest_laps().items()):
        t = timing[(driver, row.lap)]
        flag = state.flags.get(driver)
        eligible = bool(flag and flag[1])
        out[driver] = DriverState(
            position=order[driver],
            gap_ahead_s=contract_gap(t.gap_ahead_s),
            gap_leader_s=contract_gap(t.gap_leader_s),
            tyre_compound=row.compound if row.compound in COMPOUNDS else "UNKNOWN",
            tyre_age_laps=row.tyre_age,
            last_lap_time_s=row.lap_time_s,
            undercut_flag=eligible,
            undercut_prob=flag[2] if flag is not None and eligible else None,
        )
    return out


def event_payload(ev: RaceEvent, received_ms: int, written_ms: int) -> dict[str, Any]:
    out: dict[str, Any] = {
        "event_id": ev.event_id,
        "driver_id": ev.driver_id,
        "lap": ev.lap,
        "race_time_s": ev.race_time_s,
        "produced_at_ms": ev.produced_at_ms,
        "batch_received_at_ms": received_ms,
        "redis_written_at_ms": written_ms,
    }
    if ev.type == "lap":
        out.update(
            position=ev.position,
            lap_time_s=ev.lap_time_s,
            compound=ev.compound,
            tyre_age=ev.tyre_age,
            tyre_life_laps=ev.tyre_life_laps,
            tyre_life_at_start_laps=ev.tyre_life_at_start_laps,
            **{name: getattr(ev, name) for name in TOWER_FIELDS},
        )
    return out


def alert_payload(
    a: UndercutAlert, trigger: RaceEvent | None, received_ms: int, written_ms: int
) -> dict[str, Any]:
    """``UndercutAlert.to_dict()`` plus the timing fields (``events.alert_spark_schema``)."""
    return {
        **a.to_dict(),
        "trigger_event_id": trigger.event_id if trigger else None,
        "produced_at_ms": trigger.produced_at_ms if trigger else None,
        "batch_received_at_ms": received_ms,
        "redis_written_at_ms": written_ms,
    }


@dataclass(frozen=True)
class WriteRecord:
    season: int
    round: int
    n_states: int
    n_events: int
    n_alerts: int
    n_tyres: int
    redis_written_at_ms: int
    write_ms: float
    session_end: bool

    def to_json(self) -> dict[str, Any]:
        return dict(vars(self))


def tyre_lives(state: RaceState, events: Sequence[RaceEvent]) -> dict[str, TyreLife]:
    """The tyre hash of every driver whose latest received lap has a ``lap`` event in ``events``
    (an older or duplicated lap event never overwrites a newer value)."""
    latest = state.latest_laps()
    out: dict[str, TyreLife] = {}
    for e in events:
        if e.type != "lap" or e.driver_id is None or e.lap is None:
            continue
        row = latest.get(e.driver_id)
        if row is None or row.lap != e.lap:
            continue
        out[e.driver_id] = TyreLife(
            lap=e.lap,
            tyre_life_laps=e.tyre_life_laps,
            tyre_life_at_start_laps=e.tyre_life_at_start_laps,
        )
    return out


def _latest_lap_events(state: RaceState, events: Sequence[RaceEvent]) -> dict[str, RaceEvent]:
    """The ``lap`` event in ``events`` of every driver whose latest received lap it is."""
    latest = state.latest_laps()
    out: dict[str, RaceEvent] = {}
    for e in events:
        if e.type != "lap" or e.driver_id is None or e.lap is None:
            continue
        row = latest.get(e.driver_id)
        if row is None or row.lap != e.lap:
            continue
        out[e.driver_id] = e
    return out


def timing_rows(state: RaceState, events: Sequence[RaceEvent]) -> dict[str, TimingRow]:
    """The timing hash (Feature 5, display only) of every driver whose latest received lap has a
    ``lap`` event in ``events``: that event's tower values, null values included (an older or
    duplicated lap event never overwrites a newer value)."""
    return {
        d: TimingRow(lap=e.lap, **{name: getattr(e, name) for name in TOWER_FIELDS})
        for d, e in _latest_lap_events(state, events).items()
        if e.lap is not None
    }


class RedisSink:
    def __init__(self, store: Store, *, clock_ms: Callable[[], int] = now_ms) -> None:
        self.store = store
        self.clock_ms = clock_ms

    def write(
        self,
        state: RaceState,
        events: Sequence[RaceEvent],
        alerts: Sequence[UndercutAlert],
        received_ms: int,
        *,
        session_end: bool = False,
    ) -> WriteRecord | None:
        """One ``write_batch`` with everything of this micro-batch for ``state``'s race, then
        (on ``session_end``) ``end_session``. Nothing is written for an ended race."""
        if state.ended:
            raise RuntimeError(f"race {state.season} R{state.round} has ended; refusing to write")
        states = driver_states(state)
        tyres: dict[str, TyreLife] = {}
        timings: dict[str, TimingRow] = {}
        published = [e for e in events if e.type in PUBLISHED_TYPES]
        stamped = [e for e in events if e.produced_at_ms is not None]
        trigger = max(stamped, key=lambda e: e.produced_at_ms or 0) if stamped else None
        write_ms = 0.0
        written = self.clock_ms()
        if states or published or alerts:
            tyres = tyre_lives(state, events)
            timings = timing_rows(state, events)
            batch = Batch(
                states=states,
                order=state.live_order() if states else None,
                tyres=tyres,
                timings=timings,
                events=(
                    *(
                        Event(
                            e.type,
                            event_payload(e, received_ms, written),
                            ms_to_datetime(e.produced_at_ms),
                        )
                        for e in published
                    ),
                    *(
                        Event(
                            "undercut_alert",
                            alert_payload(a, trigger, received_ms, written),
                            ms_to_datetime(trigger.produced_at_ms if trigger else None),
                        )
                        for a in alerts
                    ),
                ),
            )
            t0 = time.perf_counter()
            self.store.write_batch(state.season, state.round, batch)
            write_ms = (time.perf_counter() - t0) * 1000.0
        elif not session_end:
            return None
        if session_end:
            self.store.end_session(
                state.season,
                state.round,
                ms_to_datetime(trigger.produced_at_ms if trigger else None),
            )
            state.ended = True
        return WriteRecord(
            season=state.season,
            round=state.round,
            n_states=len(states),
            n_events=len(published),
            n_alerts=len(alerts),
            n_tyres=len(tyres),
            redis_written_at_ms=written,
            write_ms=round(write_ms, 3),
            session_end=session_end,
        )
