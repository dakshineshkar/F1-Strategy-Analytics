"""F09 (additive): the alert history the connect snapshot carries (``recent_alerts``).

The API's race-channel recorder (``api/lap_log.py``) keeps the current API replay run's
``undercut_alert`` frames with the ids the SSE stream gives them; ``snapshot-0`` sends the newest
50 of them, oldest first. Every pre-existing snapshot field keeps its name and value."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import fakeredis
import pytest
from _api_fixtures import (
    ApiHarness,
    FakeLauncher,
    make_api,
    make_settings,
    parse_sse,
    settle,
    write_file_lake,
)

from f1sa.api.lap_log import MAX_ALERTS, RECENT_ALERTS, LapLog, LapLogManager, _pong_token
from f1sa.api.sse import RECENT_ALERTS_KEY, EventStream, event_id_for
from f1sa.serving import keys as K
from f1sa.serving.redis_store import AsyncRaceStore, Batch, DriverState, Event

pytestmark = pytest.mark.anyio

RUN = "2024_5_20261119T100000.000Z"
CHANNEL = K.events_channel(2024, 5)
PRE_F09_SNAPSHOT_KEYS = {
    "type",
    "season",
    "round",
    "lap",
    "drivers",
    "order",
    "tyres",
    "timing",
    "event_id",
    "sse_sent_at_ms",
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _alert_payload(att: str, dfn: str, lap: int, **kw: Any) -> dict[str, Any]:
    return {
        "reason": "opportunity",
        "trigger": "new_candidate",
        "season": 2024,
        "round": 5,
        "attacker_id": att,
        "defender_id": dfn,
        "decision_lap": lap,
        "gap_s": 1.2,
        "undercut_prob": 0.31,
        "threshold": 0.5,
        "inputs": {},
        **kw,
    }


def _alert_msg(att: str, dfn: str, lap: int, season: int = 2024, round_: int = 5) -> dict[str, Any]:
    return {
        "type": "undercut_alert",
        "season": season,
        "round": round_,
        "event_ts": None,
        "published_at": f"2026-11-19T10:00:{lap:02d}.000Z",
        "payload": _alert_payload(att, dfn, lap),
    }


def _raw(msg: dict[str, Any]) -> str:
    return json.dumps(msg, separators=(",", ":"), sort_keys=True)


# ------------------------------------------------------------------ LapLog (pure)
def test_alerts_are_recorded_once_per_id_in_the_live_frame_shape() -> None:
    log = LapLog(2024, 5)
    m1, m2 = _alert_msg("bravo", "alpha", 3), _alert_msg("charlie", "bravo", 4)
    id1, id2 = event_id_for(_raw(m1), m1), event_id_for(_raw(m2), m2)
    assert log.observe(m1, id1) and log.observe(m2, id2)
    # the SSE path: the frame it sent (with its event_id and sse_sent_at_ms) is the same alert
    assert log.observe({**m1, "event_id": id1, "sse_sent_at_ms": 5})
    assert log.alert_count == 2
    frames = log.recent_alerts()
    assert [f["event_id"] for f in frames] == [id1, id2]  # oldest first
    for f, m in zip(frames, (m1, m2), strict=True):
        assert set(f) == set(m) | {"event_id", "sse_sent_at_ms"}
        assert {k: f[k] for k in m} == m and isinstance(f["sse_sent_at_ms"], int)
    assert log.recent_alerts(1) == [frames[1]] and log.recent_alerts(0) == []
    log.recent_alerts()[0]["payload"] = "changed"  # copies
    assert log.recent_alerts()[0]["payload"] == m1["payload"]
    assert log.records() == []  # alerts never become laps


def test_bad_and_foreign_alerts_are_skipped() -> None:
    log = LapLog(2024, 5)
    good = _alert_msg("bravo", "alpha", 3)
    bad: list[tuple[dict[str, Any], str | None]] = [
        (good, None),  # no id
        (_alert_msg("bravo", "alpha", 3, season=2023), "x1"),
        (_alert_msg("bravo", "alpha", 3, round_=6), "x2"),
        ({**good, "payload": _alert_payload("bravo", "bravo", 3)}, "x3"),
        ({**good, "payload": _alert_payload("A B", "alpha", 3)}, "x4"),
        ({**good, "payload": _alert_payload("bravo", "alpha", 0)}, "x5"),
        ({**good, "payload": _alert_payload("bravo", "alpha", 3, reason="other")}, "x6"),
        ({**good, "payload": "x"}, "x7"),
    ]
    assert not any(log.observe(m, eid) for m, eid in bad)
    assert log.alert_count == 0 and log.skipped == len(bad)


def test_the_alert_store_is_capped() -> None:
    log = LapLog(2024, 5, max_alerts=3)
    ids = [str(uuid.uuid4()) for _ in range(5)]
    for i, eid in enumerate(ids):
        log.observe(_alert_msg("bravo", "alpha", i + 1), eid)
    assert [f["event_id"] for f in log.recent_alerts()] == ids[2:]
    assert MAX_ALERTS >= 1000 and RECENT_ALERTS == 50


def test_pong_token_reads_both_protocols() -> None:
    assert _pong_token("tok") == "tok" and _pong_token(b"tok") == "tok"
    assert _pong_token(["pong", "tok"]) == "tok" and _pong_token([b"pong", b"tok"]) == "tok"
    assert _pong_token(["message", "c", "x"]) is None and _pong_token(None) is None


# ------------------------------------------------------------------ LapLogManager
async def _until(cond: Any, timeout: float = 5.0) -> None:
    async def wait() -> None:
        while not cond():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)


async def test_history_only_for_an_api_replay_run_and_reset_per_run() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis)
    assert await mgr.history(2024, 5) == []  # no log
    log = await mgr.ensure(2024, 5)  # a what-if / engineer subscriber: no run
    await store.write_batch(
        2024, 5, Batch(events=(Event("undercut_alert", _alert_payload("b", "a", 2)),))
    )
    await _until(lambda: log.alert_count == 1)
    assert await mgr.history(2024, 5) == [], "only a log started by an API replay serves history"

    run = await mgr.ensure(2024, 5, fresh=True, run_id=RUN)
    assert run is not log and run.run_id == RUN and run.alert_count == 0
    await store.write_batch(
        2024, 5, Batch(events=(Event("undercut_alert", _alert_payload("c", "b", 3)),))
    )
    await _until(lambda: run.alert_count == 1)
    frames = await mgr.history(2024, 5)
    assert [f["payload"]["attacker_id"] for f in frames] == ["c"]
    assert mgr.start_soon(2024, 5).run_id == RUN  # a later non-fresh use keeps the run

    nxt = await mgr.ensure(2024, 5, fresh=True, run_id="2024_5_20261119T110000.000Z")
    assert nxt.alert_count == 0 and await mgr.history(2024, 5) == []
    await mgr.aclose()


async def test_the_barrier_records_what_was_published_before_the_call() -> None:
    """No waiting between the PUBLISH and history(): the PING/PONG on the subscriber's own
    connection makes the recorder read every earlier message first."""
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis)
    await mgr.ensure(2024, 5, fresh=True, run_id=RUN)
    events = tuple(Event("undercut_alert", _alert_payload("c", "b", n)) for n in range(2, 7))
    await store.write_batch(2024, 5, Batch(events=events))
    frames = await mgr.history(2024, 5)
    assert [f["payload"]["decision_lap"] for f in frames] == [2, 3, 4, 5, 6]
    await mgr.aclose()


async def test_history_without_a_running_subscriber_returns_what_was_recorded() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis)
    log = await mgr.ensure(2024, 5, fresh=True, run_id=RUN)
    await store.write_batch(
        2024, 5, Batch(events=(Event("undercut_alert", _alert_payload("c", "b", 2)),))
    )
    await store.end_session(2024, 5)
    await _until(lambda: log.ended and mgr.running() == [])
    assert [f["payload"]["decision_lap"] for f in await mgr.history(2024, 5)] == [2]
    await mgr.aclose()


async def test_a_race_that_still_receives_messages_is_not_idle() -> None:
    now = [0.0]
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    store = AsyncRaceStore(redis)
    mgr = LapLogManager(redis, idle_s=100.0, clock=lambda: now[0])
    log = await mgr.ensure(2024, 5, fresh=True, run_id=RUN)
    now[0] = 1000.0
    await store.write_batch(
        2024, 5, Batch(events=(Event("undercut_alert", _alert_payload("c", "b", 2)),))
    )
    await _until(lambda: log.alert_count == 1)
    now[0] = 1050.0
    mgr.attach(2024, 6)  # sweeps races idle for more than 100 s
    assert mgr.get(2024, 5) is log
    now[0] = 1200.0
    mgr.attach(2024, 7)
    assert mgr.get(2024, 5) is None  # no message for 200 s: idle
    await mgr.aclose()


# ------------------------------------------------------------------ the connect snapshot
def _state(pos: int, flag: bool = False) -> DriverState:
    return DriverState(
        pos, None if pos == 1 else 1.0, 0.0 if pos == 1 else float(pos), "HARD", 5, 95.0, flag, None
    )


async def _seed(redis: fakeredis.FakeAsyncRedis) -> None:
    await AsyncRaceStore(redis).write_batch(
        2024,
        5,
        Batch(
            states={"alpha": _state(1), "bravo": _state(2, True)},
            order={"alpha": 1, "bravo": 2},
        ),
    )


async def _first_snapshot(stream: EventStream) -> dict[str, Any]:
    frames = stream.frames()
    try:
        async for chunk in frames:
            for f in parse_sse(chunk.decode()):
                if f.get("event") == "snapshot":
                    return f["data"]  # type: ignore[no-any-return]
    finally:
        await frames.aclose()
    raise AssertionError("no snapshot")


async def test_snapshot_0_carries_recent_alerts_and_keeps_every_other_field() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    await _seed(redis)
    frames = [
        {**_alert_msg("bravo", "alpha", n), "event_id": f"id-{n}", "sse_sent_at_ms": n}
        for n in range(1, 61)
    ]

    async def history() -> list[dict[str, Any]]:
        return frames[-RECENT_ALERTS:]

    clock = lambda: 1234  # noqa: E731
    with_h = await _first_snapshot(
        EventStream(redis, 2024, 5, heartbeat_s=5, history=history, clock_ms=clock)
    )
    without = await _first_snapshot(EventStream(redis, 2024, 5, heartbeat_s=5, clock_ms=clock))
    # contract: the pre-existing keys and values are identical with and without the history
    assert set(without) == PRE_F09_SNAPSHOT_KEYS
    assert set(with_h) == PRE_F09_SNAPSHOT_KEYS | {RECENT_ALERTS_KEY}
    assert {k: with_h[k] for k in PRE_F09_SNAPSHOT_KEYS} == without
    assert without["event_id"] == "snapshot-0" and without["lap"] == 0
    got = with_h[RECENT_ALERTS_KEY]
    assert [f["event_id"] for f in got] == [
        f"id-{n}" for n in range(11, 61)
    ]  # newest 50, oldest first
    assert got == frames[-50:]


async def test_snapshot_0_history_is_empty_without_race_state_and_filters_other_races() -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    stale = [{**_alert_msg("bravo", "alpha", 3), "event_id": "old", "sse_sent_at_ms": 1}]

    async def history() -> list[dict[str, Any]]:
        other = {**_alert_msg("bravo", "alpha", 4, round_=6), "event_id": "x", "sse_sent_at_ms": 1}
        return [*stale, other]

    empty = await _first_snapshot(EventStream(redis, 2024, 5, heartbeat_s=5, history=history))
    assert empty["drivers"] == {} and empty[RECENT_ALERTS_KEY] == []  # cleared or expired race
    await _seed(redis)
    full = await _first_snapshot(EventStream(redis, 2024, 5, heartbeat_s=5, history=history))
    assert [f["event_id"] for f in full[RECENT_ALERTS_KEY]] == ["old"]


async def test_a_history_error_gives_an_empty_list_not_a_lost_snapshot() -> None:
    from redis.exceptions import ConnectionError as RedisConnectionError

    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    await _seed(redis)

    async def history() -> list[dict[str, Any]]:
        raise RedisConnectionError("down")

    snap = await _first_snapshot(EventStream(redis, 2024, 5, heartbeat_s=5, history=history))
    assert snap[RECENT_ALERTS_KEY] == [] and sorted(snap["drivers"]) == ["alpha", "bravo"]


# ------------------------------------------------------------------ through the API
def _api(tmp_path: Path, launcher: FakeLauncher | None = None) -> ApiHarness:
    write_file_lake(tmp_path / "lake")
    api = make_api(make_settings(tmp_path, enable_replay=True), launcher=launcher)
    api.deps.replays._clock = lambda: datetime(2026, 11, 19, 10, 0, tzinfo=UTC)
    return api


async def test_a_replay_start_tags_a_fresh_log_with_its_run(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    old = api.deps.lap_logs.attach(2024, 5)
    async with api.client() as c:
        resp = await c.post("/api/races/2024/5/replay", json={"speed": 60})
    assert resp.status_code == 202
    log = api.deps.lap_logs.get(2024, 5)
    assert log is not None and log is not old and log.run_id == resp.json()["run_id"] == RUN
    await _until(lambda: api.deps.lap_logs.running() == [(2024, 5)])
    async with api.client() as c:
        await c.post("/api/races/2024/5/replay/stop")
    await settle(api)
    await api.deps.lap_logs.aclose()


async def test_late_join_gets_the_runs_earlier_alerts_once_and_the_live_ones_after(
    tmp_path: Path,
) -> None:
    """End to end on the API: alerts published before the page connects arrive in snapshot-0 (with
    the ids the live stream uses); an alert after it arrives live only; nothing twice."""
    api = _api(tmp_path)
    store = AsyncRaceStore(api.redis, api.deps.settings)
    await api.deps.lap_logs.ensure(2024, 5, fresh=True, run_id=RUN)
    await store.write_batch(
        2024,
        5,
        Batch(
            states={"alpha": _state(1), "bravo": _state(2, True), "charlie": _state(3, True)},
            order={"alpha": 1, "bravo": 2, "charlie": 3},
            events=(
                Event("undercut_alert", _alert_payload("bravo", "alpha", 3)),
                Event("undercut_alert", _alert_payload("charlie", "bravo", 4)),
            ),
        ),
    )

    async def numsub() -> int:
        return int((await api.redis.pubsub_numsub(CHANNEL))[0][1])

    async def publisher() -> None:
        while await numsub() < 2:  # the recorder and this page
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.05)
        await store.write_batch(
            2024, 5, Batch(events=(Event("undercut_alert", _alert_payload("charlie", "bravo", 5)),))
        )
        await store.end_session(2024, 5)

    async with api.client() as c:
        resp, _ = await asyncio.wait_for(
            asyncio.gather(c.get("/api/races/2024/5/events"), publisher()), 10
        )
    frames = [f for f in parse_sse(resp.text) if "event" in f]
    snap0 = frames[0]["data"]
    assert frames[0]["id"] == "snapshot-0"
    history = snap0[RECENT_ALERTS_KEY]
    assert [f["payload"]["decision_lap"] for f in history] == [3, 4]
    live = [f for f in frames if f["event"] == "undercut_alert"]
    assert [f["data"]["payload"]["decision_lap"] for f in live] == [5]
    ids = [f["event_id"] for f in history] + [f["id"] for f in live]
    assert len(ids) == len(set(ids)) == 3
    # a history frame has the live frame's shape: the stored message + event_id + sse_sent_at_ms
    assert set(history[0]) == set(live[0]["data"])
    for f in history:
        raw = {k: v for k, v in f.items() if k not in ("event_id", "sse_sent_at_ms")}
        assert raw["type"] == "undercut_alert" and (raw["season"], raw["round"]) == (2024, 5)
    await api.deps.lap_logs.aclose()
