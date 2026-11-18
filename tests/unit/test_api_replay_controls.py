"""Replay controls (Feature 7): ``POST /api/races/{s}/{r}/replay/{stop,pause,resume,speed}``, the
state machine behind them (starting, running, paused, stopped, finished, failed), the control
and progress files, the pause cap, the stream job's backstop, the fresh start (DEL of the race's
old keys, approved 2026-11-18) and that a stop leaves no process behind."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path

import psutil
import pytest
from _api_fixtures import (
    ApiHarness,
    FakeLauncher,
    FakeProcess,
    make_api,
    make_settings,
    settle,
    write_file_lake,
)

from f1sa.api.replay import (
    CONTROL_FILE,
    PROGRESS_FILE,
    ProcessLike,
    ReplayManager,
    ReplayNotRunningError,
    ReplayStoreError,
    producer_argv,
    stream_job_argv,
    subprocess_launcher,
)
from f1sa.serving import keys as K
from f1sa.streaming.producer import ReplayProgress, parse_control, write_json_atomic

pytestmark = pytest.mark.anyio

T0 = datetime(2026, 11, 18, 9, 0, 0, 250000, tzinfo=UTC)
RID = "2024_5_20261118T090000.250Z"
ACTIONS = ("stop", "pause", "resume", "speed")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _api(tmp_path: Path, launcher: FakeLauncher | None = None, **overrides: object) -> ApiHarness:
    write_file_lake(tmp_path / "lake")
    settings = make_settings(tmp_path, **{"enable_replay": True, **overrides})
    api = make_api(settings, launcher=launcher)
    api.deps.replays._clock = lambda: T0
    api.deps.replays.poll_s = 0.01
    return api


async def _post(api: ApiHarness, path: str, body: object = None) -> tuple[int, dict]:  # type: ignore[type-arg]
    async with api.client() as c:
        if body is None:
            resp = await c.post(f"/api/races/{path}")
        else:
            resp = await c.post(f"/api/races/{path}", json=body)
    return resp.status_code, resp.json()


async def _start(api: ApiHarness, speed: int = 60, race: str = "2024/5") -> dict:  # type: ignore[type-arg]
    code, body = await _post(api, f"{race}/replay", {"speed": speed})
    assert code == 202, body
    return body


async def _control(api: ApiHarness, action: str, race: str = "2024/5") -> tuple[int, dict]:  # type: ignore[type-arg]
    body = {"speed": 10} if action == "speed" else None
    return await _post(api, f"{race}/replay/{action}", body)


async def _status(api: ApiHarness) -> dict:  # type: ignore[type-arg]
    async with api.client() as c:
        resp = await c.get("/api/replays")
    assert resp.status_code == 200
    body: dict = resp.json()  # type: ignore[type-arg]
    return body


async def _until(pred: Callable[[], bool], timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not pred():
        assert time.monotonic() < deadline, "condition not reached in time"
        await asyncio.sleep(0.01)


def _control_doc(tmp_path: Path, rid: str = RID) -> dict:  # type: ignore[type-arg]
    return json.loads((tmp_path / "data" / "demo" / rid / CONTROL_FILE).read_text())


def _write_progress(tmp_path: Path, lap: int, sent: int, rid: str = RID) -> None:
    progress = ReplayProgress(lap, sent, 100.0 * lap, False, 60.0, 0)
    write_json_atomic(tmp_path / "data" / "demo" / rid / PROGRESS_FILE, progress.to_json())


# ------------------------------------------------------------------ flags, 409, 422, 403
@pytest.mark.parametrize("action", ACTIONS)
async def test_controls_are_403_when_replay_is_disabled(tmp_path: Path, action: str) -> None:
    api = _api(tmp_path, enable_replay=False)
    code, body = await _control(api, action)
    assert code == 403 and body == {"detail": "replay is disabled (set ENABLE_REPLAY=1)"}


@pytest.mark.parametrize("action", ACTIONS)
async def test_controls_are_409_when_no_replay_of_the_race_runs(
    tmp_path: Path, action: str
) -> None:
    api = _api(tmp_path, FakeLauncher(hold_producer=True))
    code, body = await _control(api, action)
    assert code == 409 and body["detail"] == "no replay of 2024 R5 is running"
    await _start(api, race="2023/5")  # another race runs: still 409 for 2024 R5
    code, body = await _control(api, action)
    assert code == 409 and body["detail"] == "no replay of 2024 R5 is running"
    await api.deps.replays.shutdown()


@pytest.mark.parametrize("action", ACTIONS)
async def test_controls_refuse_the_sealed_season(tmp_path: Path, action: str) -> None:
    api = _api(tmp_path)
    code, body = await _control(api, action, race="2025/1")
    assert code == 403 and body["detail"] == "season 2025 is the sealed test season"


@pytest.mark.parametrize(
    "body", [{"speed": 5}, {"speed": "10"}, {}, {"speed": 10, "extra": 1}, {"speed": None}]
)
async def test_speed_is_422_for_a_bad_body(tmp_path: Path, body: dict[str, object]) -> None:
    api = _api(tmp_path, FakeLauncher(hold_producer=True))
    await _start(api)
    code, _ = await _post(api, "2024/5/replay/speed", body)
    assert code == 422
    assert _control_doc(tmp_path)["version"] == 0  # nothing written
    await api.deps.replays.shutdown()


@pytest.mark.parametrize("action", ACTIONS)
async def test_controls_are_422_for_a_bad_path(tmp_path: Path, action: str) -> None:
    api = _api(tmp_path)
    code, _ = await _control(api, action, race="2024/0")
    assert code == 422


# ------------------------------------------------------------------ pause, resume, speed
async def test_pause_resume_and_speed_write_the_control_file(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    started = await _start(api, speed=1)
    assert started["paused"] is False and started["lap"] is None
    assert started["updated_at"] == "2026-11-18T09:00:00.250Z" and started["running_at"] is None
    assert _control_doc(tmp_path) == {"version": 0, "speed": 1.0, "paused": False}
    await _until(lambda: bool(launcher.of("producer")))
    _write_progress(tmp_path, lap=7, sent=140)
    await _until(lambda: api.deps.replays.jobs[(2024, 5)].lap == 7)

    code, body = await _control(api, "pause")
    assert code == 200
    assert (body["state"], body["paused"], body["lap"], body["events_sent"]) == (
        "paused",
        True,
        7,
        140,
    )
    assert body["paused_at"] == "2026-11-18T09:00:00.250Z"
    assert _control_doc(tmp_path) == {"version": 1, "speed": 1.0, "paused": True}
    again = await _control(api, "pause")
    assert again[0] == 200 and again[1]["state"] == "paused"
    assert _control_doc(tmp_path)["version"] == 1  # idempotent: nothing rewritten

    code, body = await _control(api, "speed")  # speed while paused: stays paused
    assert code == 200 and (body["speed"], body["state"]) == (10, "paused")
    assert _control_doc(tmp_path) == {"version": 2, "speed": 10.0, "paused": True}
    same = await _post(api, "2024/5/replay/speed", {"speed": 10})
    assert same[0] == 200 and _control_doc(tmp_path)["version"] == 2  # unchanged: no write

    code, body = await _control(api, "resume")
    assert code == 200 and (body["state"], body["paused"], body["paused_at"]) == (
        "running",
        False,
        None,
    )
    assert _control_doc(tmp_path) == {"version": 3, "speed": 10.0, "paused": False}
    assert (await _control(api, "resume"))[1]["state"] == "running"  # idempotent
    assert _control_doc(tmp_path)["version"] == 3

    status = await _status(api)
    assert [(j["state"], j["speed"], j["lap"]) for j in status["running"]] == [("running", 10, 7)]
    launcher.end_producer(launcher.of("producer")[0], 0)
    await settle(api)
    last = (await _status(api))["recent"][0]
    assert (last["state"], last["speed"], last["error"], last["note"]) == (
        "finished",
        10,
        None,
        None,
    )


async def test_a_pause_while_starting_starts_the_producer_paused(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True, stream_ready=False)
    api = _api(tmp_path, launcher)
    await _start(api)
    code, body = await _control(api, "pause")
    assert code == 200 and (body["state"], body["paused"]) == ("starting", True)
    speed = await _post(api, "2024/5/replay/speed", {"speed": 1})
    assert speed[0] == 200 and speed[1]["speed"] == 1
    ready = Path(launcher.of("stream_job")[0].arg("--ready-file"))
    ready.write_text("q\n")
    await _until(lambda: bool(launcher.of("producer")))
    job = api.deps.replays.jobs[(2024, 5)]
    assert job.state == "paused" and job.running_at is not None
    assert parse_control((job.results_dir / CONTROL_FILE).read_text()).paused is True
    assert "--control-file" in launcher.of("producer")[0].argv
    resumed = await _control(api, "resume")
    assert resumed[1]["state"] == "running"
    await api.deps.replays.shutdown()


async def test_a_failed_control_write_is_500_and_changes_nothing(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    job = api.deps.replays.jobs[(2024, 5)]
    (job.results_dir / CONTROL_FILE).unlink()
    (job.results_dir / CONTROL_FILE).mkdir()  # os.replace onto a directory fails
    code, body = await _control(api, "pause")
    assert code == 500 and body["detail"] == "the replay control could not be written"
    assert (job.state, job.paused, job.control_version) == ("running", False, 0)
    await api.deps.replays.shutdown()


# ------------------------------------------------------------------ stop
async def test_stop_while_running_records_the_lap_and_frees_the_slot(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    _write_progress(tmp_path, lap=15, sent=301)
    code, body = await _control(api, "stop")
    assert code == 200
    assert (body["state"], body["lap"], body["events_sent"]) == ("stopped", 15, 301)
    assert (body["error"], body["note"]) == (None, None)
    assert body["ended_at"] == "2026-11-18T09:00:00.250Z"
    assert all(p.terminated and p.group_swept for p in launcher.processes)
    assert len(launcher.processes) == 2
    status = await _status(api)
    assert status["running"] == [] and status["recent"][0]["state"] == "stopped"
    assert (tmp_path / "data" / "demo" / RID / PROGRESS_FILE).is_file()  # partial outputs stay
    assert (await _control(api, "stop"))[0] == 409  # nothing runs any more


async def test_stop_while_starting_never_launches_the_producer(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True, stream_ready=False)
    api = _api(tmp_path, launcher)
    await _start(api)
    code, body = await _control(api, "stop")
    assert code == 200 and (body["state"], body["lap"]) == ("stopped", None)
    assert launcher.of("producer") == []
    stream = launcher.of("stream_job")[0]
    assert stream.terminated and stream.group_swept


async def test_stop_while_paused(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    await _control(api, "pause")
    code, body = await _control(api, "stop")
    assert code == 200 and (body["state"], body["paused"]) == ("stopped", True)
    assert all(p.group_swept for p in launcher.processes)


async def test_stop_while_the_stream_job_drains_after_the_producer(tmp_path: Path) -> None:
    launcher = FakeLauncher(auto_end=False)  # the producer exits 0, the stream job keeps going
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    code, body = await _control(api, "stop")
    assert code == 200 and body["state"] == "stopped" and body["producer_returncode"] == 0
    assert launcher.of("stream_job")[0].terminated


async def test_two_stops_at_once_both_return_the_stopped_run(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    a, b = await asyncio.gather(_control(api, "stop"), _control(api, "stop"))
    assert {a[0], b[0]} <= {200, 409}
    assert any(r[0] == 200 and r[1]["state"] == "stopped" for r in (a, b))
    assert (await _status(api))["running"] == []


async def test_controls_are_refused_while_a_stop_is_under_way(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True, stream_ignores_term=True)
    api = _api(tmp_path, launcher)
    api.deps.replays.grace_s = 0.5
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    stopping = asyncio.create_task(api.deps.replays.stop(2024, 5))
    await _until(lambda: api.deps.replays.jobs[(2024, 5)].stop_reason is not None)
    for action in ("pause", "resume", "speed"):
        code, body = await _control(api, action)
        assert code == 409 and body["detail"] == "the replay of 2024 R5 is stopping"
    job = await stopping
    assert job.state == "stopped" and launcher.of("stream_job")[0].killed


async def test_a_new_replay_after_a_stop_starts_fresh(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    await _control(api, "stop")
    api.deps.replays._clock = lambda: datetime(2026, 11, 18, 9, 5, tzinfo=UTC)
    second = await _start(api, speed=10)
    assert second["run_id"] != RID and second["state"] == "starting" and second["lap"] is None
    await _until(lambda: len(launcher.of("producer")) == 2)
    assert launcher.of("stream_job")[1].arg("--checkpoint") != launcher.of("stream_job")[0].arg(
        "--checkpoint"
    )
    launcher.end_producer(launcher.of("producer")[1], 0)
    await settle(api)
    states = [j["state"] for j in (await _status(api))["recent"]]
    assert states == ["finished", "stopped"]


async def test_the_pause_cap_stops_the_replay_with_a_note(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher, api_replay_max_pause_s=0.2)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    await _control(api, "pause")
    await settle(api)
    last = (await _status(api))["recent"][0]
    assert (last["state"], last["note"], last["error"]) == (
        "stopped",
        "paused longer than 0.2 s",
        None,
    )
    assert all(p.group_swept for p in launcher.processes)


async def test_pauses_add_up_towards_the_cap(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher, api_replay_max_pause_s=0.3)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    for _ in range(2):
        await _control(api, "pause")
        await asyncio.sleep(0.12)
        await _control(api, "resume")
    job = api.deps.replays.jobs[(2024, 5)]
    assert job.state == "running" and 0.2 < job.pause_total_s < 0.3
    await _control(api, "pause")
    await settle(api)
    assert job.state == "stopped" and job.note == "paused longer than 0.3 s"


async def test_shutdown_while_paused_is_a_failure_like_before(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    await _control(api, "pause")
    await api.deps.replays.shutdown()
    last = api.deps.replays.status()["recent"][0]
    assert last["state"] == "failed" and last["error"].startswith("API shutdown")


# ------------------------------------------------------------------ fresh start (DEL)
async def _seed(api: ApiHarness) -> tuple[list[str], list[str]]:
    own = [
        K.driver_key(2024, 5, "norris"),
        K.tyre_key(2024, 5, "norris"),
        K.timing_key(2024, 5, "norris"),
    ]
    keep = [
        K.driver_key(2024, 15, "norris"),
        K.driver_key(2023, 5, "norris"),
        K.entrants_meta_key(2024, 5),
        K.analysis_meta_key(2024, 5, "laps"),
        K.telemetry_laps_meta_key(2024, 5, "NOR"),
    ]
    for key in [*own, *keep]:
        if key.startswith("meta:"):
            await api.redis.set(key, "{}", ex=600)
        else:
            await api.redis.hset(key, mapping={"lap": "30"})
            await api.redis.expire(key, 21600)
    await api.redis.zadd(K.order_key(2024, 5), {"norris": 1})
    return [*own, K.order_key(2024, 5)], keep


async def test_start_deletes_only_the_old_keys_of_that_race(tmp_path: Path) -> None:
    api = _api(tmp_path, FakeLauncher(hold_producer=True))
    own, keep = await _seed(api)
    await _start(api)
    assert [k for k in own if await api.redis.exists(k)] == []
    assert all([await api.redis.exists(k) for k in keep])
    # while it runs, a second start is refused and deletes nothing (the run's own keys stay)
    await api.redis.hset(K.driver_key(2024, 5, "norris"), mapping={"lap": "1"})
    code, _ = await _post(api, "2024/5/replay", {"speed": 60})
    assert code == 409 and await api.redis.exists(K.driver_key(2024, 5, "norris"))
    await api.deps.replays.shutdown()


async def test_start_is_503_when_the_old_keys_cannot_be_deleted(tmp_path: Path) -> None:
    launcher = FakeLauncher(hold_producer=True)
    api = _api(tmp_path, launcher)

    async def broken(season: int, round_: int) -> int:
        raise ConnectionError("redis down")

    api.deps.replays._clear_race = broken
    code, body = await _post(api, "2024/5/replay", {"speed": 60})
    assert code == 503 and "could not be deleted" in body["detail"]
    assert launcher.processes == [] and api.deps.replays.jobs == {}
    assert not (tmp_path / "data" / "demo").exists() or not list(
        (tmp_path / "data" / "demo").iterdir()
    )


async def test_manager_store_error_registers_nothing(tmp_path: Path) -> None:
    calls: list[tuple[int, int]] = []

    async def broken(season: int, round_: int) -> int:
        calls.append((season, round_))
        raise OSError("no route")

    mgr = ReplayManager(FakeLauncher(), max_running=1, allow_test_season=False, clear_race=broken)
    with pytest.raises(ReplayStoreError):
        await mgr.start(2024, 5, 60)
    assert calls == [(2024, 5)] and mgr.jobs == {} and mgr.history == []


# ------------------------------------------------------------------ manager helpers and argv
async def test_manager_controls_raise_when_nothing_runs() -> None:
    mgr = ReplayManager(FakeLauncher(), max_running=1, allow_test_season=False)
    for call in (mgr.pause, mgr.resume, mgr.stop):
        with pytest.raises(ReplayNotRunningError):
            await call(2024, 5)
    with pytest.raises(ReplayNotRunningError):
        await mgr.set_speed(2024, 5, 10)
    with pytest.raises(ValueError, match="speed"):
        await mgr.set_speed(2024, 5, 5)


def test_the_stream_backstop_covers_the_slowest_speed_and_the_pause_cap() -> None:
    mgr = ReplayManager(
        FakeLauncher(),
        max_running=1,
        allow_test_season=False,
        ready_timeout_s=60,
        end_timeout_s=180,
        max_pause_s=1800,
    )
    assert mgr.stream_timeout_s() == 60 + 7200 + 1800 + 180
    with pytest.raises(ValueError, match="max_pause_s"):
        ReplayManager(FakeLauncher(), max_running=1, allow_test_season=False, max_pause_s=0)


def test_argv_builders_pass_the_control_files() -> None:
    argv = producer_argv(
        2024, 5, 60, allow_test_season=True, python="py",
        control_file=Path("d/replay_control.json"), progress_file=Path("d/replay_progress.json"),
    )  # fmt: skip
    assert argv == [
        "py", "-m", "f1sa.streaming.producer", "--season", "2024", "--round", "5", "--speed", "60",
        "--control-file", "d/replay_control.json", "--progress-file", "d/replay_progress.json",
        "--allow-test-season",
    ]  # fmt: skip
    job = stream_job_argv(
        2024, 5, checkpoint=Path("c"), ready_file=Path("r"), results_dir=Path("d"),
        timeout_s=10, allow_test_season=False, python="py", decisions_out=Path("d/decisions.jsonl"),
    )  # fmt: skip
    assert job[-2:] == ["--decisions-out", "d/decisions.jsonl"]


def test_job_dict_reports_every_control_field(tmp_path: Path) -> None:
    from f1sa.api.replay import ReplayJob

    job = ReplayJob(2024, 5, 60, RID, tmp_path, T0)
    assert set(job.to_dict()) == {
        "season", "round", "speed", "run_id", "results_dir", "state", "paused", "lap",
        "events_sent", "error", "note", "started_at", "running_at", "paused_at", "updated_at",
        "ended_at", "stream_returncode", "producer_returncode",
    }  # fmt: skip
    assert job.active and job.paused_for_s(10.0) == 0.0
    job.pause_total_s, job.paused_since = 2.0, 7.0
    assert job.paused_for_s(10.0) == 5.0
    for state, active in (("paused", True), ("stopped", False), ("finished", False)):
        job.state = state  # type: ignore[assignment]
        assert job.active is active


# ------------------------------------------------------------------ real subprocesses
STAND_IN_JOB = textwrap.dedent(
    """
    import subprocess, sys, time, pathlib
    ready, pidfile = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    jvm = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    pidfile.write_text(str(jvm.pid))
    ready.write_text("q")
    time.sleep(300)  # never sees a session_end: only a stop ends it
    """
)
STAND_IN_PRODUCER = textwrap.dedent(
    """
    import json, os, pathlib, subprocess, sys, time
    progress, pidfile = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    pidfile.write_text(str(child.pid))
    doc = {"lap": 9, "events_sent": 180, "race_time_s": 900.0, "paused": False,
           "speed": 60.0, "version": 0}
    tmp = progress.with_name(".p.tmp"); tmp.write_text(json.dumps(doc)); os.replace(tmp, progress)
    time.sleep(300)
    """
)


def _gone(pid: int, timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        time.sleep(0.05)
    return False


def _long_launcher(tmp_path: Path, pids: list[int]):  # type: ignore[no-untyped-def]
    async def launch(argv: Sequence[str]) -> ProcessLike:
        pidfile = tmp_path / f"child_{len(pids)}.pid"
        if "f1sa.streaming.stream_job" in argv:
            ready = argv[list(argv).index("--ready-file") + 1]
            proc = await subprocess_launcher(
                [sys.executable, "-c", STAND_IN_JOB, ready, str(pidfile)]
            )
        else:
            progress = argv[list(argv).index("--progress-file") + 1]
            proc = await subprocess_launcher(
                [sys.executable, "-c", STAND_IN_PRODUCER, progress, str(pidfile)]
            )
        for _ in range(500):
            if pidfile.exists() and pidfile.read_text():
                break
            await asyncio.sleep(0.01)
        pids.extend([proc.pid, int(pidfile.read_text())])  # type: ignore[attr-defined]
        return proc

    return launch


async def test_real_stop_leaves_no_orphans_and_a_new_replay_runs(tmp_path: Path) -> None:
    os.chdir(tmp_path)
    pids: list[int] = []
    mgr = ReplayManager(
        _long_launcher(tmp_path, pids),
        max_running=1,
        allow_test_season=False,
        ready_timeout_s=10.0,
        grace_s=2.0,
        poll_s=0.02,
    )
    job = await mgr.start(2024, 5, 60)
    await _until(lambda: job.lap == 9, timeout_s=15)
    assert job.state == "running" and len(pids) == 4
    await mgr.pause(2024, 5)
    stopped = await mgr.stop(2024, 5)
    assert (stopped.state, stopped.lap, stopped.events_sent) == ("stopped", 9, 180)
    assert all(_gone(pid) for pid in pids), "a replay process or its child survived the stop"
    assert mgr.jobs == {} and job.results_dir.is_dir()
    mgr._clock = lambda: datetime(2026, 11, 18, 9, 30, tzinfo=UTC)
    second = await mgr.start(2024, 5, 10)
    await _until(lambda: second.state == "running" and len(pids) == 8, timeout_s=15)
    assert second.run_id != job.run_id
    await mgr.stop(2024, 5)
    assert all(_gone(pid) for pid in pids[4:])


def test_fake_process_kinds_cover_both_children() -> None:
    assert FakeProcess(("py", "-m", "f1sa.streaming.stream_job")).kind == "stream_job"
    assert FakeProcess(("py", "-m", "f1sa.streaming.producer")).kind == "producer"


async def test_a_replay_being_torn_down_stays_listed_in_running(tmp_path: Path) -> None:
    """Found live: between the final state and ``_finish`` (processes still being stopped) the
    job was in neither list. It now stays in ``running`` until its slot is free."""
    launcher = FakeLauncher(hold_producer=True, stream_ignores_term=True, auto_end=False)
    api = _api(tmp_path, launcher)
    api.deps.replays.grace_s = 0.5
    await _start(api)
    await _until(lambda: bool(launcher.of("producer")))
    stopping = asyncio.create_task(api.deps.replays.stop(2024, 5))
    await _until(lambda: launcher.of("stream_job")[0].terminated)  # in teardown now
    status = await _status(api)
    assert [j["run_id"] for j in status["running"]] == [RID] and status["recent"] == []
    code, _ = await _post(api, "2024/5/replay", {"speed": 60})
    assert code == 409  # the slot is still held, as listed
    await stopping
    status = await _status(api)
    assert status["running"] == [] and status["recent"][0]["state"] == "stopped"
