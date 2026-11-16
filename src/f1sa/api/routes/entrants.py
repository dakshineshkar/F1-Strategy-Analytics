"""``GET /api/races/{season}/{round}/entrants``: the display-only per-race entrants (Feature 1)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race
from f1sa.api.entrants import EntrantsDataError
from f1sa.api.models import EntrantsOut, ErrorOut

log = logging.getLogger(__name__)
router = APIRouter(tags=["races"])


@router.get(
    "/races/{season}/{round}/entrants",
    response_model=EntrantsOut,
    responses={
        404: {"model": ErrorOut, "description": "the race has no entrants in the lake"},
        500: {"model": ErrorOut, "description": "a stored entrants row is malformed"},
        503: {"model": ErrorOut, "description": "clean zone unavailable"},
    },
)
async def race_entrants(race: Race, deps: Deps) -> EntrantsOut:
    """Driver, car number, team name, badge code and colour (with its source) and nationality
    code of every entrant, sorted by grid. Read-only; cached in Redis under
    ``meta:entrants:{s}:{r}`` (never a ``race:*`` key). 2025 only with ``ALLOW_TEST_SEASON=1``."""
    s, r = race.season, race.round
    try:
        out = await deps.entrants.get(s, r)
    except CatalogError as exc:
        log.error("entrants unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    except EntrantsDataError as exc:
        log.error("entrants malformed", extra={"season": s, "round": r, "reason": str(exc)})
        raise HTTPException(500, "stored entrants are malformed") from exc
    if out is None:
        raise HTTPException(404, f"no entrants for {s} R{r}")
    return out
