"""``GET /api/races/{season}/{round}/telemetry/*``: the display-only lap overlay (Feature 6).

Read-only views of ``clean/telemetry_trace`` (2024 only: any other season is a 404 with
``telemetry traces are available for 2024 only``), cached in Redis under
``meta:telemetry:{s}:{r}:…`` (never a ``race:*`` key).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race
from f1sa.api.models import (
    DRIVER_CODE_PATTERN,
    ErrorOut,
    TelemetryCompareOut,
    TelemetryLapsOut,
)
from f1sa.api.telemetry import TelemetryDataError, TelemetryNotFound
from f1sa.serving import keys as K

log = logging.getLogger(__name__)
router = APIRouter(tags=["telemetry"])

_RESPONSES: dict[int | str, dict[str, object]] = {
    404: {
        "model": ErrorOut,
        "description": "not 2024 (telemetry traces are available for 2024 only), no traces for "
        "the race, or no trace for the driver or lap",
    },
    500: {"model": ErrorOut, "description": "a stored trace row is malformed"},
    503: {"model": ErrorOut, "description": "clean zone unavailable"},
}
_PREFIX = "/races/{season}/{round}/telemetry"

Code = Annotated[str, Query(pattern=DRIVER_CODE_PATTERN, description="three-letter driver code")]
Lap = Annotated[int, Query(ge=K.LAP_MIN, le=K.LAP_MAX, description="lap number")]


async def _guarded[T](view: str, call: Awaitable[T]) -> T:
    try:
        return await call
    except TelemetryNotFound as exc:
        raise HTTPException(404, exc.detail) from exc
    except CatalogError as exc:
        log.error("telemetry unavailable", extra={"view": view, "reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except TelemetryDataError as exc:
        log.error("telemetry malformed", extra={"view": view, "reason": str(exc)})
        raise HTTPException(500, "stored telemetry trace is malformed") from exc


@router.get(
    f"{_PREFIX}/laps",
    response_model=TelemetryLapsOut,
    responses={**_RESPONSES, 422: {"description": "driver is not a three-letter code"}},
)
async def telemetry_laps(race: Race, deps: Deps, driver: Code) -> TelemetryLapsOut:
    """The driver's laps with a telemetry trace: per-lap summary (top speed, minimum corner speed,
    full-throttle share, braking zones, coverage) and the default (fastest) lap."""
    return await _guarded("laps", deps.telemetry.laps(race.season, race.round, driver))


@router.get(
    f"{_PREFIX}/compare",
    response_model=TelemetryCompareOut,
    responses={
        **_RESPONSES,
        422: {"description": "a bad code or lap, or the same driver and lap twice"},
    },
)
async def telemetry_compare(
    race: Race, deps: Deps, a: Code, alap: Lap, b: Code, blap: Lap
) -> TelemetryCompareOut:
    """Two laps on one distance axis (``a``'s), ``b`` read at the same fraction of its lap, with
    the delta-time lane ``elapsed a - elapsed b`` (+ = ``a`` behind) and 25 mini-sector deltas."""
    if (a, alap) == (b, blap):
        raise HTTPException(422, "pick two different laps (a driver and lap twice)")
    return await _guarded(
        "compare", deps.telemetry.compare(race.season, race.round, a, alap, b, blap)
    )
