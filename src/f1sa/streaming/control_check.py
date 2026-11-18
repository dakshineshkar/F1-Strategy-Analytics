"""Proof that replay controls change only the pacing (Feature 7).

    python -m f1sa.streaming.control_check --season 2024 --round 5 [--api http://127.0.0.1:8000]

Runs inside the api container (``make replay-control-check``), where the API's replays run, and
drives the real API over HTTP (Kafka -> stream job -> Redis, exactly what the dashboard drives).
Each scenario is one API replay of the race, with every message on the race channel collected
from Redis Pub/Sub (``archive.equivalence.Collector``):

* ``baseline``: 60x, uninterrupted.
* ``switch``: 1x until the lap reached is ``--switch-lap``, then ``POST .../replay/speed 60``.
* ``pause``: 60x, paused at ``--pause-lap`` for ``--pause-s``, then resumed. The producer must send
  nothing while paused (events sent and the lap reached stay put); the channel must be quiet over
  the second half of the pause (events sent before it are still being published while the stream
  job drains them; found live: 4 messages 1-10 s into a 20 s pause).
* ``stop``: 60x, stopped at ``--stop-lap``. The run must end ``stopped`` with that lap or later,
  no ``session_end`` may be published, its partial outputs stay, and none of its processes (the
  producer, the stream job and its JVM, seen while it ran) may survive.
* ``restart``: right after ``stop``, a new 60x replay of the race, which the API starts fresh
  (the old ``race:{s}:{r}:*`` keys are deleted at the start).

Every finished scenario must equal ``baseline``: the same messages (lap, pit, alerts and
``session_end``, without ids and timing fields; compared as multisets, since partitions
interleave differently), the same alerts by trigger (``--expect-triggers``, e.g. 113,19,9 for
the sample 2024 R5 with the deployed model), the same decisions (``decisions.jsonl`` from the
stream job, ``--expect-decisions``), the same final Redis state as ``GET /state`` reads it (driver
hashes, tyre and timing hashes, order; ``updated_at`` excluded) and the same set of race keys.

Refused (exit 2) while another replay runs. Writes only what API replays write (the race's
Redis keys, ``data/checkpoints/api_*``, ``data/demo/<run_id>/``) plus the summary
``data/demo/control_check_<stamp>.json`` (``--out-dir``). Exit 0: every check passed; 1: a
mismatch or failure.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from f1sa.config import get_settings

ActionKind = Literal["speed", "pause", "stop"]
REPLAY_PROCESS_MARKERS = (
    "f1sa.streaming.producer",
    "f1sa.streaming.stream_job",
    "org.apache.spark.deploy.SparkSubmit",
)
TERMINAL = ("finished", "stopped", "failed")
MESSAGE_TYPES = ("lap", "pit_in", "pit_out", "undercut_alert", "session_end")


class CheckError(RuntimeError):
    """A scenario could not be run or did not behave as required (exit 1)."""


class RefusedError(RuntimeError):
    """The check cannot run now (exit 2)."""


# ============================================================================== scenarios
@dataclass(frozen=True)
class Action:
    kind: ActionKind
    at_lap: int
    speed: int = 60
    pause_s: float = 0.0


@dataclass(frozen=True)
class Scenario:
    name: str
    speed: int
    actions: tuple[Action, ...] = ()

    @property
    def stops(self) -> bool:
        return any(a.kind == "stop" for a in self.actions)


def scenarios(switch_lap: int, pause_lap: int, pause_s: float, stop_lap: int) -> list[Scenario]:
    """The five scenarios, in the order they run (``restart`` must follow ``stop``)."""
    for name, lap in (("switch", switch_lap), ("pause", pause_lap), ("stop", stop_lap)):
        if lap < 1:
            raise ValueError(f"--{name}-lap must be >= 1, got {lap}")
    if pause_s < 2:
        raise ValueError(f"--pause-s must be >= 2 (1 s grace, then a still check), got {pause_s}")
    return [
        Scenario("baseline", 60),
        Scenario("switch", 1, (Action("speed", switch_lap, speed=60),)),
        Scenario("pause", 60, (Action("pause", pause_lap, pause_s=pause_s),)),
        Scenario("stop", 60, (Action("stop", stop_lap),)),
        Scenario("restart", 60),
    ]


# ============================================================================== the API
Fetch = Callable[[str, str, Mapping[str, Any] | None], tuple[int, Any]]


def http_fetch(method: str, url: str, body: Mapping[str, Any] | None) -> tuple[int, Any]:
    """``(status, JSON body)``; ``status`` 0 when nothing answers."""
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return int(resp.status), json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        try:
            return int(exc.code), json.loads(exc.read() or b"null")
        except ValueError:
            return int(exc.code), None
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        return 0, {"detail": str(exc)}


@dataclass
class ApiClient:
    base: str
    season: int
    round: int
    fetch: Fetch = http_fetch

    def _url(self, path: str) -> str:
        return self.base.rstrip("/") + path

    @property
    def race(self) -> str:
        return f"/api/races/{self.season}/{self.round}"

    def replays(self) -> dict[str, Any]:
        status, body = self.fetch("GET", self._url("/api/replays"), None)
        if status != 200 or not isinstance(body, dict):
            raise CheckError(f"GET /api/replays: status {status}: {body}")
        return body

    def start(self, speed: int) -> dict[str, Any]:
        status, body = self.fetch("POST", self._url(f"{self.race}/replay"), {"speed": speed})
        if status != 202 or not isinstance(body, dict):
            raise CheckError(f"replay not started: status {status}: {body}")
        return body

    def control(self, action: str, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
        status, doc = self.fetch("POST", self._url(f"{self.race}/replay/{action}"), body)
        if status != 200 or not isinstance(doc, dict):
            raise CheckError(f"replay {action}: status {status}: {doc}")
        return doc


def find_job(status: Mapping[str, Any], run_id: str) -> dict[str, Any] | None:
    for job in [*status.get("running", []), *status.get("recent", [])]:
        if isinstance(job, dict) and job.get("run_id") == run_id:
            return job
    return None


def check_idle(api: ApiClient) -> None:
    try:
        running = api.replays().get("running", [])
    except CheckError as exc:
        raise RefusedError(f"cannot read the replay status ({exc})") from exc
    if running:
        names = ", ".join(str(j.get("run_id")) for j in running)
        raise RefusedError(f"a replay is running ({names}); wait until none runs")


# ============================================================================== processes
def replay_processes(proc_root: Path = Path("/proc")) -> dict[int, str]:
    """``{pid: command line}`` of every replay process visible here (producer, stream job, the
    stream job's Spark JVM)."""
    out: dict[int, str] = {}
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        cmd = raw.replace(b"\0", b" ").decode("utf-8", errors="replace").strip()
        if any(m in cmd for m in REPLAY_PROCESS_MARKERS):
            out[int(entry.name)] = cmd[:200]
    return out


# ============================================================================== records
class CollectorLike(Protocol):
    def count(self, types: Sequence[str]) -> int: ...

    def snapshot(self) -> list[dict[str, Any]]: ...

    def close(self) -> None: ...


Decision = tuple[int, str, str, float, float]


def read_decisions(path: Path) -> list[Decision]:
    """``(decision_lap, attacker, defender, gap_s, probability)`` of each line of the stream
    job's ``decisions.jsonl``."""
    rows: list[Decision] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            d = json.loads(line)
            rows.append(
                (
                    int(d["decision_lap"]),
                    str(d["attacker_id"]),
                    str(d["defender_id"]),
                    float(d["gap_s"]),
                    float(d["probability"]),
                )
            )
    return rows


@dataclass
class RunRecord:
    scenario: str
    run_id: str
    job: dict[str, Any]
    messages: list[dict[str, Any]]
    state: dict[str, Any] | None = None
    keys: list[str] = field(default_factory=list)
    decisions: list[Decision] | None = None
    problems: list[str] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        c = Counter(str(m.get("type")) for m in self.messages)
        return {t: c.get(t, 0) for t in MESSAGE_TYPES}

    def triggers(self) -> dict[str, int]:
        c = Counter(
            str(m.get("payload", {}).get("trigger"))
            for m in self.messages
            if m.get("type") == "undercut_alert"
        )
        return {t: c.get(t, 0) for t in ("new_candidate", "probability_crossed", "pit_in")}

    def summary(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "run_id": self.run_id,
            "state": self.job.get("state"),
            "lap": self.job.get("lap"),
            "messages": self.counts(),
            "alerts_by_trigger": self.triggers(),
            "decisions": None if self.decisions is None else len(self.decisions),
            "race_keys": len(self.keys),
            "problems": self.problems,
        }


def comparable_messages(messages: Iterable[Mapping[str, Any]]) -> Counter[str]:
    from f1sa.archive.equivalence import comparable_message

    return Counter(comparable_message(m) for m in messages)


def compare_runs(baseline: RunRecord, other: RunRecord) -> list[str]:
    """Every difference between a finished run and the baseline (empty when equal)."""
    out: list[str] = []
    if baseline.counts() != other.counts():
        out.append(f"message counts {other.counts()} != baseline {baseline.counts()}")
    a, b = comparable_messages(baseline.messages), comparable_messages(other.messages)
    if a != b:
        missing, extra = sum((a - b).values()), sum((b - a).values())
        out.append(f"messages differ from the baseline: {missing} missing, {extra} extra")
    if baseline.triggers() != other.triggers():
        out.append(f"alerts by trigger {other.triggers()} != baseline {baseline.triggers()}")
    if baseline.decisions is None or other.decisions is None:
        out.append("decisions.jsonl missing")
    elif Counter(baseline.decisions) != Counter(other.decisions):
        out.append(
            f"decisions differ ({len(other.decisions)} vs {len(baseline.decisions)} in baseline)"
        )
    if baseline.state != other.state:
        out.append(f"final Redis state differs: {state_diff_text(baseline.state, other.state)}")
    if baseline.keys != other.keys:
        extra_keys = sorted(set(other.keys) - set(baseline.keys))[:5]
        gone = sorted(set(baseline.keys) - set(other.keys))[:5]
        out.append(f"race keys differ: extra {extra_keys}, missing {gone}")
    return out


def state_diff_text(a: Mapping[str, Any] | None, b: Mapping[str, Any] | None) -> str:
    if a is None or b is None:
        return "a state is missing"
    diffs: list[str] = []
    for part in ("drivers", "tyres", "timing"):
        pa, pb = a.get(part, {}), b.get(part, {})
        for d in sorted(set(pa) | set(pb)):
            if pa.get(d) != pb.get(d):
                diffs.append(f"{part}.{d}")
    if a.get("order") != b.get("order"):
        diffs.append("order")
    return ", ".join(diffs[:8]) or "no field differs"


def expectation_problems(
    record: RunRecord, triggers: Sequence[int] | None, decisions: int | None
) -> list[str]:
    out: list[str] = []
    if triggers is not None:
        got = list(record.triggers().values())
        if got != list(triggers):
            out.append(f"alerts by trigger {got} != expected {list(triggers)}")
    if decisions is not None and (record.decisions is None or len(record.decisions) != decisions):
        n = None if record.decisions is None else len(record.decisions)
        out.append(f"{n} decisions != expected {decisions}")
    return out


# ============================================================================== driving
@dataclass
class Driver:
    """Runs one scenario through the API (injected parts for tests)."""

    api: ApiClient
    collector_factory: Callable[[], CollectorLike]
    read_state: Callable[[], dict[str, Any]]
    read_keys: Callable[[], list[str]]
    processes: Callable[[], dict[int, str]] = replay_processes
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    out: Callable[[str], None] = print
    poll_s: float = 0.25
    timeout_s: float = 900.0
    end_wait_s: float = 30.0

    def _job(self, run_id: str) -> dict[str, Any]:
        job = find_job(self.api.replays(), run_id)
        if job is None:
            raise CheckError(f"replay {run_id} is not in GET /api/replays")
        return job

    def run(self, scenario: Scenario) -> RunRecord:
        check_idle(self.api)
        collector = self.collector_factory()
        try:
            started = self.api.start(scenario.speed)
            rid = str(started["run_id"])
            self.out(f"[{scenario.name}] {rid} at {scenario.speed}x")
            record = RunRecord(scenario.name, rid, started, [])
            pending = list(scenario.actions)
            seen_procs: dict[int, str] = {}
            deadline = self.clock() + self.timeout_s
            while True:
                job = self._job(rid)
                if job.get("state") in ("running", "paused"):
                    seen_procs.update(self.processes())
                if job.get("state") in TERMINAL:
                    break
                if pending and (job.get("lap") or 0) >= pending[0].at_lap:
                    self._act(pending.pop(0), job, collector, record)
                    continue
                if self.clock() > deadline:
                    raise CheckError(f"[{scenario.name}] no end within {self.timeout_s:g} s")
                self.sleep(self.poll_s)
            record.job = self._job(rid)
            if pending:
                record.problems.append(
                    f"ended {record.job.get('state')} before {[a.kind for a in pending]}"
                )
            if scenario.stops:
                self._check_stopped(record, collector, seen_procs)
            else:
                self._settle_finished(record, collector)
            record.messages = collector.snapshot()
            record.state = self.read_state()
            record.keys = self.read_keys()
            results = Path(str(started.get("results_dir", "")))
            decisions = results / "decisions.jsonl"
            record.decisions = read_decisions(decisions) if decisions.is_file() else None
            return record
        finally:
            collector.close()

    def _act(
        self, action: Action, job: Mapping[str, Any], collector: CollectorLike, record: RunRecord
    ) -> None:
        name, lap = record.scenario, job.get("lap")
        if action.kind == "speed":
            got = self.api.control("speed", {"speed": action.speed})
            self.out(f"[{name}] speed {action.speed}x at lap {lap}")
            if got.get("speed") != action.speed:
                record.problems.append(f"speed is {got.get('speed')} after the change")
        elif action.kind == "pause":
            got = self.api.control("pause")
            self.out(f"[{name}] paused at lap {lap} for {action.pause_s:g} s")
            if got.get("state") != "paused":
                record.problems.append(f"state {got.get('state')} after pause")
            # The producer must send nothing while paused (events_sent and the lap reached stay
            # put). Events it sent before the pause still reach the channel while the stream job
            # works through them, so the channel must only be quiet once it has drained: over the
            # second half of the pause.
            self.sleep(1.0)
            j0, n_grace = self._job(record.run_id), collector.count(MESSAGE_TYPES)
            half = action.pause_s / 2.0
            self.sleep(max(half - 1.0, 0.0))
            n_mid = collector.count(MESSAGE_TYPES)
            self.sleep(half)
            j1, n_end = self._job(record.run_id), collector.count(MESSAGE_TYPES)
            sent = (j0.get("events_sent"), j1.get("events_sent"))
            laps = (j0.get("lap"), j1.get("lap"))
            if sent[0] != sent[1] or laps[0] != laps[1]:
                record.problems.append(
                    f"the producer moved while paused: events sent {sent[0]} -> {sent[1]}, "
                    f"lap {laps[0]} -> {laps[1]}"
                )
            if n_mid != n_end:
                record.problems.append(
                    f"the channel moved in the second half of the pause: {n_mid} -> {n_end}"
                )
            got = self.api.control("resume")
            if got.get("state") != "running":
                record.problems.append(f"state {got.get('state')} after resume")
            self.out(
                f"[{name}] resumed: events sent {sent[0]} -> {sent[1]}, lap {laps[0]} -> "
                f"{laps[1]}; messages {n_grace} at 1 s, {n_mid} at {half:g} s, {n_end} at the end"
            )
        else:
            got = self.api.control("stop")
            self.out(f"[{name}] stopped: state {got.get('state')} at lap {got.get('lap')}")
            if got.get("state") != "stopped":
                record.problems.append(f"state {got.get('state')} after stop")
            if (got.get("lap") or 0) < action.at_lap:
                record.problems.append(f"lap reached {got.get('lap')} < {action.at_lap}")

    def _settle_finished(self, record: RunRecord, collector: CollectorLike) -> None:
        if record.job.get("state") != "finished":
            record.problems.append(f"state {record.job.get('state')}: {record.job.get('error')}")
            return
        deadline = self.clock() + self.end_wait_s
        while collector.count(("session_end",)) < 1:
            if self.clock() > deadline:
                record.problems.append("no session_end message received")
                return
            self.sleep(self.poll_s)

    def _check_stopped(
        self, record: RunRecord, collector: CollectorLike, seen: Mapping[int, str]
    ) -> None:
        if record.job.get("state") != "stopped":
            record.problems.append(f"state {record.job.get('state')}, expected stopped")
        if not seen:
            record.problems.append("no replay process was seen while it ran")
        self.sleep(1.0)
        left = {pid: cmd for pid, cmd in self.processes().items() if pid in seen}
        if left:
            record.problems.append(f"processes left after the stop: {sorted(left)}")
        if collector.count(("session_end",)):
            record.problems.append("a session_end was published for a stopped replay")
        results = Path(str(record.job.get("results_dir", "")))
        if not (results / "stream_batches.jsonl").is_file():
            record.problems.append(f"partial outputs missing in {results}")
        self.out(f"[{record.scenario}] processes seen {len(seen)}, left {len(left)}")


# ============================================================================== CLI
def parse_int_list(text: str) -> tuple[int, ...]:
    try:
        values = tuple(int(x) for x in text.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected integers like 113,19,9, got {text!r}") from exc
    if len(values) != 3 or min(values) < 0:
        raise argparse.ArgumentTypeError(f"expected three counts >= 0, got {text!r}")
    return values


def parse_args(argv: Iterable[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m f1sa.streaming.control_check", description=__doc__.split("\n\n")[0]
    )
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--api", default="http://127.0.0.1:8000")
    p.add_argument("--switch-lap", type=int, default=2)
    p.add_argument("--pause-lap", type=int, default=10)
    p.add_argument("--pause-s", type=float, default=20.0)
    p.add_argument("--stop-lap", type=int, default=15)
    p.add_argument(
        "--expect-triggers", type=parse_int_list, default=None, metavar="NEW,CROSSED,PIT"
    )
    p.add_argument("--expect-decisions", type=int, default=None)
    p.add_argument("--timeout-s", type=float, default=900.0, help="per scenario")
    p.add_argument(
        "--out-dir", type=Path, default=None, help="summary folder (default Settings.demo_dir)"
    )
    return p.parse_args(list(argv) if argv is not None else None)


def live_driver(args: argparse.Namespace) -> Driver:  # pragma: no cover - needs Redis and Kafka
    from f1sa.archive.equivalence import Collector, comparable_state, read_live_state
    from f1sa.serving.redis_store import RaceStore

    settings = get_settings()
    store = RaceStore.from_settings(settings)
    return Driver(
        api=ApiClient(args.api, args.season, args.round),
        collector_factory=lambda: Collector(settings.redis_url, args.season, args.round),
        read_state=lambda: comparable_state(
            read_live_state(settings.redis_url, args.season, args.round)
        ),
        read_keys=lambda: store.race_keys(args.season, args.round),
        timeout_s=args.timeout_s,
    )


def run_all(
    driver: Driver,
    plan: Sequence[Scenario],
    *,
    triggers: Sequence[int] | None,
    decisions: int | None,
    out: Callable[[str], None] = print,
) -> tuple[bool, list[RunRecord]]:
    """Run ``plan`` (``baseline`` first) and compare; ``(all ok, records)``."""
    records: list[RunRecord] = []
    for scenario in plan:
        records.append(driver.run(scenario))
    base = records[0]
    base.problems += expectation_problems(base, triggers, decisions)
    for rec in records[1:]:
        if rec.scenario == "stop":
            continue  # a partial run: its own checks only
        rec.problems += compare_runs(base, rec)
        rec.problems += expectation_problems(rec, triggers, decisions)
    ok = True
    for rec in records:
        verdict = "OK" if not rec.problems else "MISMATCH"
        ok = ok and not rec.problems
        s = rec.summary()
        out(
            f"{verdict:8} {rec.scenario:8} {rec.run_id} state={s['state']} lap={s['lap']} "
            f"messages={s['messages']} alerts={s['alerts_by_trigger']} decisions={s['decisions']} "
            f"keys={s['race_keys']}"
        )
        for problem in rec.problems:
            out(f"         - {problem}")
    out("EQUIVALENT" if ok else "NOT EQUIVALENT")
    return ok, records


def main(argv: Iterable[str] | None = None, *, driver: Driver | None = None) -> int:
    args = parse_args(argv)
    try:
        plan = scenarios(args.switch_lap, args.pause_lap, args.pause_s, args.stop_lap)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    drv = driver or live_driver(args)
    try:
        ok, records = run_all(
            drv, plan, triggers=args.expect_triggers, decisions=args.expect_decisions
        )
    except RefusedError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    except CheckError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    folder: Path = args.out_dir if args.out_dir is not None else get_settings().demo_dir
    path = folder / f"control_check_{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"season": args.season, "round": args.round, "ok": ok}
    doc["runs"] = [r.summary() for r in records]
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"summary: {path}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
