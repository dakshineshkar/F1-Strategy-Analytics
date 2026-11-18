"""``GET /api/races/{season}/{round}/status?lap=N``: the race-status banner (Feature 5).

Display only and read only (``api/race_status.py``): the track status at the leader's lap N from
information up to lap N only. N defaults to the leader's latest lap in the lap log, and a lap the
live race has not reached yet is refused (409), so the lake's later laps are never shown early.
Nothing is written to Redis.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from f1sa.api.analysis import AnalysisDataError
from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race
from f1sa.api.models import AnalysisLapsOut, AnalysisRaceControlsOut, ErrorOut, RaceStatusOut
from f1sa.api.race_status import race_status

log = logging.getLogger(__name__)
router = APIRouter(tags=["status"])

Lap = Annotated[int | None, Query(ge=1, le=200, description="leader lap N (default: the latest)")]


@router.get(
    "/races/{season}/{round}/status",
    response_model=RaceStatusOut,
    responses={
        404: {"model": ErrorOut, "description": "unknown race or no live state"},
        409: {"model": ErrorOut, "description": "no laps recorded yet, or lap N not reached yet"},
        503: {"model": ErrorOut, "description": "Redis or the lake unavailable"},
    },
)
async def status(race: Race, deps: Deps, lap: Lap = None) -> RaceStatusOut:
    """GREEN / SC / VSC / RED FLAG (or the estimated neutralisation) at leader lap N, with the
    latest key race-control message with lap <= N where the lake has race control."""
    s, r = race.season, race.round
    try:
        info = await deps.catalog.get(s, r)
    except CatalogError as exc:
        log.error("race catalog unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    if info is None:
        raise HTTPException(404, f"{s} R{r} is not in the clean zone")
    if not await deps.store.race_keys(s, r):
        raise HTTPException(404, f"no live state for {s} R{r}")
    lap_log = await deps.lap_logs.ensure(s, r)
    current = lap_log.max_lap
    if current < 1:
        raise HTTPException(409, f"no laps recorded yet for {s} R{r} (start or watch a replay)")
    upto = current if lap is None else lap
    if upto > current:
        raise HTTPException(409, f"lap {upto} not reached yet (leader on lap {current})")
    try:
        laps_doc = await deps.analysis.get(s, r, "laps")
        rc_doc = await deps.analysis.get(s, r, "race_control")
    except CatalogError as exc:
        log.error("lake unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except AnalysisDataError as exc:
        log.warning("analysis malformed; track status estimated", extra={"reason": str(exc)})
        laps_doc = rc_doc = None
    return await asyncio.to_thread(
        race_status,
        s,
        r,
        upto,
        lap_log.lap_rows(),
        laps_doc if isinstance(laps_doc, AnalysisLapsOut) else None,
        rc_doc if isinstance(rc_doc, AnalysisRaceControlsOut) else None,
    )
