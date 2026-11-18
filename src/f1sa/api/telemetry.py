"""Display-only telemetry lap overlay for the dashboard (Feature 6, 2024 only).

``TelemetryService`` serves ``GET /api/races/{s}/{r}/telemetry/laps?driver=CODE`` and
``…/telemetry/compare?a=CODE&alap=N&b=CODE&blap=M`` from ``clean/telemetry_trace`` (one row per
driver lap, partitioned by season, round and driver code; ``etl.telemetry_trace``):

1. Any season other than 2024 is refused first (``TelemetryNotFound(ONLY_2024)``, a 404): the lake
   keeps raw telemetry for 2024 only, and the sealed 2025 season is never read.
2. Redis ``GET meta:telemetry:{s}:{r}:laps:{CODE}`` / ``…:trace:{CODE}:{lap}``
   (``serving.keys``). The value is ``{"lake": <lake_fingerprint>, "data": <response>}``; an entry
   of another lake or a malformed one is a miss and is overwritten.
3. Otherwise one driver partition is read (``catalog.telemetry_reader``: ``clean`` zone, that one
   table, LISTSTATUS/OPEN only, never ``raw``), validated and stored with
   ``SET … EX API_TELEMETRY_CACHE_S``. Keys are outside ``race:*``; Redis is only a cache.

**The compare** (``compare_traces``) puts both laps on ``a``'s grid ``x_k`` (metres from ``a``'s
start line). ``b`` is read at the same **fraction of its own lap**, ``f_k · L_b`` with
``f_k = x_k / L_a``: TracingInsights integrates each lap's distance from the speed, so two laps
differ by up to about 0.3% (some 16 m, about 0.2 s at 300 km/h) and comparing at equal metres would
move the finish line. Continuous channels are interpolated linearly, gear/brake/DRS hold the last
grid value at or before the point.

``delta_k = t_a(x_k) - t_b(x_k)``: the difference in elapsed time to reach the same point of the
lap; positive = ``a`` behind there (it needed longer), negative = ``a`` ahead (the sign of the
Feature 2 compare, ``a - b``). Where the delta rises ``a`` is losing time, where it falls ``a`` is
gaining. At the line it is ``trace_time_a - trace_time_b`` (the lap-time difference from lap 2
on). The lap is cut into ``N_SEGMENTS`` equal mini-sectors of ``a``'s axis; each segment's
``delta_change_s`` is the delta at its end minus the delta at its start, so the segments add up to
``delta[-1] - delta[0]`` exactly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Callable, Sequence
from typing import Any, TypeVar

import numpy as np
import redis.asyncio as aioredis
from pydantic import BaseModel, ValidationError
from redis.exceptions import RedisError

from f1sa.api.catalog import DriverReader
from f1sa.api.models import (
    TelemetryCarOut,
    TelemetryCompareOut,
    TelemetryLapOut,
    TelemetryLapsOut,
    TelemetrySegmentOut,
    TelemetryTraceOut,
)
from f1sa.serving import keys as K

log = logging.getLogger(__name__)

TABLE = "telemetry_trace"
"""``lake.schemas_telemetry_trace.TABLE`` (not imported: the API never imports pyspark; tested)."""
TABLES: tuple[str, ...] = (TABLE,)
SEASON = 2024
ONLY_2024 = "telemetry traces are available for 2024 only"
N_SEGMENTS = 25
META_COLUMNS: tuple[str, ...] = ("driver_id", "is_synthetic", "source", "grid_step_m")
SUMMARY_COLUMNS: tuple[str, ...] = tuple(TelemetryLapOut.model_fields)
ARRAY_COLUMNS: tuple[str, ...] = (
    "distance_m",
    "elapsed_s",
    "speed_kph",
    "throttle_pct",
    "rpm",
    "brake",
    "n_gear",
    "drs",
    "braking_start_m",
    "braking_end_m",
    "braking_apex_kph",
)
_DECIMALS: dict[str, int] = {
    "distance_m": 1,
    "elapsed_s": 3,
    "speed_kph": 1,
    "throttle_pct": 1,
    "rpm": 0,
    "braking_start_m": 1,
    "braking_end_m": 1,
    "braking_apex_kph": 1,
}
_DISCRETE = ("brake", "n_gear", "drs")
T = TypeVar("T", bound=BaseModel)


class TelemetryDataError(RuntimeError):
    """A stored trace row breaks the response schema."""


class TelemetryNotFound(LookupError):
    """A 404: another season, no traces for the race, an unknown driver or lap."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def _finite(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _rounded(name: str, values: Sequence[Any] | None) -> list[Any]:
    if values is None:
        return []
    if name in _DECIMALS:
        d = _DECIMALS[name]
        return [round(float(v), d) if d else float(round(float(v))) for v in values]
    return [int(v) for v in values]


def to_summary(row: dict[str, Any]) -> TelemetryLapOut:
    return TelemetryLapOut.model_validate({c: _finite(row.get(c)) for c in SUMMARY_COLUMNS})


def fastest_lap(rows: Sequence[TelemetryLapOut]) -> int | None:
    """Fastest lap time among full-coverage laps that are not deleted, pit-in or pit-out laps;
    else the fastest trace time among full-coverage laps (then any lap); ``None`` if none."""
    clean = [
        r
        for r in rows
        if r.coverage == "full"
        and r.lap_time_s is not None
        and not r.is_deleted
        and not r.is_pit_in_lap
        and not r.is_pit_out_lap
    ]
    if clean:
        return min(clean, key=lambda r: (r.lap_time_s or 0.0, r.lap)).lap
    for pool in ([r for r in rows if r.coverage == "full"], list(rows)):
        if pool:
            return min(pool, key=lambda r: (r.trace_time_s, r.lap)).lap
    return None


def _meta(season: int, round_: int, code: str, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "season": season,
        "round": round_,
        "driver_id": row.get("driver_id"),
        "driver_code": code,
        "is_synthetic": bool(row.get("is_synthetic")),
        "source": row.get("source"),
        "grid_step_m": row.get("grid_step_m"),
    }


def to_laps(
    season: int, round_: int, code: str, rows: Sequence[dict[str, Any]]
) -> TelemetryLapsOut:
    """A driver's stored rows -> the laps response; ``TelemetryDataError`` on a malformed row."""
    try:
        summaries = sorted((to_summary(r) for r in rows), key=lambda s: s.lap)
        if len({s.lap for s in summaries}) != len(summaries):
            raise TelemetryDataError(f"{code} {season} R{round_}: duplicate laps")
        return TelemetryLapsOut.model_validate(
            {
                **_meta(season, round_, code, rows[0]),
                "fastest_lap": fastest_lap(summaries),
                "rows": summaries,
            }
        )
    except (ValidationError, KeyError, TypeError, IndexError) as exc:
        raise TelemetryDataError(
            f"telemetry laps {code} {season} R{round_}: {type(exc).__name__}"
        ) from exc


def to_trace(season: int, round_: int, code: str, row: dict[str, Any]) -> TelemetryTraceOut:
    """One stored row -> the lap's trace; ``TelemetryDataError`` on a malformed row."""
    try:
        return TelemetryTraceOut.model_validate(
            {
                **_meta(season, round_, code, row),
                "summary": to_summary(row),
                **{c: _rounded(c, row.get(c)) for c in ARRAY_COLUMNS},
            }
        )
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        raise TelemetryDataError(
            f"telemetry trace {code} {season} R{round_}: {type(exc).__name__}"
        ) from exc


def hold(x: np.ndarray, xp: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """The value of the last ``xp`` at or before each ``x`` (the first one before ``xp[0]``)."""
    idx = np.searchsorted(xp, x, side="right") - 1
    return fp[np.clip(idx, 0, len(fp) - 1)]


def _r(values: np.ndarray, decimals: int) -> list[float]:
    return [round(float(v), decimals) for v in values]


def segment_changes(
    axis: np.ndarray, delta: np.ndarray, n_segments: int = N_SEGMENTS
) -> list[tuple[float, float, float]]:
    """``n_segments`` equal mini-sectors of ``axis``: (start, end, delta(end) - delta(start)),
    the delta read by linear interpolation at the edges."""
    if n_segments < 1:
        raise ValueError("n_segments must be at least 1")
    edges = np.linspace(float(axis[0]), float(axis[-1]), n_segments + 1)
    at = np.interp(edges, axis, delta)
    return [
        (float(edges[j]), float(edges[j + 1]), float(at[j + 1] - at[j])) for j in range(n_segments)
    ]


def compare_traces(
    a: TelemetryTraceOut, b: TelemetryTraceOut, n_segments: int = N_SEGMENTS
) -> TelemetryCompareOut:
    """Both laps on ``a``'s grid, ``b`` read at the same lap fraction (module docstring)."""
    xa = np.asarray(a.distance_m, dtype=np.float64)
    xb = np.asarray(b.distance_m, dtype=np.float64)
    la, lb = float(xa[-1]), float(xb[-1])
    own_b = xa / la * lb
    ta = np.asarray(a.elapsed_s, dtype=np.float64)
    tb = np.interp(own_b, xb, np.asarray(b.elapsed_s, dtype=np.float64))
    delta = ta - tb
    segments = [
        TelemetrySegmentOut(
            index=j, start_m=round(s, 1), end_m=round(e, 1), delta_change_s=round(c, 3)
        )
        for j, (s, e, c) in enumerate(segment_changes(xa, delta, n_segments))
    ]

    def lane(trace: TelemetryTraceOut, name: str, at: np.ndarray, own: np.ndarray) -> list[Any]:
        values = np.asarray(getattr(trace, name), dtype=np.float64)
        if name in _DISCRETE:
            return [int(v) for v in hold(at, own, values)]
        return _r(np.interp(at, own, values), _DECIMALS[name])

    def car(
        trace: TelemetryTraceOut, at: np.ndarray, own: np.ndarray, scale: float
    ) -> TelemetryCarOut:
        return TelemetryCarOut(
            driver_id=trace.driver_id,
            driver_code=trace.driver_code,
            lap=trace.summary.lap,
            summary=trace.summary,
            own_distance_m=_r(at, 1),
            elapsed_s=_r(np.interp(at, own, np.asarray(trace.elapsed_s, dtype=np.float64)), 3),
            speed_kph=lane(trace, "speed_kph", at, own),
            throttle_pct=lane(trace, "throttle_pct", at, own),
            rpm=lane(trace, "rpm", at, own),
            brake=lane(trace, "brake", at, own),
            n_gear=lane(trace, "n_gear", at, own),
            drs=lane(trace, "drs", at, own),
            braking_start_m=[round(v * scale, 1) for v in trace.braking_start_m],
            braking_end_m=[round(v * scale, 1) for v in trace.braking_end_m],
            braking_apex_kph=list(trace.braking_apex_kph),
        )

    la_t, lb_t = a.summary.lap_time_s, b.summary.lap_time_s
    return TelemetryCompareOut(
        season=a.season,
        round=a.round,
        is_synthetic=a.is_synthetic or b.is_synthetic,
        grid_step_m=a.grid_step_m,
        distance_m=_r(xa, 1),
        a=car(a, xa, xa, 1.0),
        b=car(b, own_b, xb, la / lb),
        delta_s=_r(delta, 3),
        segments=segments,
        final_delta_s=round(float(delta[-1]), 3),
        lap_time_delta_s=None if la_t is None or lb_t is None else round(la_t - lb_t, 3),
    )


class TelemetryService:
    def __init__(
        self,
        reader_factory: Callable[[], DriverReader],
        redis: aioredis.Redis,
        *,
        ttl_s: int,
        lake_id: str,
    ) -> None:
        self._reader_factory = reader_factory
        self._redis = redis
        self.ttl_s = ttl_s
        self.lake_id = lake_id

    async def _cached(self, key: str, model: type[T]) -> T | None:
        try:
            raw = await self._redis.get(key)
        except RedisError as exc:
            log.warning("telemetry cache read failed", extra={"reason": type(exc).__name__})
            return None
        if raw is None:
            return None
        try:
            doc = json.loads(raw)
            if not isinstance(doc, dict) or doc.get("lake") != self.lake_id:
                return None  # written by an api on another lake (sample vs full): a miss
            return model.model_validate(doc.get("data"))
        except (ValueError, ValidationError):
            log.warning("telemetry cache entry is malformed; reading the lake", extra={"key": key})
            return None

    async def _store(self, key: str, out: BaseModel) -> None:
        try:
            doc = {"lake": self.lake_id, "data": out.model_dump(mode="json")}
            await self._redis.set(key, json.dumps(doc, separators=(",", ":")), ex=self.ttl_s)
        except RedisError as exc:
            log.warning("telemetry cache write failed", extra={"reason": type(exc).__name__})

    def _read(
        self, season: int, round_: int, code: str, columns: Sequence[str]
    ) -> list[dict[str, Any]]:
        rows = self._reader_factory().read_driver_rows(TABLE, season, round_, code, tuple(columns))
        if rows is None:
            raise TelemetryNotFound(
                f"no telemetry traces for {season} R{round_} in the lake "
                "(run make telemetry-trace-full)"
            )
        if not rows:
            raise TelemetryNotFound(f"no telemetry for {code} in {season} R{round_}")
        return rows

    @staticmethod
    def _check(season: int) -> None:
        if season != SEASON:
            raise TelemetryNotFound(ONLY_2024)

    async def laps(self, season: int, round_: int, code: str) -> TelemetryLapsOut:
        """The driver's laps with a trace. Raises ``TelemetryNotFound`` (404),
        ``TelemetryDataError`` (500) and ``CatalogError`` (503)."""
        self._check(season)
        key = K.telemetry_laps_meta_key(season, round_, code)
        hit = await self._cached(key, TelemetryLapsOut)
        if hit is not None and (hit.season, hit.round, hit.driver_code) == (season, round_, code):
            return hit
        columns = (*META_COLUMNS, *SUMMARY_COLUMNS)
        rows = await asyncio.to_thread(self._read, season, round_, code, columns)
        out = to_laps(season, round_, code, rows)
        await self._store(key, out)
        return out

    async def trace(self, season: int, round_: int, code: str, lap: int) -> TelemetryTraceOut:
        """One lap's trace (cached per lap); the same errors as ``laps``."""
        self._check(season)
        key = K.telemetry_trace_meta_key(season, round_, code, lap)
        hit = await self._cached(key, TelemetryTraceOut)
        if hit is not None and (hit.season, hit.round, hit.driver_code, hit.summary.lap) == (
            season,
            round_,
            code,
            lap,
        ):
            return hit
        columns = (*META_COLUMNS, *SUMMARY_COLUMNS, *ARRAY_COLUMNS)
        rows = await asyncio.to_thread(self._read, season, round_, code, columns)
        match = [r for r in rows if r.get("lap") == lap]
        if not match:
            raise TelemetryNotFound(
                f"no telemetry trace for {code} lap {lap} in {season} R{round_}"
            )
        if len(match) > 1:
            raise TelemetryDataError(f"{code} lap {lap} {season} R{round_}: duplicate rows")
        out = to_trace(season, round_, code, match[0])
        await self._store(key, out)
        return out

    async def compare(
        self, season: int, round_: int, a: str, alap: int, b: str, blap: int
    ) -> TelemetryCompareOut:
        """Two laps on one distance axis with the delta-time lane (no key of its own)."""
        self._check(season)
        ta = await self.trace(season, round_, a, alap)
        tb = await self.trace(season, round_, b, blap)
        return compare_traces(ta, tb)
