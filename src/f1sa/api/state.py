"""Reading one race's full state from Redis: every driver hash and the order sorted set, in **one**
``pipeline(transaction=False)``. Used by ``GET /api/races/{s}/{r}/state`` and by the SSE stream's
``snapshot`` event. Hashes are decoded with ``serving.redis_store.decode_state`` (the contract's
inverse), so ``""`` becomes ``null`` exactly as in the REST response. The additive, display-only
tyre hashes (``race:{s}:{r}:tyre:{driverId}``) are read in the same pipeline into ``tyres``; a
malformed one is logged and left out (it never fails the state). The additive, display-only timing
hashes (``race:{s}:{r}:timing:{driverId}``, Feature 5) are read the same way into ``timing``."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from typing import Any

import redis.asyncio as aioredis

from f1sa.api.models import DriverStateOut, OrderEntry, RaceStateOut, TimingOut, TyreLifeOut
from f1sa.serving import keys as K
from f1sa.serving.redis_store import (
    SCAN_COUNT,
    StoreError,
    decode_state,
    decode_timing,
    decode_tyre,
)

log = logging.getLogger(__name__)


class StateContractError(RuntimeError):
    """A stored driver hash breaks the serving contract."""

    def __init__(self, driver_id: str, cause: Exception) -> None:
        super().__init__(f"hash of {driver_id} breaks the contract: {type(cause).__name__}")
        self.driver_id = driver_id


def _text(v: Any) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


def driver_ids_from_keys(keys: Iterable[str], season: int, round_: int) -> list[str]:
    """Driver ids of the ``race:{s}:{r}:driver:{id}`` keys among ``keys`` (others ignored)."""
    prefix = K.driver_key(season, round_, "x")[:-1]
    out: list[str] = []
    for key in keys:
        if not key.startswith(prefix):
            continue
        try:
            out.append(K.validate_driver_id(key[len(prefix) :]))
        except K.InvalidKeyError:
            log.warning(
                "ignored key outside the contract", extra={"season": season, "round": round_}
            )
    return sorted(set(out))


async def scan_race_keys(client: aioredis.Redis, season: int, round_: int) -> list[str]:
    """Every key of the race (SCAN with the race pattern, never KEYS)."""
    found: set[str] = set()
    cursor: Any = 0
    while True:
        cursor, batch = await client.scan(
            cursor=cursor, match=K.race_pattern(season, round_), count=SCAN_COUNT
        )
        found.update(_text(k) for k in batch)
        if int(cursor) == 0:
            return sorted(found)


async def read_race_state(
    client: aioredis.Redis, season: int, round_: int, driver_ids: Sequence[str]
) -> RaceStateOut:
    """HGETALL of every driver in ``driver_ids`` (driver, tyre and timing hash) plus ZRANGE
    WITHSCORES of the order, one pipeline. A hash that expired meanwhile is skipped; a driver hash
    that breaks the contract raises ``StateContractError``; a malformed tyre or timing hash is
    skipped and logged."""
    pipe = client.pipeline(transaction=False)
    for d in driver_ids:
        pipe.hgetall(K.driver_key(season, round_, d))
    for d in driver_ids:
        pipe.hgetall(K.tyre_key(season, round_, d))
    for d in driver_ids:
        pipe.hgetall(K.timing_key(season, round_, d))
    pipe.zrange(K.order_key(season, round_), 0, -1, withscores=True)
    results = await pipe.execute()
    n = len(driver_ids)
    hashes, tyre_hashes = results[:n], results[n : 2 * n]
    timing_hashes, order_rows = results[2 * n : 3 * n], results[-1]
    drivers: dict[str, DriverStateOut] = {}
    for d, raw in zip(driver_ids, hashes, strict=True):
        try:
            stored = decode_state(raw)
        except (StoreError, ValueError) as exc:
            raise StateContractError(d, exc) from exc
        if stored is not None:
            drivers[d] = DriverStateOut.from_stored(stored)
    tyres: dict[str, TyreLifeOut] = {}
    for d, raw in zip(driver_ids, tyre_hashes, strict=True):
        try:
            tyre = decode_tyre(raw)
        except (StoreError, ValueError) as exc:
            log.warning(
                "ignored a tyre hash outside the contract",
                extra={"season": season, "driver_id": d, "exc_class": type(exc).__name__},
            )
            continue
        if tyre is not None:
            tyres[d] = TyreLifeOut.from_stored(tyre)
    timing: dict[str, TimingOut] = {}
    for d, raw in zip(driver_ids, timing_hashes, strict=True):
        try:
            stored_timing = decode_timing(raw)
        except (StoreError, ValueError) as exc:
            log.warning(
                "ignored a timing hash outside the contract",
                extra={"season": season, "driver_id": d, "exc_class": type(exc).__name__},
            )
            continue
        if stored_timing is not None:
            timing[d] = TimingOut.from_stored(stored_timing)
    order: list[OrderEntry] = []
    for member, score in order_rows:
        try:
            order.append(
                OrderEntry(driver_id=K.validate_driver_id(_text(member)), position=int(score))
            )
        except K.InvalidKeyError:
            log.warning("ignored order member outside the contract", extra={"season": season})
    return RaceStateOut(
        season=season, round=round_, drivers=drivers, order=order, tyres=tyres, timing=timing
    )
