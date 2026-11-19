"""F09 against the real Redis of ``make up``: the recorder's PING/PONG barrier with the API's own
client settings (redis-py's default protocol, decoded responses), and an alert published before a
page subscribes arriving in its ``snapshot-0`` exactly once."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
import redis.asyncio as aioredis

from f1sa.api.lap_log import LapLogManager
from f1sa.api.sse import RECENT_ALERTS_KEY, EventStream
from f1sa.config import Settings
from f1sa.serving import keys as K
from f1sa.serving.redis_store import AsyncRaceStore, Batch, DriverState, Event

pytestmark = [pytest.mark.integration, pytest.mark.anyio]

SEASON, ROUND = 2100, 29  # a namespace no real race uses
RUN = "2100_29_20261119T100000.000Z"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client() -> AsyncIterator[aioredis.Redis]:
    c = aioredis.Redis.from_url(Settings().redis_url, decode_responses=True)  # as api/deps.py
    await c.ping()
    pattern = f"race:{SEASON}:{ROUND}:*"
    assert [k async for k in c.scan_iter(pattern)] == [], "integration namespace is not empty"
    yield c
    keys = [k async for k in c.scan_iter(pattern)]
    if keys:
        await c.delete(*keys)
    await c.aclose()


def _alert(lap: int) -> Event:
    return Event(
        "undercut_alert",
        {
            "reason": "opportunity",
            "trigger": "new_candidate",
            "season": SEASON,
            "round": ROUND,
            "attacker_id": "bravo",
            "defender_id": "alpha",
            "decision_lap": lap,
            "gap_s": 1.0,
            "undercut_prob": 0.3,
            "threshold": 0.5,
            "inputs": {},
        },
    )


async def test_barrier_with_the_apis_client_settings(client: aioredis.Redis) -> None:
    mgr = LapLogManager(client)
    store = AsyncRaceStore(client)
    try:
        await mgr.ensure(SEASON, ROUND, fresh=True, run_id=RUN)
        await store.write_batch(SEASON, ROUND, Batch(events=tuple(_alert(n) for n in range(2, 12))))
        frames = await asyncio.wait_for(mgr.history(SEASON, ROUND), 0.9)  # under the 1 s timeout
        assert [f["payload"]["decision_lap"] for f in frames] == list(range(2, 12))
    finally:
        await mgr.aclose()


async def test_an_alert_before_the_page_subscribed_is_in_snapshot_0_once(
    client: aioredis.Redis,
) -> None:
    mgr = LapLogManager(client)
    store = AsyncRaceStore(client)
    try:
        await mgr.ensure(SEASON, ROUND, fresh=True, run_id=RUN)
        await store.write_batch(
            SEASON,
            ROUND,
            Batch(
                states={
                    "alpha": DriverState(1, None, 0.0, "HARD", 5, 95.0, False, None),
                    "bravo": DriverState(2, 1.0, 1.0, "HARD", 5, 95.0, True, 0.3),
                },
                order={"alpha": 1, "bravo": 2},
                events=(_alert(3),),
            ),
        )
        stream = EventStream(
            client, SEASON, ROUND, heartbeat_s=5, history=lambda: mgr.history(SEASON, ROUND)
        )
        frames = stream.frames()
        snap: dict[str, Any] | None = None
        try:
            async for chunk in frames:
                if chunk.startswith(b"event: snapshot"):
                    snap = json.loads(chunk.decode().split("data: ", 1)[1])
                    break
        finally:
            await frames.aclose()
        assert snap is not None
        alerts = snap[RECENT_ALERTS_KEY]
        assert [f["payload"]["decision_lap"] for f in alerts] == [3]
        assert alerts[0]["type"] == "undercut_alert" and alerts[0]["event_id"]
        channel = K.events_channel(SEASON, ROUND)
        assert (await client.pubsub_numsub(channel))[0][1] == 1  # the page unsubscribed
    finally:
        await mgr.aclose()
