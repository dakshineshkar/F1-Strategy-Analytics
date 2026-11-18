"""``GET /api/archive`` and ``GET /api/archive/{season}/{round}``: the post-race archive (Feature
4, display only). Read-only; HTTP caching (``ETag``, ``Cache-Control: no-cache``,
``If-None-Match`` -> 304), never a Redis key."""

from __future__ import annotations

import hashlib
import json
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from f1sa.api.archive import ArchiveDataError
from f1sa.api.catalog import CatalogError
from f1sa.api.deps import Deps, Race
from f1sa.api.models import ArchiveListOut, ErrorOut
from f1sa.archive.schema import ArchiveBundle, gunzip_limited

log = logging.getLogger(__name__)
router = APIRouter(tags=["archive"])
CACHE_CONTROL = "no-cache"


def _etag_matches(request: Request, etag: str) -> bool:
    header = request.headers.get("if-none-match")
    if not header:
        return False
    tags = {t.strip().removeprefix("W/") for t in header.split(",")}
    return "*" in tags or etag in tags


def _accepts_gzip(request: Request) -> bool:
    for part in request.headers.get("accept-encoding", "").split(","):
        name, _, params = part.strip().partition(";")
        if name.strip().lower() in ("gzip", "*"):
            q = params.strip().removeprefix("q=").strip()
            try:
                return not q or float(q) > 0
            except ValueError:
                return False
    return False


@router.get(
    "/archive",
    response_model=ArchiveListOut,
    responses={
        304: {"description": "not modified (If-None-Match)"},
        500: {"model": ErrorOut, "description": "a stored manifest is malformed"},
        503: {"model": ErrorOut, "description": "archive zone unavailable"},
    },
)
async def archive_list(request: Request, deps: Deps) -> Response:
    """Every race with a post-race bundle (2025 only with ``ALLOW_TEST_SEASON=1``)."""
    try:
        out = await deps.archive.races()
    except CatalogError as exc:
        log.error("archive unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "archive zone unavailable") from exc
    except ArchiveDataError as exc:
        log.error("archive manifest malformed", extra={"reason": str(exc)})
        raise HTTPException(500, "a stored archive manifest is malformed") from exc
    body = json.dumps(out.model_dump(mode="json"), separators=(",", ":"), sort_keys=True).encode()
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _etag_matches(request, etag):
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


@router.get(
    "/archive/{season}/{round}",
    response_model=ArchiveBundle,
    responses={
        304: {"description": "not modified (If-None-Match)"},
        404: {"model": ErrorOut, "description": "no bundle for the race (or 2025 sealed)"},
        500: {"model": ErrorOut, "description": "the stored bundle is malformed"},
        503: {"model": ErrorOut, "description": "archive zone unavailable"},
    },
)
async def archive_bundle(race: Race, request: Request, deps: Deps) -> Response:
    """The race's bundle (schema v1): stored gzip with ``Content-Encoding: gzip`` when the client
    accepts it, else the JSON. ``ETag`` is the bundle's sha256."""
    s, r = race.season, race.round
    try:
        manifest = await deps.archive.manifest(s, r)
        if manifest is None:
            raise HTTPException(404, f"no post-race archive for {s} R{r}")
        etag = f'"{manifest.sha256}"'
        headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
        if _etag_matches(request, etag):
            return Response(status_code=304, headers=headers)
        stored = await deps.archive.bundle(manifest)
    except CatalogError as exc:
        log.error("archive unavailable", extra={"reason": str(exc)})
        raise HTTPException(503, "archive zone unavailable") from exc
    except ArchiveDataError as exc:
        log.error("archive bundle malformed", extra={"season": s, "round": r, "reason": str(exc)})
        raise HTTPException(500, "the stored archive bundle is malformed") from exc
    if _accepts_gzip(request):
        return Response(
            stored.gz,
            media_type="application/json",
            headers={**headers, "Content-Encoding": "gzip"},
        )
    return Response(gunzip_limited(stored.gz), media_type="application/json", headers=headers)
