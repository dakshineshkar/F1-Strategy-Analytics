"""Display-only per-race entrants for the dashboard (Feature 1).

``EntrantsService.get`` serves ``GET /api/races/{s}/{r}/entrants``:

1. Redis ``GET meta:entrants:{s}:{r}`` (``serving.keys.entrants_meta_key``). The value is
   ``{"lake": <lake_fingerprint>, "entrants": <response>}``; a hit from the same lake that parses
   and validates is returned as it is. An entry of another lake (the api switched between the
   sample and the full lake) or a malformed one is a miss and is overwritten.
2. Otherwise the race's ``clean/entrants`` partition is read with a reader limited to that one
   table (``catalog.zone_reader``; ``file://`` with pyarrow or ``hdfs://`` with HttpFS
   ``LISTSTATUS``/``OPEN``; never ``raw``), sorted, validated and stored with
   ``SET … EX API_ENTRANTS_CACHE_S``.

The key is outside ``race:*``, so the race state, the SSE snapshots and the ``session_end`` expiry
never see it, and the 9-field driver hash is never touched. Redis is only a cache: a Redis error
is logged and the lake is read directly. A race without an entrants partition (or the sealed 2025
season without ``ALLOW_TEST_SEASON=1``) gives ``None`` (404); negative results are not cached.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Callable, Sequence
from typing import Any

import redis.asyncio as aioredis
from pydantic import ValidationError
from redis.exceptions import RedisError

from f1sa.api.catalog import LakeReader
from f1sa.api.models import EntrantOut, EntrantsOut
from f1sa.etl.entrants_reference import badge_text_colour
from f1sa.serving import keys as K
from f1sa.streaming.processor import SEALED_SEASON

log = logging.getLogger(__name__)

TABLE = "entrants"
"""``lake.schemas_entrants.TABLE`` (not imported: the API never imports pyspark; tested equal)."""
TABLES: tuple[str, ...] = (TABLE,)
"""The only table the entrants reader may open."""
COLUMNS: tuple[str, ...] = (
    "driver_id",
    "code",
    "given_name",
    "family_name",
    "car_number",
    "grid",
    "constructor_id",
    "team_name",
    "team_code",
    "team_lineage_id",
    "team_colour_hex",
    "colour_source",
    "nationality",
    "nationality_code",
)


class EntrantsDataError(RuntimeError):
    """A stored entrants row breaks the response schema."""


def grid_order(row: EntrantOut) -> tuple[int, int, int, str]:
    """Grid slots 1..N first, then pit-lane starts (0) and unknown slots, then car number."""
    on_grid = row.grid is not None and row.grid > 0
    return (
        0 if on_grid else 1,
        row.grid if on_grid and row.grid is not None else 0,
        row.car_number if row.car_number is not None else 1_000,
        row.driver_id,
    )


def to_entrants(season: int, round_: int, rows: Sequence[dict[str, Any]]) -> EntrantsOut:
    """Lake rows -> the sorted response; raises ``EntrantsDataError`` on a malformed row."""
    try:
        items = [
            EntrantOut.model_validate(
                {c: r.get(c) for c in COLUMNS}
                | {"team_text_hex": badge_text_colour(str(r.get("team_colour_hex")))}
            )
            for r in rows
        ]
    except (ValidationError, ValueError) as exc:
        raise EntrantsDataError(f"entrants {season} R{round_}: {type(exc).__name__}") from exc
    ids = [e.driver_id for e in items]
    if len(ids) != len(set(ids)):
        raise EntrantsDataError(f"entrants {season} R{round_}: duplicate driver ids")
    return EntrantsOut(season=season, round=round_, entrants=sorted(items, key=grid_order))


def lake_fingerprint(data_lake_uri: str) -> str:
    """16 hex digits of sha256(DATA_LAKE_URI): tags cache entries with the lake they came from
    (an api switched between the sample and the full lake never serves the other's rows). The URI
    itself is never stored."""
    return hashlib.sha256(data_lake_uri.encode()).hexdigest()[:16]


class EntrantsService:
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

    async def _cached(self, key: str) -> EntrantsOut | None:
        try:
            raw = await self._redis.get(key)
        except RedisError as exc:
            log.warning("entrants cache read failed", extra={"reason": type(exc).__name__})
            return None
        if raw is None:
            return None
        try:
            doc = json.loads(raw)
            if not isinstance(doc, dict) or doc.get("lake") != self.lake_id:
                return None  # written by an api on another lake (sample vs full): a miss
            return EntrantsOut.model_validate(doc.get("entrants"))
        except (ValueError, ValidationError):
            log.warning("entrants cache entry is malformed; reading the lake", extra={"key": key})
            return None

    async def _store(self, key: str, out: EntrantsOut) -> None:
        try:
            doc = {"lake": self.lake_id, "entrants": out.model_dump(mode="json")}
            await self._redis.set(key, json.dumps(doc, separators=(",", ":")), ex=self.ttl_s)
        except RedisError as exc:
            log.warning("entrants cache write failed", extra={"reason": type(exc).__name__})

    def _read_lake(self, season: int, round_: int) -> list[dict[str, Any]]:
        return self._reader_factory().read_rows(TABLE, season, round_, COLUMNS)

    async def get(self, season: int, round_: int) -> EntrantsOut | None:
        """The race's entrants, or ``None`` if the lake has none (or 2025 is sealed).

        Raises ``CatalogError`` when the lake cannot be read and ``EntrantsDataError`` when a
        stored row is malformed."""
        if season == SEALED_SEASON and not self.allow_test_season:
            return None
        key = K.entrants_meta_key(season, round_)
        hit = await self._cached(key)
        if hit is not None and (hit.season, hit.round) == (season, round_):
            return hit
        rows = await asyncio.to_thread(self._read_lake, season, round_)
        if not rows:
            return None
        out = to_entrants(season, round_, rows)
        await self._store(key, out)
        return out
