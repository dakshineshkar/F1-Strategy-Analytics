"""Feature 7 proof harness (``streaming.control_check``): scenarios, the API client, the process
scan, the comparisons and the scenario driver against a fake API that replays laps."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from f1sa.streaming import control_check as C

RID = "2024_5_20261118T090000.250Z"


def msg(kind: str, lap: int, **payload: Any) -> dict[str, Any]:
    return {
        "type": kind,
        "season": 2024,
        "round": 5,
        "event_id": f"id-{kind}-{lap}",
        "published_at": "2026-11-18T09:00:00.000Z",
        "event_ts": None,
        "payload": {"lap": lap, **payload},
    }


def race_messages(laps: int = 20) -> list[dict[str, Any]]:
    out = [msg("lap", n, driver_id="a") for n in range(1, laps + 1)]
    out.append(msg("undercut_alert", 7, trigger="new_candidate"))
    out.append(msg("session_end", laps))
    return out


# ------------------------------------------------------------------ fakes
@dataclass
class FakeRace:
    """GET /api/replays advances the lap reached by one per call unless paused; the race finishes
    after ``laps``; every lap publishes a message to the collector."""

    tmp: Path
    laps: int = 20
    state: str = "idle"
    lap: int = 0
    paused: bool = False
    speed: int = 60
    run: int = 0
    other_running: bool = False
    calls: list[tuple[str, str, Any]] = field(default_factory=list)
    published: list[dict[str, Any]] = field(default_factory=list)
    write_decisions: bool = True
    sent: int = 0

    @property
    def rid(self) -> str:
        return f"{RID}-{self.run}"

    @property
    def results(self) -> Path:
        return self.tmp / "demo" / self.rid

    def job(self) -> dict[str, Any]:
        return {
            "run_id": self.rid,
            "state": self.state,
            "lap": self.lap or None,
            "speed": self.speed,
            "paused": self.paused,
            "events_sent": self.sent,
            "results_dir": str(self.results),
            "error": None,
        }

    def _tick(self) -> None:
        if self.state != "running":
            return
        self.lap += 1
        self.sent += 1
        self.published.append(msg("lap", self.lap, driver_id="a"))
        if self.lap == 7:
            self.published.append(msg("undercut_alert", 7, trigger="new_candidate"))
        if self.lap >= self.laps:
            self.published.append(msg("session_end", self.laps))
            self.state = "finished"
            (self.results / "stream_batches.jsonl").write_text("{}\n")
            if self.write_decisions:
                row = {"decision_lap": 6, "attacker_id": "b", "defender_id": "a"}
                row |= {"gap_s": 1.5, "probability": 0.4, "inputs": {}}
                (self.results / "decisions.jsonl").write_text(json.dumps(row) + "\n")

    def fetch(self, method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
        path = url.split("8000", 1)[1]
        self.calls.append((method, path, body))
        if path == "/api/replays":
            self._tick()
            running = [self.job()] if self.state in ("starting", "running", "paused") else []
            if self.other_running:
                running.append({"run_id": "other", "state": "running"})
            recent = [self.job()] if self.state in C.TERMINAL else []
            return 200, {"running": running, "recent": recent}
        if path.endswith("/replay"):
            self.run += 1
            self.state, self.lap, self.paused, self.sent = "running", 0, False, 0
            self.speed = int((body or {})["speed"])
            self.published = []
            self.results.mkdir(parents=True)
            return 202, self.job()
        action = path.rsplit("/", 1)[1]
        if self.state not in ("running", "paused"):
            return 409, {"detail": "no replay"}
        if action == "pause":
            self.paused, self.state = True, "paused"
        elif action == "resume":
            self.paused, self.state = False, "running"
        elif action == "speed":
            self.speed = int((body or {})["speed"])
        elif action == "stop":
            self.state = "stopped"
            (self.results / "stream_batches.jsonl").write_text("{}\n")
        return 200, self.job()


class FakeCollector:
    def __init__(self, race: FakeRace) -> None:
        self.race = race
        self.closed = False

    def count(self, types: Sequence[str]) -> int:
        return sum(1 for m in self.race.published if m["type"] in types)

    def snapshot(self) -> list[dict[str, Any]]:
        return list(self.race.published)

    def close(self) -> None:
        self.closed = True


def driver(race: FakeRace, procs: list[dict[int, str]] | None = None) -> C.Driver:
    seq = iter(procs or [{11: "python -m f1sa.streaming.producer"}] * 10_000 + [{}] * 10_000)
    t = [0.0]

    def sleep(s: float) -> None:
        t[0] += s

    def processes() -> dict[int, str]:
        if race.state in ("running", "paused"):
            return next(seq)
        return {}

    return C.Driver(
        api=C.ApiClient("http://api:8000", 2024, 5, fetch=race.fetch),
        collector_factory=lambda: FakeCollector(race),
        read_state=lambda: {"drivers": {"a": {"position": 1}}, "order": [["a", 1]]},
        read_keys=lambda: ["race:2024:5:driver:a", "race:2024:5:order"],
        processes=processes,
        sleep=sleep,
        clock=lambda: t[0],
        out=lambda line: None,
        poll_s=0.25,
        timeout_s=600,
    )


# ------------------------------------------------------------------ scenarios and parsing
def test_scenarios_in_order_and_validated() -> None:
    plan = C.scenarios(2, 10, 20.0, 15)
    assert [s.name for s in plan] == ["baseline", "switch", "pause", "stop", "restart"]
    assert (plan[1].speed, plan[1].actions[0]) == (1, C.Action("speed", 2, speed=60))
    assert plan[2].actions[0] == C.Action("pause", 10, pause_s=20.0)
    assert plan[3].stops and not plan[4].stops
    with pytest.raises(ValueError, match="stop-lap"):
        C.scenarios(2, 10, 20.0, 0)
    with pytest.raises(ValueError, match="pause-s"):
        C.scenarios(2, 10, 1.0, 15)


def test_parse_int_list_and_args() -> None:
    assert C.parse_int_list("113,19,9") == (113, 19, 9)
    for bad in ("1,2", "a,b,c", "1,-2,3"):
        with pytest.raises(Exception, match="expected"):
            C.parse_int_list(bad)
    args = C.parse_args(["--season", "2024", "--round", "5", "--expect-triggers", "113,19,9"])
    assert (args.api, args.switch_lap, args.expect_triggers) == (
        "http://127.0.0.1:8000",
        2,
        (113, 19, 9),
    )


# ------------------------------------------------------------------ API client
def test_api_client_errors_and_find_job(tmp_path: Path) -> None:
    def fetch(method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
        return 503, {"detail": "down"}

    api = C.ApiClient("http://api:8000/", 2024, 5, fetch=fetch)
    with pytest.raises(C.CheckError, match="status 503"):
        api.replays()
    with pytest.raises(C.CheckError, match="not started"):
        api.start(60)
    with pytest.raises(C.CheckError, match="replay pause: status 503"):
        api.control("pause")
    with pytest.raises(C.RefusedError, match="cannot read"):
        C.check_idle(api)
    status = {"running": [{"run_id": "a"}], "recent": [{"run_id": "b", "state": "stopped"}]}
    assert C.find_job(status, "b") == {"run_id": "b", "state": "stopped"}
    assert C.find_job(status, "c") is None


def test_check_idle_refuses_while_a_replay_runs(tmp_path: Path) -> None:
    race = FakeRace(tmp_path, other_running=True)
    with pytest.raises(C.RefusedError, match="other"):
        C.check_idle(C.ApiClient("http://api:8000", 2024, 5, fetch=race.fetch))


def test_http_fetch_without_a_server_is_status_0() -> None:
    status, body = C.http_fetch("GET", "http://127.0.0.1:9/api/replays", None)
    assert status == 0 and "detail" in body


# ------------------------------------------------------------------ processes and decisions
def test_replay_processes_reads_proc(tmp_path: Path) -> None:
    for pid, cmd in (
        ("10", b"python\0-m\0f1sa.streaming.producer\0--season\0002024"),
        ("11", b"java\0-cp\0x\0org.apache.spark.deploy.SparkSubmit\0pyspark-shell"),
        ("12", b"python\0-m\0f1sa.api"),
        ("self", b"python\0-m\0f1sa.streaming.stream_job"),
    ):
        (tmp_path / pid).mkdir()
        (tmp_path / pid / "cmdline").write_bytes(cmd)
    (tmp_path / "13").mkdir()  # a process that ended between the listing and the read
    found = C.replay_processes(tmp_path)
    assert set(found) == {10, 11}
    assert found[10].startswith("python -m f1sa.streaming.producer")


def test_read_decisions(tmp_path: Path) -> None:
    path = tmp_path / "decisions.jsonl"
    rows = [
        {"decision_lap": 6, "attacker_id": "b", "defender_id": "a", "gap_s": 1.5},
        {"decision_lap": 9, "attacker_id": "c", "defender_id": "b", "gap_s": 2},
    ]
    path.write_text(
        "\n".join(json.dumps({**r, "probability": 0.25, "inputs": {}}) for r in rows) + "\n\n"
    )
    assert C.read_decisions(path) == [(6, "b", "a", 1.5, 0.25), (9, "c", "b", 2.0, 0.25)]


# ------------------------------------------------------------------ comparisons
def record(name: str = "x", **over: Any) -> C.RunRecord:
    base: dict[str, Any] = {
        "scenario": name,
        "run_id": RID,
        "job": {"state": "finished", "lap": 20},
        "messages": race_messages(),
        "state": {"drivers": {"a": {"position": 1}}, "tyres": {}, "timing": {}, "order": []},
        "keys": ["race:2024:5:driver:a"],
        "decisions": [(6, "b", "a", 1.5, 0.4)],
    }
    base.update(over)
    return C.RunRecord(**base)


def test_equal_runs_compare_equal_whatever_the_ids_and_order() -> None:
    other = race_messages()
    other.reverse()
    for m in other:
        m["event_id"], m["published_at"] = "other-id", "2026-11-18T10:00:00.000Z"
    assert C.compare_runs(record(), record(messages=other)) == []
    assert record().counts()["lap"] == 20
    assert record().triggers() == {"new_candidate": 1, "probability_crossed": 0, "pit_in": 0}


def test_every_difference_is_reported() -> None:
    base = record()
    fewer = race_messages()[1:]
    changed = race_messages()
    changed[3]["payload"]["driver_id"] = "z"
    assert any("message counts" in p for p in C.compare_runs(base, record(messages=fewer)))
    assert C.compare_runs(base, record(messages=changed)) == [
        "messages differ from the baseline: 1 missing, 1 extra"
    ]
    assert any("decisions differ" in p for p in C.compare_runs(base, record(decisions=[])))
    assert any("decisions.jsonl missing" in p for p in C.compare_runs(base, record(decisions=None)))
    moved = {"drivers": {"a": {"position": 2}}, "tyres": {}, "timing": {}, "order": []}
    assert C.compare_runs(base, record(state=moved)) == ["final Redis state differs: drivers.a"]
    extra = ["race:2024:5:driver:a", "race:2024:5:driver:old"]
    assert any(
        "extra ['race:2024:5:driver:old']" in p for p in C.compare_runs(base, record(keys=extra))
    )


def test_state_diff_text_and_expectations() -> None:
    assert C.state_diff_text(None, {}) == "a state is missing"
    assert C.state_diff_text({"order": [1]}, {"order": [2]}) == "order"
    rec = record()
    assert C.expectation_problems(rec, (1, 0, 0), 1) == []
    assert C.expectation_problems(rec, (113, 19, 9), 409) == [
        "alerts by trigger [1, 0, 0] != expected [113, 19, 9]",
        "1 decisions != expected 409",
    ]


# ------------------------------------------------------------------ the driver
def test_baseline_run_collects_everything(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    rec = driver(race).run(C.Scenario("baseline", 60))
    assert rec.problems == [] and rec.job["state"] == "finished"
    assert rec.counts() == {
        "lap": 20,
        "pit_in": 0,
        "pit_out": 0,
        "undercut_alert": 1,
        "session_end": 1,
    }
    assert rec.decisions == [(6, "b", "a", 1.5, 0.4)]
    assert rec.keys == ["race:2024:5:driver:a", "race:2024:5:order"]


def test_speed_switch_and_pause_are_applied_at_their_laps(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    drv = driver(race)
    switch = drv.run(C.Scenario("switch", 1, (C.Action("speed", 2, speed=60),)))
    assert switch.problems == [] and race.speed == 60
    speed_calls = [c for c in race.calls if c[1].endswith("/speed")]
    assert speed_calls == [("POST", "/api/races/2024/5/replay/speed", {"speed": 60})]
    pause = drv.run(C.Scenario("pause", 60, (C.Action("pause", 10, pause_s=5.0),)))
    assert pause.problems == []
    actions = [c[1].rsplit("/", 1)[1] for c in race.calls if c[0] == "POST"]
    assert actions[-2:] == ["pause", "resume"]


def test_a_pause_that_moves_is_a_problem(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    drv = driver(race)
    real_fetch = race.fetch

    def leaky(method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
        if race.state == "paused" and url.endswith("/api/replays"):
            race.published.append(msg("lap", 99, driver_id="z"))  # an event while paused
        return real_fetch(method, url, body)

    drv.api.fetch = leaky
    rec = drv.run(C.Scenario("pause", 60, (C.Action("pause", 5, pause_s=3.0),)))
    assert any("the channel moved in the second half of the pause" in p for p in rec.problems)


def test_a_producer_that_sends_while_paused_is_a_problem(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    drv = driver(race)
    real_fetch = race.fetch
    calls = {"n": 0}

    def sending(method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
        status, doc = real_fetch(method, url, body)
        if race.state == "paused" and url.endswith("/api/replays"):
            calls["n"] += 1
            for job in doc["running"]:
                job["events_sent"] = 100 + calls["n"]  # the producer keeps sending
        return status, doc

    drv.api.fetch = sending
    rec = drv.run(C.Scenario("pause", 60, (C.Action("pause", 5, pause_s=4.0),)))
    assert any("the producer moved while paused" in p for p in rec.problems)


def test_late_messages_in_the_grace_of_a_pause_are_fine(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    drv = driver(race)
    real_sleep = drv.sleep
    slept = {"n": 0}

    def sleep(s: float) -> None:
        if race.state == "paused":
            slept["n"] += 1
            if slept["n"] == 2:  # between 1 s and the midpoint: the stream job still drains
                race.published.append(msg("undercut_alert", 9, trigger="pit_in"))
        real_sleep(s)

    drv.sleep = sleep
    rec = drv.run(C.Scenario("pause", 60, (C.Action("pause", 5, pause_s=4.0),)))
    assert not [p for p in rec.problems if "paused" in p or "pause" in p]


def test_stop_checks_processes_session_end_and_outputs(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    rec = driver(race).run(C.Scenario("stop", 60, (C.Action("stop", 15),)))
    assert rec.problems == [], rec.problems
    assert rec.job["state"] == "stopped" and rec.job["lap"] >= 15
    assert rec.counts()["session_end"] == 0


def test_stop_reports_survivors_and_a_missed_lap(tmp_path: Path) -> None:
    race = FakeRace(tmp_path)
    drv = driver(race)
    drv.processes = lambda: {11: "java org.apache.spark.deploy.SparkSubmit"}  # never goes away
    rec = drv.run(C.Scenario("stop", 60, (C.Action("stop", 15),)))
    assert any("processes left after the stop: [11]" in p for p in rec.problems)


def test_a_run_that_ends_before_its_action_is_a_problem(tmp_path: Path) -> None:
    race = FakeRace(tmp_path, laps=5)
    rec = driver(race).run(C.Scenario("stop", 60, (C.Action("stop", 15),)))
    assert any("before ['stop']" in p for p in rec.problems)
    assert any("expected stopped" in p for p in rec.problems)


def test_a_run_that_never_ends_times_out(tmp_path: Path) -> None:
    race = FakeRace(tmp_path, laps=10**9)
    drv = driver(race)
    drv.timeout_s = 5
    with pytest.raises(C.CheckError, match="no end within 5 s"):
        drv.run(C.Scenario("baseline", 60))


def test_run_all_and_main(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    race = FakeRace(tmp_path)
    lines: list[str] = []
    ok, recs = C.run_all(
        driver(race), C.scenarios(2, 10, 3.0, 15), triggers=(1, 0, 0), decisions=1, out=lines.append
    )
    assert ok, lines
    assert [r.scenario for r in recs] == ["baseline", "switch", "pause", "stop", "restart"]
    assert lines[-1] == "EQUIVALENT"
    rc = C.main(
        ["--season", "2024", "--round", "5", "--pause-s", "3", "--out-dir", str(tmp_path / "out")],
        driver=driver(FakeRace(tmp_path / "second")),
    )
    assert rc == 0
    summary = json.loads(next((tmp_path / "out").glob("control_check_*.json")).read_text())
    assert summary["ok"] is True and len(summary["runs"]) == 5
    assert "EQUIVALENT" in capsys.readouterr().out


def test_main_mismatch_refusal_and_bad_args(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--season", "2024", "--round", "5", "--pause-s", "3", "--out-dir", str(tmp_path)]
    assert (
        C.main([*args, "--expect-decisions", "409"], driver=driver(FakeRace(tmp_path / "a"))) == 1
    )
    assert "NOT EQUIVALENT" in capsys.readouterr().out
    busy = FakeRace(tmp_path / "b", other_running=True)
    assert C.main(args, driver=driver(busy)) == 2
    assert C.main([*args[:4], "--pause-s", "1"], driver=driver(FakeRace(tmp_path / "c"))) == 2
    broken = FakeRace(tmp_path / "d")
    broken.state = "finished"
    drv = driver(broken)

    def no_start(method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
        if method == "POST":
            return 500, {"detail": "boom"}
        return broken.fetch(method, url, body)

    drv.api.fetch = no_start
    assert C.main(args, driver=drv) == 1
    assert "replay not started" in capsys.readouterr().err
