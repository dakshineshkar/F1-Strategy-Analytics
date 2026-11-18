"""Race replays started from the API (``POST /api/races/{s}/{r}/replay``): the whole pipeline.

A replay is what ``make stream-demo`` runs, so the race shows up in Redis and on the SSE stream:

1. **Stream job**: ``python -m f1sa.streaming.stream_job --checkpoint data/checkpoints/api_<run_id>
   --stop-after-session-end S:R --ready-file … --results-dir data/demo/<run_id>``. It must write its
   ready file (the query has run its first trigger, so ``startingOffsets=latest`` is resolved)
   within ``ready_timeout_s`` (60 s). Otherwise it is killed and the replay fails.
2. **Producer**: ``python -m f1sa.streaming.producer --season S --round R --speed V``.
3. The stream job stops by itself after it has processed the race's ``session_end``. It must do
   so within ``end_timeout_s`` of the producer's exit.

Every outcome (finished, a failed step, a timeout, API shutdown) ends with both subprocesses
stopped. Each one is started in its own process group (``start_new_session``), and the whole group
is signalled (SIGTERM, then SIGKILL after ``grace_s``), so the Spark JVM each one launches goes
with it. After a normal exit the group is still swept with SIGKILL, so nothing is orphaned. The slot
then returns to idle, and the job's state and error stay in ``status()`` (``GET /api/replays``).

**Controls (Feature 7).** While a replay is active (starting, running or paused) it can be paused,
resumed, given another speed (1, 10, 60) or stopped:

* Pause, resume and speed write ``data/demo/<run_id>/replay_control.json`` (``{version, speed,
  paused}``, atomic replace), which the producer (``--control-file``) re-reads between short
  sleeps. Only the pacing changes; the events, their order, ids and content do not. The producer
  writes ``replay_progress.json`` (lap reached, events sent), which ``status()`` reports.
* Stop ends both processes with the same teardown as a failure (``_stop_processes``, then
  ``_finish``) and records ``stopped`` with the lap reached. No ``session_end`` is published: the
  race keys keep the safety TTL of their last write, and the partial outputs stay.
* The total pause of a run is capped at ``max_pause_s`` (``API_REPLAY_MAX_PAUSE_S``); past it the
  run is stopped (state ``stopped`` with a ``note``). The stream job's backstop timeout is therefore
  ``ready + RACE_SECONDS / min(SPEEDS) + max_pause + end`` whatever the start speed.

**Fresh start (lifecycle rule, approved 2026-11-18).** ``start`` calls ``clear_race`` (the API's
``AsyncRaceStore.delete_race``: SCAN + DEL of ``race:{s}:{r}:*``) after the slot checks, so only
while no replay of that race runs, and before anything is launched. A failure there refuses the
start (``ReplayStoreError``) with nothing registered. ``meta:*`` and other races are never touched.

Outputs go to ``data/demo/<run_id>/``, never to ``results/``. At most ``max_running`` replays run at
once (``API_MAX_REPLAYS``, default 1). Season 2025 is refused with the producer's own
``check_season`` unless ``allow_test_season``, which then passes ``--allow-test-season`` to both
processes. Child output is read line by line into the JSON log; draining it also keeps a chatty
JVM from blocking on a full pipe.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from f1sa.demo_runs import run_dir, run_id
from f1sa.streaming.producer import (
    RefusedError,
    ReplayControl,
    check_season,
    read_progress,
    write_control,
)

log = logging.getLogger(__name__)

SPEEDS: tuple[int, ...] = (1, 10, 60)
MAX_LOG_LINE = 500
RACE_SECONDS = 7200.0
"""Upper bound of a race's span in race-seconds (the stream job's own backstop timeout)."""
HISTORY = 20
WAIT_POLL_S = 0.05
CONTROL_FILE = "replay_control.json"
PROGRESS_FILE = "replay_progress.json"
DECISIONS_FILE = "decisions.jsonl"
STOP_REQUESTED = "stopped by request"

State = Literal["starting", "running", "paused", "stopped", "finished", "failed"]
ACTIVE_STATES: tuple[State, ...] = ("starting", "running", "paused")


class ProcessLike(Protocol):
    @property
    def returncode(self) -> int | None: ...

    @property
    def stdout(self) -> asyncio.StreamReader | None: ...

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...

    def kill_group(self) -> None:
        """SIGKILL whatever is left of the process group (a no-op when it is empty)."""
        ...


Launcher = Callable[[Sequence[str]], Awaitable[ProcessLike]]


class ReplayRefusedError(RuntimeError):
    """A replay the producer would refuse (the sealed test season)."""


class ReplayConflictError(RuntimeError):
    def __init__(self, reason: Literal["running", "limit"], message: str) -> None:
        super().__init__(message)
        self.reason = reason


class ReplayNotRunningError(RuntimeError):
    """A control (stop, pause, resume, speed) for a race with no active replay (HTTP 409)."""


class ReplayStoreError(RuntimeError):
    """The race's old keys could not be deleted before a start; nothing was started (HTTP 503)."""


ClearRace = Callable[[int, int], Awaitable[int]]


class GroupProcess:
    """An ``asyncio`` subprocess that leads its own process group; signals go to the group."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self.pid = proc.pid

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    @property
    def stdout(self) -> asyncio.StreamReader | None:
        return self._proc.stdout

    async def wait(self) -> int:
        """The exit code as soon as the leader exits. ``asyncio``'s own ``wait()`` (3.12) also
        waits for the pipes to close, which a straggler holding stdout (a JVM left behind) would
        block forever; the group sweep after this kills such stragglers."""
        while self._proc.returncode is None:
            await asyncio.sleep(WAIT_POLL_S)
        return self._proc.returncode

    def _signal(self, sig: signal.Signals) -> None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.pid, sig)

    def terminate(self) -> None:
        self._signal(signal.SIGTERM)

    def kill(self) -> None:
        self._signal(signal.SIGKILL)

    def kill_group(self) -> None:
        self._signal(signal.SIGKILL)


async def subprocess_launcher(argv: Sequence[str]) -> ProcessLike:
    """Start ``argv`` in a new session (own process group), stdout+stderr in one pipe, no stdin."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    return GroupProcess(proc)


def producer_argv(
    season: int,
    round_: int,
    speed: int,
    *,
    allow_test_season: bool,
    python: str = sys.executable,
    control_file: Path | None = None,
    progress_file: Path | None = None,
) -> list[str]:
    """The producer's argv; ``control_file`` / ``progress_file`` make it a controlled replay."""
    argv = [python, "-m", "f1sa.streaming.producer"]
    argv += ["--season", str(season), "--round", str(round_), "--speed", str(speed)]
    if control_file is not None:
        argv += ["--control-file", str(control_file)]
    if progress_file is not None:
        argv += ["--progress-file", str(progress_file)]
    if allow_test_season:
        argv.append("--allow-test-season")
    return argv


def stream_job_argv(
    season: int,
    round_: int,
    *,
    checkpoint: Path,
    ready_file: Path,
    results_dir: Path,
    timeout_s: float,
    allow_test_season: bool,
    python: str = sys.executable,
    model_dir: Path | None = None,
    decisions_out: Path | None = None,
) -> list[str]:
    """The stream job's argv. ``model_dir`` (the API's ``API_MODEL_DIR``) makes the replay score
    with the model ``/api/health`` reports; ``None`` keeps the stream job's default.
    ``decisions_out`` makes it write its eligible decisions there when it stops."""
    argv = [python, "-m", "f1sa.streaming.stream_job"]
    argv += ["--checkpoint", str(checkpoint), "--stop-after-session-end", f"{season}:{round_}"]
    argv += ["--ready-file", str(ready_file), "--results-dir", str(results_dir)]
    argv += ["--timeout-s", str(int(timeout_s))]
    if decisions_out is not None:
        argv += ["--decisions-out", str(decisions_out)]
    if model_dir is not None:
        argv += ["--model-dir", str(model_dir)]
    if allow_test_season:
        argv.append("--allow-test-season")
    return argv


def utc_now() -> datetime:
    return datetime.now(UTC)


def _iso(ts: datetime | None) -> str | None:
    if ts is None:
        return None
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"


@dataclass
class ReplayJob:
    season: int
    round: int
    speed: int
    run_id: str
    results_dir: Path
    started_at: datetime
    state: State = "starting"
    error: str | None = None
    ended_at: datetime | None = None
    stream: ProcessLike | None = field(default=None, repr=False)
    producer: ProcessLike | None = field(default=None, repr=False)
    stream_returncode: int | None = None
    producer_returncode: int | None = None
    task: asyncio.Task[None] | None = field(default=None, repr=False)
    readers: list[asyncio.Task[None]] = field(default_factory=list, repr=False)
    paused: bool = False
    lap: int | None = None
    events_sent: int | None = None
    note: str | None = None
    running_at: datetime | None = None
    paused_at: datetime | None = None
    updated_at: datetime | None = None
    control_version: int = 0
    pause_total_s: float = 0.0
    paused_since: float | None = field(default=None, repr=False)
    """``loop.time()`` when the current pause began (``None`` while not paused)."""
    stop_reason: str | None = None
    stop_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def active(self) -> bool:
        return self.state in ACTIVE_STATES

    @property
    def control_file(self) -> Path:
        return self.results_dir / CONTROL_FILE

    @property
    def progress_file(self) -> Path:
        return self.results_dir / PROGRESS_FILE

    def paused_for_s(self, now: float) -> float:
        """Total time paused so far (the current pause included), in seconds."""
        current = 0.0 if self.paused_since is None else max(0.0, now - self.paused_since)
        return self.pause_total_s + current

    def to_dict(self) -> dict[str, Any]:
        return {
            "season": self.season,
            "round": self.round,
            "speed": self.speed,
            "run_id": self.run_id,
            "results_dir": str(self.results_dir),
            "state": self.state,
            "paused": self.paused,
            "lap": self.lap,
            "events_sent": self.events_sent,
            "error": self.error,
            "note": self.note,
            "started_at": _iso(self.started_at),
            "running_at": _iso(self.running_at),
            "paused_at": _iso(self.paused_at),
            "updated_at": _iso(self.updated_at),
            "ended_at": _iso(self.ended_at),
            "stream_returncode": self.stream_returncode,
            "producer_returncode": self.producer_returncode,
        }


class ReplayManager:
    def __init__(
        self,
        launcher: Launcher = subprocess_launcher,
        *,
        max_running: int,
        allow_test_season: bool,
        demo_dir: Path = Path("data/demo"),
        checkpoint_root: Path = Path("data/checkpoints"),
        ready_timeout_s: float = 60.0,
        end_timeout_s: float = 180.0,
        grace_s: float = 10.0,
        poll_s: float = 0.1,
        python: str = sys.executable,
        clock: Callable[[], datetime] = utc_now,
        model_dir: Path | None = None,
        max_pause_s: float = 1800.0,
        clear_race: ClearRace | None = None,
    ) -> None:
        if max_running < 1:
            raise ValueError(f"max_running must be >= 1, got {max_running}")
        if not max_pause_s > 0:
            raise ValueError(f"max_pause_s must be > 0, got {max_pause_s}")
        self._launcher = launcher
        self.max_running = max_running
        self.allow_test_season = allow_test_season
        self.demo_dir = demo_dir
        self.checkpoint_root = checkpoint_root
        self.ready_timeout_s = ready_timeout_s
        self.end_timeout_s = end_timeout_s
        self.grace_s = grace_s
        self.poll_s = poll_s
        self.python = python
        self.model_dir = model_dir
        self.max_pause_s = max_pause_s
        self._clear_race = clear_race
        self._clock = clock
        self._lock = asyncio.Lock()
        self._closing = False
        self.jobs: dict[tuple[int, int], ReplayJob] = {}
        self.history: list[ReplayJob] = []

    # ------------------------------------------------------------------ public
    def running(self) -> list[ReplayJob]:
        """Every replay that holds a slot: active, or ended (finished, stopped, failed) while
        its processes are still being stopped. Such a job is listed here until ``_finish`` moves
        it to ``history``, so ``GET /api/replays`` always shows it, and the replay guard and a
        new start (409) agree with what is listed."""
        return list(self.jobs.values())

    def status(self) -> dict[str, Any]:
        return {
            "max_running": self.max_running,
            "running": [j.to_dict() for j in self.running()],
            "recent": [j.to_dict() for j in reversed(self.history)],
        }

    async def start(self, season: int, round_: int, speed: int) -> ReplayJob:
        """Launch the stream job and return; the rest of the pipeline runs in a task.
        ``OSError`` (launch or output folder) propagates and nothing is registered."""
        if speed not in SPEEDS:
            raise ValueError(f"speed must be one of {SPEEDS}, got {speed}")
        try:
            check_season(season, self.allow_test_season)
        except RefusedError as exc:
            raise ReplayRefusedError(str(exc)) from exc
        async with self._lock:
            key = (season, round_)
            if key in self.jobs:
                raise ReplayConflictError("running", f"a replay of {season} R{round_} is running")
            if len(self.jobs) >= self.max_running:
                raise ReplayConflictError(
                    "limit", f"replay limit reached ({self.max_running} running)"
                )
            deleted = await self._clear(season, round_)
            now = self._clock()
            rid = run_id(season, round_, now)
            results = run_dir(self.demo_dir, rid)
            results.mkdir(parents=True, exist_ok=False)
            write_control(results / CONTROL_FILE, ReplayControl(speed))
            self.checkpoint_root.mkdir(parents=True, exist_ok=True)
            ready = self.checkpoint_root / f"api_{rid}.ready"
            argv = stream_job_argv(
                season,
                round_,
                checkpoint=self.checkpoint_root / f"api_{rid}",
                ready_file=ready,
                results_dir=results,
                timeout_s=self.stream_timeout_s(),
                allow_test_season=self.allow_test_season,
                python=self.python,
                model_dir=self.model_dir,
                decisions_out=results / DECISIONS_FILE,
            )
            stream = await self._launcher(argv)
            job = ReplayJob(season, round_, speed, rid, results, now, stream=stream)
            job.updated_at = now
            if deleted:
                log.info("old race keys deleted", extra={**self._ctx(job), "keys": deleted})
            self._read_output(job, stream, "stream_job")
            self.jobs[key] = job
            job.task = asyncio.create_task(self._run(job, ready))
        log.info("replay started", extra=self._ctx(job))
        return job

    def stream_timeout_s(self) -> float:
        """The stream job's own backstop: ready, the whole race at the slowest speed, the longest
        total pause, then the end wait (a speed change or a pause can never outrun it)."""
        return (
            self.ready_timeout_s
            + RACE_SECONDS / min(SPEEDS)
            + self.max_pause_s
            + self.end_timeout_s
        )

    async def pause(self, season: int, round_: int) -> ReplayJob:
        """Pause the race's active replay (a no-op when it is already paused)."""
        async with self._lock:
            job = self._controllable(season, round_)
            if not job.paused:
                self._write_control(job, paused=True)
                job.paused = True
                job.paused_at = job.updated_at
                job.paused_since = asyncio.get_running_loop().time()
                if job.state == "running":
                    job.state = "paused"
                log.info("replay paused", extra={**self._ctx(job), "lap": job.lap})
        return job

    async def resume(self, season: int, round_: int) -> ReplayJob:
        """Resume the race's paused replay (a no-op when it is not paused)."""
        async with self._lock:
            job = self._controllable(season, round_)
            if job.paused:
                self._write_control(job, paused=False)
                now = asyncio.get_running_loop().time()
                job.pause_total_s = job.paused_for_s(now)
                job.paused, job.paused_at, job.paused_since = False, None, None
                if job.state == "paused":
                    job.state = "running"
                log.info("replay resumed", extra={**self._ctx(job), "lap": job.lap})
        return job

    async def set_speed(self, season: int, round_: int, speed: int) -> ReplayJob:
        """Change the race's active replay to ``speed`` (paused or not; a no-op when unchanged)."""
        if speed not in SPEEDS:
            raise ValueError(f"speed must be one of {SPEEDS}, got {speed}")
        async with self._lock:
            job = self._controllable(season, round_)
            if speed != job.speed:
                self._write_control(job, speed=speed)
                old, job.speed = job.speed, speed
                log.info(
                    "replay speed changed",
                    extra={**self._ctx(job), "from": old, "to": speed, "lap": job.lap},
                )
        return job

    async def stop(self, season: int, round_: int) -> ReplayJob:
        """Stop the race's active replay and return once both processes are gone (state
        ``stopped``). A second stop while the first is under way waits for the same end."""
        async with self._lock:
            job = self.jobs.get((season, round_))
            if job is None or not job.active:
                raise ReplayNotRunningError(f"no replay of {season} R{round_} is running")
            if job.stop_reason is None:
                job.stop_reason = STOP_REQUESTED
                job.stop_event.set()
                log.info("replay stop requested", extra={**self._ctx(job), "lap": job.lap})
        if job.task is not None:
            await asyncio.shield(job.task)
        return job

    async def shutdown(self) -> None:
        """Stop every running replay (both processes) and wait for their tasks."""
        self._closing = True
        jobs = list(self.jobs.values())
        for job in jobs:
            await self._stop_processes(job)
        for job in jobs:
            if job.task is not None:
                try:
                    await asyncio.wait_for(job.task, self.grace_s * 2)
                except TimeoutError:
                    job.task.cancel()

    # ------------------------------------------------------------------ controls
    async def _clear(self, season: int, round_: int) -> int:
        if self._clear_race is None:
            return 0
        try:
            return await self._clear_race(season, round_)
        except Exception as exc:
            log.error(
                "old race keys not deleted",
                extra={"season": season, "round": round_, "exc_class": type(exc).__name__},
            )
            raise ReplayStoreError(
                f"the old keys of {season} R{round_} could not be deleted; nothing was started"
            ) from exc

    def _controllable(self, season: int, round_: int) -> ReplayJob:
        job = self.jobs.get((season, round_))
        if job is None or not job.active:
            raise ReplayNotRunningError(f"no replay of {season} R{round_} is running")
        if job.stop_reason is not None:
            raise ReplayNotRunningError(f"the replay of {season} R{round_} is stopping")
        return job

    def _write_control(
        self, job: ReplayJob, *, speed: int | None = None, paused: bool | None = None
    ) -> None:
        """Write the next control version (``OSError`` propagates, nothing changes then)."""
        control = ReplayControl(
            float(job.speed if speed is None else speed),
            job.paused if paused is None else paused,
            job.control_version + 1,
        )
        write_control(job.control_file, control)
        job.control_version = control.version
        job.updated_at = self._clock()

    def _refresh_progress(self, job: ReplayJob) -> None:
        progress = read_progress(job.progress_file)
        if progress is not None:
            job.lap, job.events_sent = progress.lap, progress.events_sent

    def _stop_due(self, job: ReplayJob) -> bool:
        """True once a stop was requested or the pause cap was passed (which requests one)."""
        now = asyncio.get_running_loop().time()
        if job.stop_reason is None and job.paused and job.paused_for_s(now) > self.max_pause_s:
            job.stop_reason = f"paused longer than {self.max_pause_s:g} s"
            job.stop_event.set()
        return job.stop_reason is not None

    def _mark_stopped(self, job: ReplayJob) -> None:
        self._refresh_progress(job)
        job.state = "stopped"
        if job.stop_reason != STOP_REQUESTED:
            job.note = job.stop_reason
        log.info(
            "replay stopped", extra={**self._ctx(job), "lap": job.lap, "reason": job.stop_reason}
        )

    async def _wait_or_stop(
        self, job: ReplayJob, proc: ProcessLike, timeout_s: float | None
    ) -> str:
        """``"exited"``, ``"stop"`` (a stop is due) or ``"timeout"``; refreshes the progress."""
        loop = asyncio.get_running_loop()
        deadline = None if timeout_s is None else loop.time() + timeout_s
        while True:
            if self._stop_due(job):
                return "stop"
            if proc.returncode is not None:
                return "exited"
            if deadline is not None and loop.time() >= deadline:
                return "timeout"
            self._refresh_progress(job)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(job.stop_event.wait(), self.poll_s)

    # ------------------------------------------------------------------ pipeline
    @staticmethod
    def _ctx(job: ReplayJob) -> dict[str, Any]:
        return {"season": job.season, "round": job.round, "run_id": job.run_id}

    def _read_output(self, job: ReplayJob, proc: ProcessLike, name: str) -> None:
        stream = proc.stdout
        if stream is None:
            return

        async def reader() -> None:
            async for line in stream:
                text = line.decode("utf-8", errors="replace").rstrip()[:MAX_LOG_LINE]
                if text:
                    log.info("replay output", extra={**self._ctx(job), "proc": name, "line": text})

        job.readers.append(asyncio.create_task(reader()))

    async def _wait_ready(self, job: ReplayJob, ready: Path) -> str | None:
        """``None`` once the ready file exists, else the reason it never became ready."""
        assert job.stream is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.ready_timeout_s
        while True:
            if self._stop_due(job):
                return None
            if ready.exists():
                return None
            if job.stream.returncode is not None:
                return f"stream job exited with code {job.stream.returncode} before it was ready"
            if loop.time() >= deadline:
                return f"stream job not ready within {self.ready_timeout_s:g} s"
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(job.stop_event.wait(), self.poll_s)

    async def _run(self, job: ReplayJob, ready: Path) -> None:
        assert job.stream is not None
        try:
            reason = await self._wait_ready(job, ready)
            if reason is not None:
                self._fail(job, reason)
                return
            if self._stop_due(job):
                return
            async with self._lock:  # a control between the launch and the state is not lost
                job.producer = await self._launcher(
                    producer_argv(
                        job.season,
                        job.round,
                        job.speed,
                        allow_test_season=self.allow_test_season,
                        python=self.python,
                        control_file=job.control_file,
                        progress_file=job.progress_file,
                    )
                )
                job.state = "paused" if job.paused else "running"
                job.running_at = self._clock()
            self._read_output(job, job.producer, "producer")
            if await self._wait_or_stop(job, job.producer, None) == "stop":
                return
            job.producer_returncode = await job.producer.wait()
            if job.producer_returncode != 0:
                self._fail(job, f"producer exited with code {job.producer_returncode}")
                return
            outcome = await self._wait_or_stop(job, job.stream, self.end_timeout_s)
            if outcome == "stop":
                return
            if outcome == "timeout":
                self._fail(
                    job,
                    f"stream job did not stop within {self.end_timeout_s:g} s after the producer",
                )
                return
            rc = await job.stream.wait()
            job.stream_returncode = rc
            if rc != 0:
                self._fail(job, f"stream job exited with code {rc}")
            else:
                job.state = "finished"
        except Exception as exc:
            self._fail(job, f"{type(exc).__name__}: replay step failed")
        finally:
            await self._stop_processes(job)
            if job.active and job.stop_reason is not None and not self._closing:
                self._mark_stopped(job)  # only once both process groups are gone
            await self._finish(job)

    def _fail(self, job: ReplayJob, reason: str) -> None:
        if self._closing:
            reason = f"API shutdown ({reason})"
        job.state, job.error = "failed", reason
        log.warning("replay failed", extra={**self._ctx(job), "error": reason})

    async def _stop(self, proc: ProcessLike | None) -> int | None:
        if proc is None:
            return None
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), self.grace_s)
            except TimeoutError:
                proc.kill()
                await proc.wait()
        proc.kill_group()  # sweep anything the leader left behind (its JVM)
        return proc.returncode

    async def _stop_processes(self, job: ReplayJob) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.shield(self._stop_both(job))

    async def _stop_both(self, job: ReplayJob) -> None:
        rc_p = await self._stop(job.producer)
        rc_s = await self._stop(job.stream)
        if job.producer is not None and job.producer_returncode is None:
            job.producer_returncode = rc_p
        if job.stream_returncode is None:
            job.stream_returncode = rc_s

    async def _finish(self, job: ReplayJob) -> None:
        for reader in job.readers:
            try:
                await asyncio.wait_for(reader, self.grace_s)
            except TimeoutError:
                reader.cancel()
        if job.active:  # stopped from outside (shutdown)
            self._fail(job, "stopped")
        self._refresh_progress(job)
        if job.paused_since is not None:
            job.pause_total_s = job.paused_for_s(asyncio.get_running_loop().time())
            job.paused_since = None
        job.ended_at = self._clock()
        if self.jobs.get((job.season, job.round)) is job:
            del self.jobs[(job.season, job.round)]
        self.history = [*self.history[-(HISTORY - 1) :], job]
        level = logging.INFO if job.state in ("finished", "stopped") else logging.WARNING
        log.log(
            level,
            "replay ended",
            extra={
                **self._ctx(job),
                "state": job.state,
                "error": job.error,
                "lap": job.lap,
                "stream_returncode": job.stream_returncode,
                "producer_returncode": job.producer_returncode,
            },
        )
