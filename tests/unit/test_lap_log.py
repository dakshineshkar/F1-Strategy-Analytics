"""The race-channel lap recorder for the what-if (``api/lap_log.py``)."""

from __future__ import annotations

import asyncio
from typing import Any

import fakeredis
import pytest

from f1sa.api.lap_log import LapLog, LapLogManager, read_published_probs
from f1sa.serving import keys as K
from f1sa.serving.redis_store import AsyncRaceStore, Batch, DriverState, Event

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _msg(kind: str, season: int = 2024, round_: int = 5, **payload: Any) -> dict[str, Any]:
    return {"type": kind, "season": season, "round": round_, "payload": payload}


def _lap(d: str, lap: int, t: float, **kw: Any) -> dict[str, Any]:
    return _msg(
        "lap",
        driver_id=d,
        lap=lap,
        race_time_s=t,
        lap_time_s=90.0,
        position=2,
        compound="SOFT",
        tyre_age=lap,
        **kw,
    )


def test_records_merge_laps_and_pit_flags() -> None:
    log = LapLog(2024, 5)
    assert log.observe(_lap("a", 1, 95.0))
    assert log.observe(_msg("pit_in", driver_id="a", lap=2, race_time_s=180.0))
    assert log.observe(_lap("a", 2, 190.0))
    assert log.observe(_msg("pit_out", driver_id="a", lap=3, race_time_s=200.0))
    assert log.observe(_lap("a", 3, 300.0))
    assert log.observe(_lap("a", 3, 300.0))  # a duplicate (SSE and subscriber) changes nothing
    recs = log.records()
    assert [(r.lap, r.pit_in, r.pit_out) for r in recs] == [
        (1, False, False),
        (2, True, False),
        (3, False, True),
    ]
    assert recs[0].compound == "SOFT" and recs[0].tyre_age == 1 and recs[0].position == 2
    assert log.latest_lap("a") == 3 and log.latest_lap("b") is None and log.messages == 6


def test_bad_and_foreign_messages_are_skipped() -> None:
    log = LapLog(2024, 5)
    bad = [
        _lap("a", 1, 95.0) | {"season": 2023},
        _msg("undercut_alert", attacker_id="a"),
        _msg("lap", driver_id="A B", lap=1, race_time_s=1.0),
        _msg("lap", driver_id="a", lap=0, race_time_s=1.0),
        _msg("lap", driver_id="a", lap=True, race_time_s=1.0),
        _msg("lap", driver_id="a", lap=1, race_time_s=float("nan")),
        {"type": "lap", "season": 2024, "round": 5, "payload": "x"},
    ]
    assert not any(log.observe(m) for m in bad)
    assert log.records() == [] and log.skipped == len(bad)
    rec = LapLog(2024, 5)
    rec.observe(_msg("lap", driver_id="a", lap=1, race_time_s=1.0, lap_time_s="x", compound=3))
    r = rec.records()[0]
    assert r.lap_time_s is None and r.compound is None and r.tyre_age is None


def test_only_the_last_laps_are_kept() -> None:
    log = LapLog(2024, 5, max_laps=3)
    for n in range(1, 7):
        log.observe(_lap("a", n, 90.0 * n))
        if n == 2:
            log.observe(_msg("pit_in", driver_id="a", lap=2, race_time_s=1.0))
    assert [r.lap for r in log.records()] == [4, 5, 6]
    assert not any(r.pit_in for r in log.records())


def test_session_end_marks_the_log_ended() -> None:
    log = LapLog(2024, 5)
    log.observe(_msg("session_end"))
    assert log.ended


async def _publish(store: AsyncRaceStore, *events: Event) -> None:
    await store.write_batch(2024, 5, Batch(events=events))


async def _until(cond: Any, timeout: float = 5.0) -> None:
    async def wait() -> None:
        while not cond():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)


async def test_subscriber_records_the_channel_and_stops_on_session_end() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis)
    log = await mgr.ensure(2024, 5)
    assert mgr.running() == [(2024, 5)]
    await _publish(
        store, Event("lap", {"driver_id": "a", "lap": 1, "race_time_s": 95.0, "lap_time_s": 95.0})
    )
    await _until(lambda: log.latest_lap("a") == 1)
    await redis.publish(K.events_channel(2024, 5), "not json")
    await _publish(store, Event("session_end", {}))
    await _until(lambda: log.ended)
    await _until(lambda: mgr.running() == [])
    assert (await redis.pubsub_numsub(K.events_channel(2024, 5)))[0][1] == 0
    assert mgr.get(2024, 5) is log and log.skipped == 1
    assert mgr.start_soon(2024, 5) is log and mgr.running() == []  # an ended log is not restarted
    fresh = mgr.start_soon(2024, 5, fresh=True)
    assert fresh is not log and not fresh.ended
    await mgr.aclose()
    assert mgr.running() == [] and mgr.get(2024, 5) is None


async def test_attach_does_not_subscribe() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    mgr = LapLogManager(redis)
    log = mgr.attach(2024, 5)
    assert mgr.running() == [] and mgr.attach(2024, 5) is log
    assert (await redis.pubsub_numsub(K.events_channel(2024, 5)))[0][1] == 0


async def test_lru_eviction_and_idle_expiry() -> None:
    now = [0.0]
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    mgr = LapLogManager(redis, max_races=2, idle_s=100.0, clock=lambda: now[0])
    for r in (1, 2):
        await mgr.ensure(2024, r)
        now[0] += 1
    await mgr.ensure(2024, 3)
    assert mgr.get(2024, 1) is None and mgr.running() == [(2024, 2), (2024, 3)]
    now[0] += 1000
    mgr.attach(2024, 4)
    assert mgr.get(2024, 2) is None and mgr.get(2024, 3) is None
    await mgr.aclose()


# ------------------------------------------------------------------ engineer view additions
def test_lap_rows_carry_the_tyre_life_and_records_stay_unchanged() -> None:
    log = LapLog(2024, 5)
    log.observe(_lap("a", 1, 95.0, tyre_life_laps=4, tyre_life_at_start_laps=3))
    log.observe(_msg("pit_out", driver_id="a", lap=2, race_time_s=190.0))
    log.observe(_lap("a", 2, 190.0))
    rows = log.lap_rows()
    assert [(r.lap, r.tyre_life_laps, r.tyre_life_at_start_laps, r.pit_out) for r in rows] == [
        (1, 4, 3, False),
        (2, None, None, True),
    ]
    recs = log.records()  # the what-if's input: no new fields
    assert set(recs[0].__dataclass_fields__) == {
        "driver_id", "lap", "race_time_s", "lap_time_s", "position", "compound", "tyre_age",
        "pit_in", "pit_out",
    }  # fmt: skip


def test_new_leader_laps_and_recorded_probs() -> None:
    log = LapLog(2024, 5, max_laps=2)
    log.observe(_lap("a", 1, 95.0))
    log.observe(_lap("b", 1, 96.0))
    log.observe(_lap("a", 2, 190.0))
    assert log.max_lap == 2 and log.take_new_laps() == [1, 2] and log.take_new_laps() == []
    for n in (1, 2, 3):
        log.set_probs(n, {"a": (True, 0.1 * n)})
    assert log.probs_at(1) is None  # beyond max_laps
    assert log.probs_at(3) == {"a": (True, 0.30000000000000004)}
    assert log.probs_at(9) is None


async def test_read_published_probs_is_read_only() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    states = {
        "a": DriverState(1, None, None, "SOFT", 3, 90.0, False, None),
        "b": DriverState(2, 1.0, 1.0, "SOFT", 3, 90.0, True, 0.64),
    }
    await store.write_batch(2024, 5, Batch(states=states, order={"a": 1, "b": 2}))
    before = {k: await redis.hgetall(k) for k in await redis.keys("race:*:driver:*")}
    probs = await read_published_probs(redis, 2024, 5)
    assert probs == {"a": (False, None), "b": (True, 0.64)}
    assert {k: await redis.hgetall(k) for k in await redis.keys("race:*:driver:*")} == before
    assert await read_published_probs(redis, 2024, 6) == {}


async def test_the_subscriber_snapshots_probs_when_the_leader_completes_a_lap() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis)
    log = await mgr.ensure(2024, 5)
    s = {"a": DriverState(1, None, None, "SOFT", 3, 90.0, True, 0.55)}
    await store.write_batch(2024, 5, Batch(states=s, order={"a": 1}))
    await _publish(
        store, Event("lap", {"driver_id": "a", "lap": 1, "race_time_s": 95.0, "lap_time_s": 95.0})
    )
    await _until(lambda: log.probs_at(1) is not None)
    assert log.probs_at(1) == {"a": (True, 0.55)}
    await mgr.aclose()
