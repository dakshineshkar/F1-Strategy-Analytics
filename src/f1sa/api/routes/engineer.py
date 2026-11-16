"""``GET /api/races/{season}/{round}/engineer/{driverId}?lap=N``: the engineer view (Feature 3).

Display only and read only: the focus car against the cars directly ahead and behind, from
information up to lap N only (``api/engineer.py``). Nothing is written to Redis; the probabilities
come from the published driver hashes (current lap) or the lap log's per-lap record (earlier laps).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from f1sa.api.analysis import AnalysisDataError
from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race
from f1sa.api.engineer import EngineerError, EngineerInputs, build, known_compound
from f1sa.api.lap_log import read_published_probs
from f1sa.api.models import (
    DRIVER_ID_PATTERN,
    AnalysisLapsOut,
    AnalysisRaceControlsOut,
    EngineerOut,
    ErrorOut,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["engineer"])

DriverId = Annotated[str, Path(pattern=DRIVER_ID_PATTERN, description="Jolpica driverId")]
Lap = Annotated[int | None, Query(ge=1, le=200, description="lap N (default: the focus's latest)")]


@router.get(
    "/races/{season}/{round}/engineer/{driver_id}",
    response_model=EngineerOut,
    responses={
        404: {"model": ErrorOut, "description": "unknown race, no live state, or unknown driver"},
        409: {"model": ErrorOut, "description": "no laps recorded yet, or lap N not recorded"},
        503: {"model": ErrorOut, "description": "Redis or the lake unavailable"},
    },
)
async def engineer(race: Race, driver_id: DriverId, deps: Deps, lap: Lap = None) -> EngineerOut:
    """Position, gap and gap trend, pace, tyres, stint vs the typical stint, the stream's undercut
    probabilities (focus on ahead, behind on focus), a pit-rejoin estimate and rule-based strategy
    calls (display rules, not model output). Values use laps <= N only."""
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
    rows = lap_log.lap_rows()
    if not rows:
        raise HTTPException(409, f"no laps recorded yet for {s} R{r} (start or watch a replay)")
    if not any(x.driver_id == driver_id for x in rows):
        raise HTTPException(404, f"no recorded laps for {driver_id} in {s} R{r}")
    current_probs = await read_published_probs(deps.redis, s, r)
    upto = lap if lap is not None else max(x.lap for x in rows if x.driver_id == driver_id)
    compounds = {known_compound(x.compound) for x in rows if x.lap <= upto}
    try:
        pit_loss, pit_source = await asyncio.to_thread(deps.engineer.pit_loss, s, r)
        circuits, stints = await asyncio.to_thread(deps.engineer.stints, s, r, compounds)
        laps_doc = await deps.analysis.get(s, r, "laps")
        rc_doc = await deps.analysis.get(s, r, "race_control")
    except CatalogError as exc:
        log.error("lake unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except AnalysisDataError as exc:
        log.warning("analysis malformed; track status estimated", extra={"reason": str(exc)})
        laps_doc = rc_doc = None
    try:
        entrants = await deps.entrants.get(s, r)
    except Exception:  # display codes only: any failure falls back to codes from the id
        log.warning("entrants unavailable for the engineer view", exc_info=True)
        entrants = None
    codes = {e.driver_id: e.code for e in entrants.entrants if e.code} if entrants else {}
    inputs = EngineerInputs(
        season=s,
        round=r,
        focus_id=driver_id,
        lap=lap,
        rows=rows,
        current_probs=current_probs,
        recorded_probs={n: p for n in range(1, upto + 1) if (p := lap_log.probs_at(n)) is not None},
        pit_loss_s=pit_loss,
        pit_loss_source=pit_source,
        circuit_of=circuits,
        stints=stints,
        laps_doc=laps_doc if isinstance(laps_doc, AnalysisLapsOut) else None,
        rc_doc=rc_doc if isinstance(rc_doc, AnalysisRaceControlsOut) else None,
        codes=codes,
    )
    try:
        return await asyncio.to_thread(build, inputs)
    except EngineerError as exc:
        raise HTTPException(exc.status, exc.detail) from exc
