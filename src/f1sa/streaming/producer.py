"""Kafka race replay (#19): one race from the clean zone, in race order, at a speed factor.

``python -m f1sa.streaming.producer --season 2024 --round 5 --speed 10``

* Reads only the race's ``season=S/round=R`` partitions of the clean tables under
  ``Settings.data_lake_uri`` (``file://`` for the sample, ``hdfs://`` inside the app container).
* Tyre age comes from ``etl.df_jobs.tyre_age`` over the v1 clean ``stints`` and the race distance
  from ``df_jobs.race_distance``, the same definitions the batch features use; the per-lap track
  flags are the batch's ``track_neutral`` (SC / VSC / red flag / neutralised) and
  ``track_red_flag``. These three context values are replayed on each lap event (see
  ``streaming/events.py``).
* The tyre compound is display context only (no rule, feature or model input reads it). Per lap,
  ``resolve_compound`` takes the real compound of the additive ``clean/stints_tracinginsights``
  stint in progress (the driver's latest stint with ``start_lap <= lap``; ``end_lap`` is never
  read, the convention of ``sim.whatif.stint_starts``), then the v1 stint's compound, else null
  (``UNKNOWN`` in Redis). A race whose v1 stints are synthetic (sample mode) keeps them.
* The real tyre life (``tyre_life_laps``, ``tyre_life_at_start_laps``; display only) comes from the
  same TracingInsights stint in progress: ``tyre_age_at_start + lap - start_lap + 1`` (FastF1
  TyreLife, which counts laps of earlier use), null when the stint's starting life is unknown
  (never assumed new) or the race is synthetic. ``tyre_age`` is never changed by it.
* Timing-tower values (Feature 5; display only): the lap's sector times and speed trap come from
  the additive ``clean/analysis_laps`` (TracingInsights, null without it, e.g. the sample); the
  driver's best so far and its stop count come from ``running_timing`` over **its own laps and stops
  up to this lap only** (no later lap is read, so a lap's values never depend on the future).
  Deleted laps count: a deletion is decided after the lap.
* Events, ordered by race time: ``pit_in`` (in-lap L) just before ``lap`` L at the line crossing,
  ``pit_out`` (lap L+1) at the crossing plus the stop time (never after the next crossing), then
  one ``session_end`` per topic partition.
* Pacing: an event at race time t is sent at wall time ``start + (t - t_first) / speed``.
* Kafka: ``acks=all``, idempotent, key = ``driver_id``; any delivery error fails the run.
* Season 2025 (the sealed test season) is refused before anything is read unless
  ``--allow-test-season`` is given.

Exit codes: 0 ok, 1 delivery failure, 2 refused or bad arguments, 3 race data missing or invalid.
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
import time
import zlib
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from f1sa.config import get_settings
from f1sa.sim.whatif import STINT_START_COLUMNS, StintStart, stint_starts
from f1sa.streaming.events import (
    COMPOUNDS,
    SESSION_END_KEY,
    RaceEvent,
    new_event_id,
)
from f1sa.streaming.live_features import spark_round
from f1sa.streaming.processor import SEALED_SEASON
from f1sa.streaming.redis_sink import now_ms

log = logging.getLogger(__name__)

CLEAN_TABLES = ("laps", "pitstops", "stints", "results")
TI_STINTS_TABLE = "stints_tracinginsights"
"""The optional, additive source of the lap events' compound (never of ``tyre_age``)."""
COMPOUND_SOURCES: tuple[str, ...] = ("tracinginsights", "v1_stints", "none")
ANALYSIS_LAPS_TABLE = "analysis_laps"
"""The optional, additive source of the lap events' sector times and speed trap (display only)."""
ANALYSIS_LAP_COLUMNS = ("driver_id", "lap", "sector1_s", "sector2_s", "sector3_s", "speed_st_kph")
_KIND_ORDER = {"pit_in": 0, "lap": 1, "pit_out": 2}


class ProducerError(RuntimeError):
    """Race data that cannot be replayed (exit 3)."""


class RefusedError(RuntimeError):
    """A replay the producer refuses to run (exit 2)."""


# ============================================================================== race inputs
@dataclass(frozen=True)
class LapRecord:
    driver_id: str
    lap: int
    position: int | None
    lap_time_s: float | None
    compound: str | None
    tyre_age: int | None
    track_neutral: bool
    track_red_flag: bool
    compound_source: str = "none"
    """Where ``compound`` came from: one of ``COMPOUND_SOURCES``."""
    tyre_life_laps: int | None = None
    """Real tyre life at the end of the lap (TracingInsights; display only), or None."""
    tyre_life_at_start_laps: int | None = None
    """Laps already on the set when its stint began (> 0: a used set), or None."""
    sector1_s: float | None = None
    sector2_s: float | None = None
    sector3_s: float | None = None
    """The lap's TracingInsights sector times (display only), or None."""
    speed_trap_kph: float | None = None
    """The lap's speed-trap speed (TracingInsights ``SpeedST``; display only), or None."""


@dataclass(frozen=True)
class StopRecord:
    driver_id: str
    lap: int
    duration_s: float | None


@dataclass(frozen=True)
class RaceInputs:
    season: int
    round: int
    laps: tuple[LapRecord, ...]
    stops: tuple[StopRecord, ...]
    race_laps: int | None


def check_season(season: int, allow_test_season: bool) -> None:
    if season == SEALED_SEASON and not allow_test_season:
        raise RefusedError(
            f"season {season} is the sealed test season; pass --allow-test-season to replay it"
        )


def normalise_compound(value: Any) -> str | None:
    """A compound name as the dashboard and the Redis contract spell it (``SOFT``, ``MEDIUM``,
    ``HARD``, ``INTERMEDIATE``, ``WET``; case and surrounding spaces ignored), or None for
    anything else (``UNKNOWN``, ``TEST_UNKNOWN``, empty, null)."""
    if value is None:
        return None
    text = str(value).strip().upper()
    return text if text in COMPOUNDS else None


def ti_compound_at(stints: Sequence[StintStart], driver_id: str, lap: int) -> str | None:
    """The compound of ``driver_id``'s TracingInsights stint in progress at the end of ``lap``:
    the stint with the largest ``start_lap <= lap``. Stints that start later are ignored and a
    stint's end is never used, so an in-lap keeps the old compound and the out-lap gets the new
    one. None if no stint has started or the stint has no (or a conflicting) compound."""
    started = [s for s in stints if s.driver_id == driver_id and s.start_lap <= lap]
    if not started:
        return None
    return normalise_compound(max(started, key=lambda s: s.start_lap).compound)


def ti_tyre_life_at(
    stints: Sequence[StintStart] | None, driver_id: str, lap: int
) -> tuple[int | None, int | None]:
    """``(tyre_life_laps, tyre_life_at_start_laps)`` of ``driver_id`` at the end of ``lap`` from
    the TracingInsights stint in progress (the largest ``start_lap <= lap``; later stints and the
    stint's end are never used): life = laps on the set before the stint + laps into it. So the
    in-lap still counts the old set and the out-lap starts the new one (1 for a new set, n + 1
    for a set with n laps of earlier use). ``(None, None)`` without a TI source, without a started
    stint, or when the stint's starting life is unknown (never assumed new)."""
    if stints is None:
        return None, None
    started = [s for s in stints if s.driver_id == driver_id and s.start_lap <= lap]
    if not started:
        return None, None
    s = max(started, key=lambda s: s.start_lap)
    if s.tyre_age_at_start is None or s.tyre_age_at_start < 0:
        return None, None
    return s.tyre_age_at_start + lap - s.start_lap + 1, s.tyre_age_at_start


def resolve_compound(
    ti_stints: Sequence[StintStart] | None, driver_id: str, lap: int, v1_compound: Any
) -> tuple[str | None, str]:
    """``(compound, source)`` of one lap event: the TracingInsights stint in progress, then the
    v1 stint's compound, else ``(None, "none")``. ``ti_stints`` None means no TI source."""
    if ti_stints is not None:
        ti = ti_compound_at(ti_stints, driver_id, lap)
        if ti is not None:
            return ti, "tracinginsights"
    v1 = normalise_compound(v1_compound)
    return (v1, "v1_stints") if v1 is not None else (None, "none")


def timing_value(value: Any) -> float | None:
    """A sector time or speed as the event schema accepts it: a finite number > 0, else None."""
    if value is None or isinstance(value, bool) or not isinstance(value, int | float):
        return None
    v = float(value)
    return v if math.isfinite(v) and v > 0 else None


@dataclass(frozen=True)
class LapTiming:
    """The Feature 5 tower values of one lap event (``events.TOWER_FIELDS``)."""

    sector1_s: float | None
    sector2_s: float | None
    sector3_s: float | None
    speed_trap_kph: float | None
    pb_sector1_s: float | None
    pb_sector2_s: float | None
    pb_sector3_s: float | None
    pb_speed_trap_kph: float | None
    pit_stops: int


def running_timing(
    laps: Sequence[LapRecord], stops: Sequence[StopRecord]
) -> dict[tuple[str, int], LapTiming]:
    """Per (driver, lap): the lap's sectors and speed trap, the driver's best so far (minimum
    sector, maximum speed trap over its laps <= lap) and its stops with in-lap <= lap. Only the
    driver's own earlier laps and the lap itself are read, so cutting the race after lap N leaves
    every value of laps <= N unchanged."""
    by_driver: dict[str, list[LapRecord]] = defaultdict(list)
    for r in laps:
        by_driver[r.driver_id].append(r)
    stop_laps: dict[str, list[int]] = defaultdict(list)
    for st in stops:
        stop_laps[st.driver_id].append(st.lap)
    out: dict[tuple[str, int], LapTiming] = {}
    for d, rows in by_driver.items():
        in_laps = sorted(stop_laps.get(d, []))
        best: list[float | None] = [None, None, None]
        best_trap: float | None = None
        for r in sorted(rows, key=lambda x: x.lap):
            sectors = (r.sector1_s, r.sector2_s, r.sector3_s)
            for i, v in enumerate(sectors):
                cur = best[i]
                if v is not None and (cur is None or v < cur):
                    best[i] = v
            if r.speed_trap_kph is not None and (best_trap is None or r.speed_trap_kph > best_trap):
                best_trap = r.speed_trap_kph
            out[(d, r.lap)] = LapTiming(
                sector1_s=sectors[0],
                sector2_s=sectors[1],
                sector3_s=sectors[2],
                speed_trap_kph=r.speed_trap_kph,
                pb_sector1_s=best[0],
                pb_sector2_s=best[1],
                pb_sector3_s=best[2],
                pb_speed_trap_kph=best_trap,
                pit_stops=bisect_right(in_laps, r.lap),
            )
    return out


def timing_coverage(laps: Sequence[LapRecord]) -> dict[str, int]:
    """Lap records with each tower value known (for the producer's summary line)."""
    return {
        "sectors": sum(1 for r in laps if None not in (r.sector1_s, r.sector2_s, r.sector3_s)),
        "speed_trap": sum(1 for r in laps if r.speed_trap_kph is not None),
    }


def compound_coverage(laps: Sequence[LapRecord]) -> dict[str, int]:
    """Number of lap records per compound source (every ``COMPOUND_SOURCES`` key present)."""
    out = dict.fromkeys(COMPOUND_SOURCES, 0)
    for r in laps:
        out[r.compound_source] += 1
    return out


def race_inputs(frames: Mapping[str, Any], season: int, round_: int) -> RaceInputs:
    """Collect one race from clean-zone DataFrames (``laps``, ``pitstops``, ``stints``,
    ``results``, and optionally ``stints_tracinginsights`` for the compound and ``analysis_laps``
    for the sector times and speed trap; other races are filtered out). Spark is imported here
    only."""
    from pyspark.sql import functions as F

    from f1sa.etl.df_jobs import race_distance, tyre_age

    def race(df: Any) -> Any:
        return df.where((F.col("season") == season) & (F.col("round") == round_))

    laps, stints = race(frames["laps"]), race(frames["stints"])
    ti_stints: tuple[StintStart, ...] | None = None
    if frames.get(TI_STINTS_TABLE) is not None:
        if stints.where(F.coalesce(F.col("is_synthetic"), F.lit(False))).limit(1).count():
            log.info("%s R%s: synthetic v1 stints; %s ignored", season, round_, TI_STINTS_TABLE)
        else:
            ti_rows = race(frames[TI_STINTS_TABLE]).select(*STINT_START_COLUMNS).collect()
            ti_stints = stint_starts(r.asDict() for r in ti_rows)
    sector_rows: dict[tuple[str, int], tuple[float | None, ...]] = {}
    if frames.get(ANALYSIS_LAPS_TABLE) is not None:
        for a in race(frames[ANALYSIS_LAPS_TABLE]).select(*ANALYSIS_LAP_COLUMNS).collect():
            if a["driver_id"] is None or a["lap"] is None:
                continue
            key = (a["driver_id"], int(a["lap"]))
            if key in sector_rows:
                raise ProducerError(f"{season} R{round_}: duplicate analysis_laps row {key}")
            sector_rows[key] = tuple(
                timing_value(a[c]) for c in ("sector1_s", "sector2_s", "sector3_s", "speed_st_kph")
            )
    results, stops = race(frames["results"]), race(frames["pitstops"])
    neutral = F.lit(False)
    for c in ("is_neutralised_lap", "is_sc_lap", "is_vsc_lap", "is_red_flag_lap"):
        neutral = neutral | F.coalesce(F.col(c), F.lit(False))
    rows = (
        tyre_age(laps, stints)
        .select(
            "driver_id",
            "lap",
            "position",
            "lap_time_s",
            "compound",
            "tyre_age_laps",
            neutral.alias("track_neutral"),
            F.coalesce(F.col("is_red_flag_lap"), F.lit(False)).alias("track_red_flag"),
        )
        .collect()
    )
    if not rows:
        raise ProducerError(f"{season} R{round_}: no laps in the clean zone")

    def record(r: Any) -> LapRecord:
        compound, source = resolve_compound(ti_stints, r["driver_id"], int(r["lap"]), r["compound"])
        life, at_start = ti_tyre_life_at(ti_stints, r["driver_id"], int(r["lap"]))
        s1, s2, s3, trap = sector_rows.get((r["driver_id"], int(r["lap"])), (None,) * 4)
        return LapRecord(
            driver_id=r["driver_id"],
            lap=int(r["lap"]),
            position=r["position"],
            lap_time_s=r["lap_time_s"],
            compound=compound,
            tyre_age=r["tyre_age_laps"],
            track_neutral=bool(r["track_neutral"]),
            track_red_flag=bool(r["track_red_flag"]),
            compound_source=source,
            tyre_life_laps=life,
            tyre_life_at_start_laps=at_start,
            sector1_s=s1,
            sector2_s=s2,
            sector3_s=s3,
            speed_trap_kph=trap,
        )

    lap_records = tuple(record(r) for r in rows)
    keys = [(r.driver_id, r.lap) for r in lap_records]
    if len(keys) != len(set(keys)):
        raise ProducerError(
            f"{season} R{round_}: duplicate (driver, lap) rows (overlapping stints?)"
        )
    distance = race_distance(results, laps).collect()
    grouped: dict[tuple[str, int], list[float | None]] = defaultdict(list)
    for s in stops.select("driver_id", "lap", "duration_s").collect():
        if s["lap"] is not None:
            grouped[(s["driver_id"], int(s["lap"]))].append(s["duration_s"])
    stop_records = tuple(
        StopRecord(
            d,
            lap,
            spark_round(sum(x for x in ds if x is not None), 3)
            if all(x is not None for x in ds)
            else None,
        )
        for (d, lap), ds in sorted(grouped.items())
    )
    return RaceInputs(
        season=season,
        round=round_,
        laps=tuple(sorted(lap_records, key=lambda r: (r.lap, r.driver_id))),
        stops=stop_records,
        race_laps=int(distance[0]["race_laps"]) if distance and distance[0]["race_laps"] else None,
    )


def load_race_inputs(spark: Any, lake_uri: str, season: int, round_: int) -> RaceInputs:
    """``race_inputs`` from the race's clean partitions under ``lake_uri`` (read only). The
    ``stints_tracinginsights`` table is optional: without it (the sample lake) the compound comes
    from the v1 stints. ``analysis_laps`` (Feature 2) is optional too: without it the sector
    times and speed traps are null (display only)."""
    from f1sa.etl.clean import spark_uri
    from f1sa.lake import schemas as S
    from f1sa.lake import schemas_analysis as SA
    from f1sa.lake.schemas_tracinginsights import CLEAN_SCHEMAS_TI
    from f1sa.streaming.priors import PriorsError, read_race_partition

    clean = f"{spark_uri(lake_uri)}/clean"
    try:
        frames: dict[str, Any] = {
            t: read_race_partition(spark, clean, t, S.CLEAN_SCHEMAS[t], season, round_)
            for t in CLEAN_TABLES
        }
    except PriorsError as exc:
        raise ProducerError(str(exc)) from exc
    try:
        frames[TI_STINTS_TABLE] = read_race_partition(
            spark, clean, TI_STINTS_TABLE, CLEAN_SCHEMAS_TI[TI_STINTS_TABLE], season, round_
        )
    except PriorsError as exc:
        log.warning("%s; lap compounds come from the v1 stints only", exc)
    try:
        frames[ANALYSIS_LAPS_TABLE] = read_race_partition(
            spark, clean, ANALYSIS_LAPS_TABLE, SA.SCHEMAS[ANALYSIS_LAPS_TABLE], season, round_
        )
    except PriorsError as exc:
        log.warning("%s; no sector times or speed traps on the lap events", exc)
    return race_inputs(frames, season, round_)


# ============================================================================== events
@dataclass(frozen=True)
class Outgoing:
    """An event and its explicit partition (``session_end`` only; else Kafka's key partitioner)."""

    event: RaceEvent
    partition: int | None = None

    @property
    def key(self) -> str:
        return self.event.driver_id or SESSION_END_KEY


def _race_times(laps: Sequence[LapRecord]) -> dict[tuple[str, int], float]:
    """Line-crossing race time of every lap: the cumulative time (``timing_gaps`` rounding), or,
    after an unknown lap time, max(the car's previous time, the leader's time at that lap)."""
    by_driver: dict[str, list[LapRecord]] = defaultdict(list)
    for r in laps:
        by_driver[r.driver_id].append(r)
    cum: dict[tuple[str, int], float | None] = {}
    for d, rows in by_driver.items():
        total: float | None = None
        unknown = False
        for r in sorted(rows, key=lambda r: r.lap):
            if r.lap_time_s is None:
                unknown = True
            else:
                total = r.lap_time_s if total is None else total + r.lap_time_s
            cum[(d, r.lap)] = None if unknown or total is None else spark_round(total, 3)
    leader: dict[int, float] = {}
    for r in laps:
        c = cum[(r.driver_id, r.lap)]
        if c is not None and (r.lap not in leader or c < leader[r.lap]):
            leader[r.lap] = c
    out: dict[tuple[str, int], float] = {}
    for d, rows in by_driver.items():
        prev = 0.0
        for r in sorted(rows, key=lambda r: r.lap):
            c = cum[(d, r.lap)]
            t = c if c is not None else max(prev, leader.get(r.lap, prev))
            out[(d, r.lap)] = t
            prev = t
    return out


def build_events(inputs: RaceInputs, n_partitions: int) -> list[Outgoing]:
    """Every event of the race in send order (``produced_at_ms`` unset)."""
    if n_partitions < 1:
        raise ValueError(f"n_partitions must be >= 1, got {n_partitions}")
    times = _race_times(inputs.laps)
    tower = running_timing(inputs.laps, inputs.stops)
    s, r = inputs.season, inputs.round
    keyed: list[tuple[float, int, str, int, RaceEvent]] = []
    for lap in inputs.laps:
        t = times[(lap.driver_id, lap.lap)]
        tw = tower[(lap.driver_id, lap.lap)]
        ev = RaceEvent(
            event_id=new_event_id(),
            type="lap",
            season=s,
            round=r,
            race_time_s=t,
            driver_id=lap.driver_id,
            lap=lap.lap,
            lap_time_s=lap.lap_time_s,
            position=lap.position,
            compound=lap.compound,
            tyre_age=lap.tyre_age,
            track_neutral=lap.track_neutral,
            track_red_flag=lap.track_red_flag,
            race_laps=inputs.race_laps,
            tyre_life_laps=lap.tyre_life_laps,
            tyre_life_at_start_laps=lap.tyre_life_at_start_laps,
            sector1_s=tw.sector1_s,
            sector2_s=tw.sector2_s,
            sector3_s=tw.sector3_s,
            speed_trap_kph=tw.speed_trap_kph,
            pb_sector1_s=tw.pb_sector1_s,
            pb_sector2_s=tw.pb_sector2_s,
            pb_sector3_s=tw.pb_sector3_s,
            pb_speed_trap_kph=tw.pb_speed_trap_kph,
            pit_stops=tw.pit_stops,
        )
        keyed.append((t, _KIND_ORDER["lap"], lap.driver_id, lap.lap, ev))
    last_time: dict[str, float] = {}
    for (d, _n), t in times.items():
        last_time[d] = max(last_time.get(d, 0.0), t)
    for stop in inputs.stops:
        t_in = times.get((stop.driver_id, stop.lap))
        if t_in is None:  # a stop on a lap the car never completed (retired in the pits)
            t_in = last_time.get(stop.driver_id, 0.0)
        t_out = t_in + (stop.duration_s or 0.0)
        nxt = times.get((stop.driver_id, stop.lap + 1))
        if nxt is not None:
            t_out = min(t_out, nxt)
        for kind, lap_no, t in (("pit_in", stop.lap, t_in), ("pit_out", stop.lap + 1, t_out)):
            ev = RaceEvent(
                event_id=new_event_id(),
                type=kind,
                season=s,
                round=r,
                race_time_s=t,
                driver_id=stop.driver_id,
                lap=lap_no,
            )
            keyed.append((t, _KIND_ORDER[kind], stop.driver_id, lap_no, ev))
    keyed.sort(key=lambda k: k[:4])
    out = [Outgoing(k[4]) for k in keyed]
    end_t = (keyed[-1][0] if keyed else 0.0) + 1.0
    last_lap = max((lap.lap for lap in inputs.laps), default=None)
    for p in range(n_partitions):
        ev = RaceEvent(
            event_id=new_event_id(),
            type="session_end",
            season=s,
            round=r,
            race_time_s=end_t,
            lap=last_lap,
        )
        out.append(Outgoing(ev, partition=p))
    return out


def sim_partition(key: str, n_partitions: int) -> int:
    """A stable stand-in for Kafka's key partitioner (tests and the parity replay only)."""
    return zlib.crc32(key.encode()) % n_partitions


# ============================================================================== sending
Send = Callable[[Outgoing], None]


def replay(
    events: Sequence[Outgoing],
    send: Send,
    speed: float,
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    wall_ms: Callable[[], int] = now_ms,
) -> int:
    """Send ``events`` paced at ``speed`` race-seconds per wall-second; returns the count sent.
    Each event is stamped with ``produced_at_ms`` immediately before it is handed to ``send``."""
    if not (speed > 0 and speed < float("inf")):
        raise ValueError(f"speed must be a positive number, got {speed}")
    if not events:
        return 0
    t0, base = clock(), events[0].event.race_time_s
    for out in events:
        target = t0 + (out.event.race_time_s - base) / speed
        delay = target - clock()
        if delay > 0:
            sleep(delay)
        send(Outgoing(out.event.stamped(wall_ms()), out.partition))
    return len(events)


class KafkaProducerLike(Protocol):
    def produce(self, topic: str, **kwargs: Any) -> None: ...

    def poll(self, timeout: float) -> int: ...

    def flush(self, timeout: float) -> int: ...


def producer_config(bootstrap: str) -> dict[str, Any]:
    return {
        "bootstrap.servers": bootstrap,
        "acks": "all",
        "enable.idempotence": True,
        "linger.ms": 5,
        "client.id": "f1sa-race-replay",
    }


def topic_partitions(bootstrap: str, topic: str, timeout_s: float = 10.0) -> int:
    """Number of partitions of ``topic`` (raises if it does not exist)."""
    from confluent_kafka.admin import AdminClient

    meta = AdminClient({"bootstrap.servers": bootstrap}).list_topics(topic, timeout=timeout_s)
    t = meta.topics.get(topic)
    if t is None or t.error is not None or not t.partitions:
        raise ProducerError(f"topic {topic!r} not available on {bootstrap}: {t and t.error}")
    return len(t.partitions)


class KafkaSender:
    """Sends ``Outgoing`` events; delivery failures are collected and fail ``close``."""

    def __init__(self, producer: KafkaProducerLike, topic: str) -> None:
        self.producer = producer
        self.topic = topic
        self.errors: list[str] = []
        self.delivered = 0

    def _on_delivery(self, err: Any, msg: Any) -> None:
        if err is not None:
            self.errors.append(str(err))
        else:
            self.delivered += 1

    def __call__(self, out: Outgoing) -> None:
        kwargs: dict[str, Any] = {
            "key": out.key.encode(),
            "value": out.event.to_json().encode(),
            "on_delivery": self._on_delivery,
        }
        if out.partition is not None:
            kwargs["partition"] = out.partition
        while True:
            try:
                self.producer.produce(self.topic, **kwargs)
                break
            except BufferError:  # local queue full: serve callbacks, then retry
                self.producer.poll(0.1)
        self.producer.poll(0)

    def close(self, timeout_s: float = 30.0) -> None:
        left = self.producer.flush(timeout_s)
        if left:
            self.errors.append(f"{left} messages still undelivered after {timeout_s} s")
        if self.errors:
            raise RuntimeError(f"Kafka delivery failed: {self.errors[:5]}")


# ============================================================================== CLI
def parse_args(argv: Iterable[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="f1sa-replay", description=__doc__.split("\n\n")[0])
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--speed", type=float, default=10.0, help="race-seconds per wall-second")
    p.add_argument("--allow-test-season", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="build the events, send nothing")
    return p.parse_args(list(argv) if argv is not None else None)


def main(
    argv: Iterable[str] | None = None,
    *,
    make_producer: Callable[[dict[str, Any]], KafkaProducerLike] | None = None,
    partitions: Callable[[str, str], int] = topic_partitions,
    spark_factory: Callable[[], Any] | None = None,
) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("py4j").setLevel(logging.WARNING)
    args = parse_args(argv)
    try:
        check_season(args.season, args.allow_test_season)
        if not args.speed > 0:
            raise RefusedError(f"--speed must be > 0, got {args.speed}")
    except RefusedError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    settings = get_settings()
    if spark_factory is None:
        from f1sa.etl.spark import build_spark

        def spark_factory() -> Any:
            return build_spark("f1sa-race-replay")

    spark = spark_factory()
    try:
        inputs = load_race_inputs(spark, settings.data_lake_uri, args.season, args.round)
    except ProducerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    n = 1 if args.dry_run else partitions(settings.kafka_bootstrap, settings.kafka_topic_events)
    events = build_events(inputs, n)
    span = events[-1].event.race_time_s - events[0].event.race_time_s
    print(
        f"{args.season} R{args.round}: {len(events)} events, {len(inputs.laps)} laps, "
        f"{len(inputs.stops)} stops, {span:.0f} race-s -> {span / args.speed:.0f} s "
        f"at x{args.speed:g}"
    )
    cov, n_laps = compound_coverage(inputs.laps), len(inputs.laps)
    known = n_laps - cov["none"]
    print(
        f"compound: {cov['tracinginsights']} tracinginsights, {cov['v1_stints']} v1_stints, "
        f"{cov['none']} unknown of {n_laps} laps ({100.0 * known / n_laps:.1f}% known)"
    )
    life = [r for r in inputs.laps if r.tyre_life_laps is not None]
    used = sum(1 for r in life if (r.tyre_life_at_start_laps or 0) > 0)
    print(
        f"tyre life: {len(life)} of {n_laps} laps known ({100.0 * len(life) / n_laps:.1f}%), "
        f"{used} on a used set"
    )
    tc = timing_coverage(inputs.laps)
    print(
        f"timing: sectors {tc['sectors']} of {n_laps} laps, speed trap {tc['speed_trap']} "
        f"of {n_laps} (display only)"
    )
    if args.dry_run:
        return 0
    if make_producer is None:
        from confluent_kafka import Producer

        def make_producer(conf: dict[str, Any]) -> KafkaProducerLike:
            producer: KafkaProducerLike = Producer(conf)  # type: ignore[assignment]
            return producer

    sender = KafkaSender(
        make_producer(producer_config(settings.kafka_bootstrap)), settings.kafka_topic_events
    )
    sent = replay(events, sender, args.speed)
    try:
        sender.close()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"sent {sent} events, {sender.delivered} delivered to {settings.kafka_topic_events}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
