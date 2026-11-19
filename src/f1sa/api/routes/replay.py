from __future__ import annotations

import logging
from collections.abc import Awaitable

from fastapi import APIRouter, Depends, HTTPException

from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race, require_replay
from f1sa.api.models import ErrorOut, ReplayIn, ReplayOut, ReplaySpeedIn, ReplayStatusOut
from f1sa.api.replay import (
    ReplayConflictError,
    ReplayJob,
    ReplayNotRunningError,
    ReplayRefusedError,
    ReplayStoreError,
)
from f1sa.streaming.processor import SEALED_SEASON

log = logging.getLogger(__name__)
router = APIRouter(tags=["replay"])


@router.post(
    "/races/{season}/{round}/replay",
    status_code=202,
    response_model=ReplayOut,
    dependencies=[Depends(require_replay)],
    responses={
        403: {"model": ErrorOut, "description": "ENABLE_REPLAY is off, or the sealed season"},
        404: {"model": ErrorOut, "description": "race not in the clean zone"},
        409: {"model": ErrorOut, "description": "already running, or the replay limit"},
        500: {"model": ErrorOut, "description": "the producer could not be started"},
        503: {
            "model": ErrorOut,
            "description": "clean zone unavailable, or the race's old keys could not be deleted",
        },
    },
)
async def start_replay(body: ReplayIn, race: Race, deps: Deps) -> ReplayOut:
    """Replay the race through the whole pipeline (stream job, then producer) in the background
    (``ENABLE_REPLAY=1``); progress and errors in ``GET /api/replays``. The race's old
    ``race:{s}:{r}:*`` keys are deleted first (only while no replay of it runs)."""
    s, r = race.season, race.round
    if s == SEALED_SEASON and not deps.settings.allow_test_season:
        raise HTTPException(403, f"season {s} is the sealed test season")
    try:
        info = await deps.catalog.get(s, r)
    except CatalogError as exc:
        log.error("race catalog unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "clean zone unavailable") from exc
    if info is None:
        raise HTTPException(404, f"{s} R{r} is not in the clean zone")
    try:
        job = await deps.replays.start(s, r, body.speed)
    except ReplayRefusedError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ReplayConflictError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ReplayStoreError as exc:
        raise HTTPException(503, str(exc)) from exc
    except OSError as exc:
        log.error("replay launch failed", extra={"season": s, "exc_class": type(exc).__name__})
        raise HTTPException(500, "the producer could not be started") from exc
    # what-if lap history from lap 1 (S15) and this run's alert history (F09): a fresh log tagged
    # with the run. Not awaited (the response is unchanged); the producer starts only after the
    # stream job's ready file, so the subscription is active before the first publish.
    deps.lap_logs.start_soon(s, r, fresh=True, run_id=job.run_id)
    return ReplayOut(**job.to_dict())


CONTROL_RESPONSES: dict[int | str, dict[str, object]] = {
    403: {"model": ErrorOut, "description": "ENABLE_REPLAY is off, or the sealed season"},
    409: {
        "model": ErrorOut,
        "description": "no replay of this race is running (or it is stopping)",
    },
    500: {"model": ErrorOut, "description": "the control file could not be written"},
}


def _sealed(race: Race, deps: Deps) -> None:
    if race.season == SEALED_SEASON and not deps.settings.allow_test_season:
        raise HTTPException(403, f"season {race.season} is the sealed test season")


async def _control(action: str, race: Race, call: Awaitable[ReplayJob]) -> ReplayOut:
    try:
        job = await call
    except ReplayNotRunningError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        log.error(
            "replay control failed",
            extra={"season": race.season, "round": race.round, "action": action},
        )
        raise HTTPException(500, "the replay control could not be written") from exc
    return ReplayOut(**job.to_dict())


@router.post(
    "/races/{season}/{round}/replay/stop",
    response_model=ReplayOut,
    dependencies=[Depends(require_replay)],
    responses=CONTROL_RESPONSES,
)
async def stop_replay(race: Race, deps: Deps) -> ReplayOut:
    """Stop the race's replay: both processes end (no ``session_end`` is published), the state
    becomes ``stopped`` with the lap reached, and the partial outputs stay in
    ``data/demo/<run_id>/``. Returns once the processes are gone."""
    _sealed(race, deps)
    return await _control("stop", race, deps.replays.stop(race.season, race.round))


@router.post(
    "/races/{season}/{round}/replay/pause",
    response_model=ReplayOut,
    dependencies=[Depends(require_replay)],
    responses=CONTROL_RESPONSES,
)
async def pause_replay(race: Race, deps: Deps) -> ReplayOut:
    """Pause the race's replay before its next event (a no-op when already paused)."""
    _sealed(race, deps)
    return await _control("pause", race, deps.replays.pause(race.season, race.round))


@router.post(
    "/races/{season}/{round}/replay/resume",
    response_model=ReplayOut,
    dependencies=[Depends(require_replay)],
    responses=CONTROL_RESPONSES,
)
async def resume_replay(race: Race, deps: Deps) -> ReplayOut:
    """Resume the race's paused replay (a no-op when it is not paused)."""
    _sealed(race, deps)
    return await _control("resume", race, deps.replays.resume(race.season, race.round))


@router.post(
    "/races/{season}/{round}/replay/speed",
    response_model=ReplayOut,
    dependencies=[Depends(require_replay)],
    responses=CONTROL_RESPONSES,
)
async def replay_speed(body: ReplaySpeedIn, race: Race, deps: Deps) -> ReplayOut:
    """Change the speed of the race's replay (1, 10 or 60); it applies before the next event and
    never changes the events themselves."""
    _sealed(race, deps)
    return await _control(
        "speed", race, deps.replays.set_speed(race.season, race.round, body.speed)
    )


@router.get("/replays", response_model=ReplayStatusOut)
async def replay_status(deps: Deps) -> ReplayStatusOut:
    """Replays holding a slot (starting, running, paused, or ended while their processes are still
    being stopped) and the last finished, stopped or failed ones (with their error or note)."""
    st = deps.replays.status()
    return ReplayStatusOut(
        enabled=deps.settings.enable_replay,
        max_running=st["max_running"],
        running=[ReplayOut(**j) for j in st["running"]],
        recent=[ReplayOut(**j) for j in st["recent"]],
    )
