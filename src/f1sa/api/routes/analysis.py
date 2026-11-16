"""``GET /api/races/{season}/{round}/analysis/*``: the display-only post-race analysis (Feature 2).

Read-only views of the ``clean/analysis_*`` tables, cached in Redis under
``meta:analysis:{s}:{r}:{view}`` (never a ``race:*`` key). 2025 only with ``ALLOW_TEST_SEASON=1``.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from f1sa.api.analysis import AnalysisDataError, UnknownDriverError
from f1sa.api.catalog import CatalogError
from f1sa.api.deps import ApiDeps, Deps, Race, RaceRef
from f1sa.api.models import (
    DRIVER_CODE_PATTERN,
    AnalysisLapsOut,
    AnalysisPitStopsOut,
    AnalysisRaceControlsOut,
    AnalysisStintsOut,
    CompareOut,
    ErrorOut,
    PositionsOut,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["analysis"])

_RESPONSES: dict[int | str, dict[str, object]] = {
    404: {"model": ErrorOut, "description": "the race has no analysis in the lake"},
    500: {"model": ErrorOut, "description": "a stored analysis row is malformed"},
    503: {"model": ErrorOut, "description": "clean zone unavailable"},
}
_PREFIX = "/races/{season}/{round}/analysis"


async def _view[T: BaseModel](deps: ApiDeps, race: RaceRef, view: str, model: type[T]) -> T:
    s, r = race.season, race.round
    try:
        out = await deps.analysis.get(s, r, view)
    except CatalogError as exc:
        log.error("analysis unavailable", extra={"view": view, "reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except AnalysisDataError as exc:
        log.error("analysis malformed", extra={"season": s, "round": r, "reason": str(exc)})
        raise HTTPException(500, "stored analysis is malformed") from exc
    if out is None:
        raise HTTPException(404, f"no analysis for {s} R{r}")
    if not isinstance(out, model):
        raise HTTPException(500, "stored analysis is malformed")
    return out


@router.get(f"{_PREFIX}/laps", response_model=AnalysisLapsOut, responses=_RESPONSES)
async def analysis_laps(race: Race, deps: Deps) -> AnalysisLapsOut:
    """Every lap of every driver: lap and sector times, speed traps, position, compound, real tyre
    life, stint, pit in/out, deleted, SC/VSC/red flag and the quick-lap exclusion."""
    return await _view(deps, race, "laps", AnalysisLapsOut)


@router.get(f"{_PREFIX}/stints", response_model=AnalysisStintsOut, responses=_RESPONSES)
async def analysis_stints(race: Race, deps: Deps) -> AnalysisStintsOut:
    """Stints with the lap-time-vs-tyre-life slope over quick laps (a proxy, not tyre wear)."""
    return await _view(deps, race, "stints", AnalysisStintsOut)


@router.get(f"{_PREFIX}/pitstops", response_model=AnalysisPitStopsOut, responses=_RESPONSES)
async def analysis_pitstops(race: Race, deps: Deps) -> AnalysisPitStopsOut:
    """Jolpica pit stops (pit-lane time) with compounds and positions before and after."""
    return await _view(deps, race, "pitstops", AnalysisPitStopsOut)


@router.get(f"{_PREFIX}/race-control", response_model=AnalysisRaceControlsOut, responses=_RESPONSES)
async def analysis_race_control(race: Race, deps: Deps) -> AnalysisRaceControlsOut:
    """Race-control messages with their kind (empty when the lake has none, e.g. the sample)."""
    return await _view(deps, race, "race_control", AnalysisRaceControlsOut)


@router.get(f"{_PREFIX}/positions", response_model=PositionsOut, responses=_RESPONSES)
async def analysis_positions(race: Race, deps: Deps) -> PositionsOut:
    """Position at the end of every lap per driver (finishing order), with the grid slot."""
    return await _view(deps, race, "positions", PositionsOut)


Code = Annotated[str, Query(pattern=DRIVER_CODE_PATTERN, description="three-letter driver code")]


@router.get(
    f"{_PREFIX}/compare",
    response_model=CompareOut,
    responses={
        **_RESPONSES,
        404: {"model": ErrorOut, "description": "no analysis, or a code without laps in the race"},
        422: {"description": "a or b is not a three-letter code, or a = b"},
    },
)
async def analysis_compare(race: Race, deps: Deps, a: Code, b: Code) -> CompareOut:
    """Two drivers lap by lap: lap-time delta, cumulative gap and sector deltas (``a - b``)."""
    s, r = race.season, race.round
    if a == b:
        raise HTTPException(422, "a and b must be different drivers")
    try:
        out = await deps.analysis.compare(s, r, a, b)
    except CatalogError as exc:
        log.error("analysis unavailable", extra={"view": "compare", "reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except AnalysisDataError as exc:
        log.error("analysis malformed", extra={"season": s, "round": r, "reason": str(exc)})
        raise HTTPException(500, "stored analysis is malformed") from exc
    except UnknownDriverError as exc:
        raise HTTPException(404, f"no laps for {exc} in {s} R{r}") from exc
    if out is None:
        raise HTTPException(404, f"no analysis for {s} R{r}")
    return out
