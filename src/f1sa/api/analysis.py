"""Display-only post-race analysis for the dashboard (Feature 2).

``AnalysisService`` serves ``GET /api/races/{s}/{r}/analysis/{view}`` for the views ``laps``,
``stints``, ``pitstops``, ``race-control`` and ``positions``, and ``…/analysis/compare?a=&b=``:

1. Redis ``GET meta:analysis:{s}:{r}:{view}`` (``serving.keys.analysis_meta_key``). The value is
   ``{"lake": <lake_fingerprint>, "data": <response>}``; a hit from the same lake that parses and
   validates is returned as it is. An entry of another lake or a malformed one is a miss and is
   overwritten.
2. Otherwise the race's ``clean/analysis_race`` row (its coverage) and the view's table are read
   with a reader limited to the analysis tables and ``entrants`` (``catalog.zone_reader``;
   ``file://`` with pyarrow or ``hdfs://`` with HttpFS ``LISTSTATUS``/``OPEN``; never ``raw``),
   validated and stored with ``SET … EX API_ANALYSIS_CACHE_S``.

``positions`` is shaped from the laps plus the grid slot of the clean ``entrants`` table (read
only). ``compare`` is shaped from the (cached) laps response, so it has no key of its own. The keys
are outside ``race:*``, so the race state, the SSE snapshots and the ``session_end`` expiry never
see them, and the 9-field driver hash is never touched. Redis is only a cache: a Redis error is
logged and the lake is read directly. A race without an ``analysis_race`` row (or the sealed 2025
season without ``ALLOW_TEST_SEASON=1``) gives ``None`` (404); negative results are not cached.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Callable, Sequence
from typing import Any, TypeVar

import redis.asyncio as aioredis
from pydantic import BaseModel, ValidationError
from redis.exceptions import RedisError

from f1sa.api.catalog import LakeReader
from f1sa.api.models import (
    AnalysisCoverageOut,
    AnalysisLapOut,
    AnalysisLapsOut,
    AnalysisPitStopOut,
    AnalysisPitStopsOut,
    AnalysisRaceControlOut,
    AnalysisRaceControlsOut,
    AnalysisStintOut,
    AnalysisStintsOut,
    CompareDriverOut,
    CompareLapOut,
    CompareOut,
    PositionPointOut,
    PositionSeriesOut,
    PositionsOut,
)
from f1sa.serving import keys as K
from f1sa.streaming.processor import SEALED_SEASON

log = logging.getLogger(__name__)

# ``lake.schemas_analysis`` table names (not imported: the API never imports pyspark; tested equal).
RACE_TABLE = "analysis_race"
LAPS_TABLE = "analysis_laps"
STINTS_TABLE = "analysis_stints"
PITSTOPS_TABLE = "analysis_pitstops"
RACE_CONTROL_TABLE = "analysis_race_control"
ENTRANTS_TABLE = "entrants"
TABLES: tuple[str, ...] = (
    RACE_TABLE,
    LAPS_TABLE,
    STINTS_TABLE,
    PITSTOPS_TABLE,
    RACE_CONTROL_TABLE,
    ENTRANTS_TABLE,
)
"""The only tables the analysis reader may open."""

VIEW_TABLES: dict[str, str] = {
    "laps": LAPS_TABLE,
    "stints": STINTS_TABLE,
    "pitstops": PITSTOPS_TABLE,
    "race_control": RACE_CONTROL_TABLE,
}
COVERAGE_COLUMNS: tuple[str, ...] = tuple(AnalysisCoverageOut.model_fields)
ROW_MODELS: dict[str, type[BaseModel]] = {
    "laps": AnalysisLapOut,
    "stints": AnalysisStintOut,
    "pitstops": AnalysisPitStopOut,
    "race_control": AnalysisRaceControlOut,
}
OUT_MODELS: dict[str, type[BaseModel]] = {
    "laps": AnalysisLapsOut,
    "stints": AnalysisStintsOut,
    "pitstops": AnalysisPitStopsOut,
    "race_control": AnalysisRaceControlsOut,
    "positions": PositionsOut,
}
_SORT: dict[str, Callable[[dict[str, Any]], tuple[Any, ...]]] = {
    "laps": lambda r: (r["driver_id"], r["lap"]),
    "stints": lambda r: (r["driver_id"], r["stint"]),
    "pitstops": lambda r: (r["lap"], r["stop"], r["driver_id"]),
    "race_control": lambda r: (r["seq"],),
}
T = TypeVar("T", bound=BaseModel)


class AnalysisDataError(RuntimeError):
    """A stored analysis row breaks the response schema."""


class UnknownDriverError(LookupError):
    """``compare`` named a driver code that has no laps in the race."""


def _finite(value: Any) -> Any:
    """NaN / infinity (never valid JSON) become null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _clean(rows: Sequence[dict[str, Any]], columns: Sequence[str]) -> list[dict[str, Any]]:
    return [{c: _finite(r.get(c)) for c in columns} for r in rows]


def to_coverage(season: int, round_: int, rows: Sequence[dict[str, Any]]) -> AnalysisCoverageOut:
    """The single ``analysis_race`` row -> coverage; ``AnalysisDataError`` if not exactly one."""
    if len(rows) != 1:
        raise AnalysisDataError(f"analysis_race {season} R{round_}: {len(rows)} rows, expected 1")
    try:
        return AnalysisCoverageOut.model_validate(_clean(rows, COVERAGE_COLUMNS)[0])
    except ValidationError as exc:
        raise AnalysisDataError(f"analysis_race {season} R{round_}: invalid") from exc


def to_view(
    view: str,
    season: int,
    round_: int,
    coverage: AnalysisCoverageOut,
    rows: Sequence[dict[str, Any]],
) -> BaseModel:
    """Lake rows of ``view`` -> the sorted response; ``AnalysisDataError`` on a malformed row."""
    model = ROW_MODELS[view]
    try:
        items = [model.model_validate(r) for r in _clean(rows, tuple(model.model_fields))]
        cleaned = sorted((i.model_dump() for i in items), key=_SORT[view])
        return OUT_MODELS[view].model_validate(
            {"season": season, "round": round_, "coverage": coverage, "rows": cleaned}
        )
    except (ValidationError, KeyError, TypeError) as exc:
        raise AnalysisDataError(f"{view} {season} R{round_}: {type(exc).__name__}") from exc


def to_positions(laps: AnalysisLapsOut, grid: dict[str, int | None]) -> PositionsOut:
    """One series per driver (finishing order: last lap desc, then last position), with the grid."""
    by: dict[str, list[AnalysisLapOut]] = {}
    for row in laps.rows:
        by.setdefault(row.driver_id, []).append(row)

    def finish(item: tuple[str, list[AnalysisLapOut]]) -> tuple[int, int, str]:
        last = max(item[1], key=lambda r: r.lap)
        return (-last.lap, last.position if last.position is not None else 1_000, item[0])

    series = [
        PositionSeriesOut(
            driver_id=driver,
            driver_code=rows[0].driver_code,
            grid=grid.get(driver),
            positions=[
                PositionPointOut(lap=r.lap, position=r.position)
                for r in sorted(rows, key=lambda r: r.lap)
                if r.position is not None
            ],
        )
        for driver, rows in sorted(by.items(), key=finish)
    ]
    return PositionsOut(season=laps.season, round=laps.round, coverage=laps.coverage, rows=series)


def _diff(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else round(a - b, 3)


def to_compare(laps: AnalysisLapsOut, a_code: str, b_code: str) -> CompareOut:
    """Per-lap comparison of two drivers (``a`` minus ``b``): lap-time delta, cumulative gap at
    the same lap (positive = ``a`` behind) and sector deltas where both sectors exist. Laps that
    only one of them completed are kept with null deltas. Raises ``UnknownDriverError``."""
    codes: dict[str, str] = {}
    for row in laps.rows:
        if row.driver_code is not None:
            codes.setdefault(row.driver_code, row.driver_id)
    missing = [c for c in (a_code, b_code) if c not in codes]
    if missing:
        raise UnknownDriverError(", ".join(missing))
    a_id, b_id = codes[a_code], codes[b_code]
    a_laps = {r.lap: r for r in laps.rows if r.driver_id == a_id}
    b_laps = {r.lap: r for r in laps.rows if r.driver_id == b_id}
    rows = []
    for lap in sorted(set(a_laps) | set(b_laps)):
        a, b = a_laps.get(lap), b_laps.get(lap)
        rows.append(
            CompareLapOut(
                lap=lap,
                a_lap_time_s=a.lap_time_s if a else None,
                b_lap_time_s=b.lap_time_s if b else None,
                delta_s=_diff(a.lap_time_s, b.lap_time_s) if a and b else None,
                gap_s=_diff(a.cumulative_time_s, b.cumulative_time_s) if a and b else None,
                sector1_delta_s=_diff(a.sector1_s, b.sector1_s) if a and b else None,
                sector2_delta_s=_diff(a.sector2_s, b.sector2_s) if a and b else None,
                sector3_delta_s=_diff(a.sector3_s, b.sector3_s) if a and b else None,
                a_position=a.position if a else None,
                b_position=b.position if b else None,
                a_compound=a.compound if a else None,
                b_compound=b.compound if b else None,
                a_pit=bool(a and (a.is_pit_in_lap or a.is_pit_out_lap)),
                b_pit=bool(b and (b.is_pit_in_lap or b.is_pit_out_lap)),
                neutralised=any(
                    x is not None and bool(x.is_neutralised_lap or x.is_red_flag_lap)
                    for x in (a, b)
                ),
            )
        )
    return CompareOut(
        season=laps.season,
        round=laps.round,
        coverage=laps.coverage,
        a=CompareDriverOut(driver_id=a_id, driver_code=a_code),
        b=CompareDriverOut(driver_id=b_id, driver_code=b_code),
        rows=rows,
    )


class AnalysisService:
    def __init__(
        self,
        reader_factory: Callable[[], LakeReader],
        redis: aioredis.Redis,
        *,
        ttl_s: int,
        allow_test_season: bool,
        lake_id: str,
    ) -> None:
        self._reader_factory = reader_factory
        self._redis = redis
        self.ttl_s = ttl_s
        self.allow_test_season = allow_test_season
        self.lake_id = lake_id

    async def _cached(self, key: str, model: type[T]) -> T | None:
        try:
            raw = await self._redis.get(key)
        except RedisError as exc:
            log.warning("analysis cache read failed", extra={"reason": type(exc).__name__})
            return None
        if raw is None:
            return None
        try:
            doc = json.loads(raw)
            if not isinstance(doc, dict) or doc.get("lake") != self.lake_id:
                return None  # written by an api on another lake (sample vs full): a miss
            return model.model_validate(doc.get("data"))
        except (ValueError, ValidationError):
            log.warning("analysis cache entry is malformed; reading the lake", extra={"key": key})
            return None

    async def _store(self, key: str, out: BaseModel) -> None:
        try:
            doc = {"lake": self.lake_id, "data": out.model_dump(mode="json")}
            await self._redis.set(key, json.dumps(doc, separators=(",", ":")), ex=self.ttl_s)
        except RedisError as exc:
            log.warning("analysis cache write failed", extra={"reason": type(exc).__name__})

    def _read(
        self, table: str, season: int, round_: int, columns: Sequence[str]
    ) -> list[dict[str, Any]]:
        return self._reader_factory().read_rows(table, season, round_, tuple(columns))

    def _read_view(self, view: str, season: int, round_: int) -> BaseModel | None:
        race = self._read(RACE_TABLE, season, round_, COVERAGE_COLUMNS)
        if not race:
            return None
        coverage = to_coverage(season, round_, race)
        if view == "positions":
            laps = self._read(LAPS_TABLE, season, round_, tuple(AnalysisLapOut.model_fields))
            out = to_view("laps", season, round_, coverage, laps)
            if not isinstance(out, AnalysisLapsOut):
                raise AnalysisDataError(f"laps {season} R{round_}: unexpected model")
            entrants = self._read(ENTRANTS_TABLE, season, round_, ("driver_id", "grid"))
            grid = {str(r["driver_id"]): r.get("grid") for r in entrants}
            return to_positions(out, grid)
        model = ROW_MODELS[view]
        rows = self._read(VIEW_TABLES[view], season, round_, tuple(model.model_fields))
        return to_view(view, season, round_, coverage, rows)

    async def get(self, season: int, round_: int, view: str) -> BaseModel | None:
        """The race's ``view``, or ``None`` if the lake has no analysis (or 2025 is sealed).

        Raises ``CatalogError`` when the lake cannot be read and ``AnalysisDataError`` when a
        stored row is malformed."""
        if view not in OUT_MODELS:
            raise ValueError(f"unknown analysis view {view!r}")
        if season == SEALED_SEASON and not self.allow_test_season:
            return None
        key = K.analysis_meta_key(season, round_, view)
        model = OUT_MODELS[view]
        hit = await self._cached(key, model)
        if hit is not None and (getattr(hit, "season", None), getattr(hit, "round", None)) == (
            season,
            round_,
        ):
            return hit
        out = await asyncio.to_thread(self._read_view, view, season, round_)
        if out is None:
            return None
        await self._store(key, out)
        return out

    async def compare(self, season: int, round_: int, a: str, b: str) -> CompareOut | None:
        """Two drivers lap by lap, from the (cached) laps view; ``None`` if the race has no
        analysis. Raises ``UnknownDriverError`` for a code without laps in the race."""
        laps = await self.get(season, round_, "laps")
        if laps is None:
            return None
        if not isinstance(laps, AnalysisLapsOut):
            raise AnalysisDataError(f"laps {season} R{round_}: unexpected model")
        return to_compare(laps, a, b)
