"""``make up``, ``make up-full`` and ``make api-up`` refuse to recreate the api while a replay
runs, unless FORCE=1.

The decision (``replay_guard.check``) is tested with a fake fetch; ``http_get`` against real local
HTTP servers (answering, closed port, HTTP 500, too slow); that the script imports only the
standard library and runs with the system ``python3`` and no uv on PATH; the Makefile wiring with
``make -n``; and a real ``make up`` / ``up-full`` / ``api-up`` (no uv on PATH) against a fake api
that reports a running replay, with ``COMPOSE`` replaced, so even a broken guard could never
recreate a real container.
"""

from __future__ import annotations

import ast
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from f1sa import replay_guard as G

REPO = Path(__file__).resolve().parents[2]

RUNNING = {
    "enabled": True,
    "max_running": 1,
    "running": [
        {
            "season": 2024,
            "round": 5,
            "speed": 60,
            "run_id": "2024_5_20261115T164446.116Z",
            "state": "running",
            "started_at": "2026-11-15T16:44:46.116Z",
        }
    ],
    "recent": [],
}
IDLE = {**RUNNING, "running": []}


def _fetch(body: Any) -> G.Fetch:
    def fetch(url: str, timeout_s: float) -> bytes:
        assert url == "http://api.test:8000/api/replays"
        if isinstance(body, Exception):
            raise body
        return body if isinstance(body, bytes) else json.dumps(body).encode()

    return fetch


def _check(body: Any, *, force: bool = False) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = G.check("http://api.test:8000/", force=force, fetch=_fetch(body), out=out, err=err)
    return code, out.getvalue(), err.getvalue()


# ------------------------------------------------------------------ the decision
def test_no_replay_running_passes() -> None:
    code, out, err = _check(IDLE)
    assert (code, err) == (0, "") and "no replay running" in out


def test_a_running_replay_is_refused_and_listed() -> None:
    code, out, err = _check(RUNNING)
    assert code == G.EXIT_RUNNING == 2 and out == ""
    assert "refusing to recreate the api: 1 replay(s) running" in err
    assert (
        "2024_5_20261115T164446.116Z (2024 R5, 60x, running, started 2026-11-15T16:44:46.116Z)"
        in err
    )
    assert "FORCE=1" in err


def test_force_passes_but_still_names_the_replay() -> None:
    code, _out, err = _check(RUNNING, force=True)
    assert code == 0
    assert "FORCE=1: recreating the api cuts off 1 running replay(s)" in err
    assert "2024_5_20261115T164446.116Z" in err


def test_an_unreachable_api_has_nothing_to_cut_off() -> None:
    code, out, _err = _check(G.Unreachable("nothing listens"))
    assert code == 0 and "api not reachable" in out


@pytest.mark.parametrize(
    "body",
    [G.Unverified("HTTP 500"), b"<html>", b'{"running": "yes"}', b"[1, 2]", b'{"running": [1]}'],
)
def test_an_unreadable_answer_is_refused_unless_forced(body: Any) -> None:
    code, _out, err = _check(body)
    assert code == G.EXIT_UNVERIFIED == 3 and "cannot tell whether a replay is running" in err
    forced, _o, ferr = _check(body, force=True)
    assert forced == 0 and "cannot verify" in ferr


def test_main_rejects_a_non_http_url(capsys: pytest.CaptureFixture[str]) -> None:
    assert G.main(["--url", "redis://localhost:6379"]) == 3
    assert "--url must be http(s)" in capsys.readouterr().err


# ------------------------------------------------------------------ real HTTP
class _Server:
    def __init__(self, status: int, body: bytes, delay_s: float = 0.0) -> None:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                outer.paths.append(self.path)
                time.sleep(delay_s)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                return None

        self.paths: list[str] = []
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> _Server:
        self.thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_http_get_reads_the_replay_status() -> None:
    with _Server(200, json.dumps(RUNNING).encode()) as srv:
        assert G.check(srv.url, force=False, err=io.StringIO()) == 2
        assert srv.paths == ["/api/replays"]


def test_http_get_closed_port_is_unreachable() -> None:
    with pytest.raises(G.Unreachable):
        G.http_get(f"http://127.0.0.1:{_free_port()}/api/replays", 2.0)


def test_http_get_error_status_and_timeout_are_unverified() -> None:
    with _Server(500, b"{}") as srv, pytest.raises(G.Unverified, match="HTTP 500"):
        G.http_get(f"{srv.url}/api/replays", 2.0)
    slow = _Server(200, json.dumps(IDLE).encode(), delay_s=1.0)
    with slow, pytest.raises(G.Unverified, match="no answer"):
        G.http_get(f"{slow.url}/api/replays", 0.2)


# ------------------------------------------------------------------ dependency-free script
SCRIPT = REPO / "src" / "f1sa" / "replay_guard.py"
GUARD_LINE = "python3 -I src/f1sa/replay_guard.py --url http://127.0.0.1:8000"


def _system_env() -> dict[str, str]:
    """An environment with only the system tool folders on PATH: no uv, no project venv."""
    dirs = [d for d in ("/usr/local/bin", "/usr/bin", "/bin") if Path(d).is_dir()]
    path = os.pathsep.join(dirs)
    for tool in ("python3", "make"):
        if shutil.which(tool, path=path) is None:
            pytest.skip(f"no system {tool} in {path}")
    if shutil.which("uv", path=path) is not None:
        pytest.skip("uv is installed system-wide, so it cannot be excluded from PATH")
    return {"PATH": path, "HOME": os.environ.get("HOME", "/tmp"), "LC_ALL": "C.UTF-8"}


def test_the_guard_imports_only_the_standard_library() -> None:
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    assert names, "no imports found"
    assert names <= set(sys.stdlib_module_names) | {"__future__"}, names - set(
        sys.stdlib_module_names
    )
    assert "f1sa" not in names


def test_no_sibling_module_shadows_an_import_of_the_script() -> None:
    """Run as a script, ``src/f1sa/`` is sys.path[0] on Python < 3.11 even with -I."""
    siblings = {p.stem for p in SCRIPT.parent.iterdir() if p.suffix == ".py" or p.is_dir()}
    imported = {"argparse", "http", "json", "socket", "sys", "urllib", "dataclasses", "typing"}
    assert not siblings & imported


def _script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", "-I", str(SCRIPT), *args],
        cwd=REPO,
        env=_system_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_script_runs_with_the_system_python3_without_uv() -> None:
    """``make up`` on a fresh clone: system python3, no uv, no project environment."""
    res = _script("--url", f"http://127.0.0.1:{_free_port()}")
    assert res.returncode == 0 and "api not reachable" in res.stdout, res.stderr
    with _Server(200, json.dumps(IDLE).encode()) as idle:
        res = _script("--url", idle.url)
    assert res.returncode == 0 and "no replay running" in res.stdout, res.stderr
    with _Server(200, json.dumps(RUNNING).encode()) as busy:
        refused, forced = _script("--url", busy.url), _script("--url", busy.url, "--force")
    assert refused.returncode == 2 and "2024_5_20261115T164446.116Z" in refused.stderr
    assert forced.returncode == 0 and "FORCE=1: recreating the api cuts off" in forced.stderr
    with _Server(500, b"{}") as broken:
        assert _script("--url", broken.url).returncode == 3


# ------------------------------------------------------------------ Makefile
def _make(
    *args: str, dry: bool = True, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    if shutil.which("make") is None:
        pytest.skip("make not installed")
    cmd = ["make", *(["-n"] if dry else []), "--no-print-directory", "-C", str(REPO), *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)


RECREATING = ("up", "up-full", "api-up")
"""Every target that can recreate the api container (``up`` / ``up-full`` rebuild with --build)."""


def test_api_up_runs_the_guard_first_and_force_only_with_1() -> None:
    out = _make("api-up", "DEBUG=1", "UI_LATENCY_CSV=results/ui_latency.csv").stdout.splitlines()
    guard = next(i for i, line in enumerate(out) if "replay_guard" in line)
    assert out[guard] == GUARD_LINE
    recording = next(i for i, line in enumerate(out) if "f1sa.recording" in line)
    recreate = next(i for i, line in enumerate(out) if "--force-recreate api" in line)
    assert guard < recording < recreate
    assert "--url http://127.0.0.1:8123" in _make("api-up", "API_HOST_PORT=8123").stdout


@pytest.mark.parametrize("target", ["up", "up-full"])
def test_up_targets_run_the_guard_before_compose(target: str) -> None:
    out = _make(target).stdout.splitlines()
    guard = next(i for i, line in enumerate(out) if "replay_guard" in line)
    compose = next(i for i, line in enumerate(out) if line.startswith("docker compose --profile"))
    assert out[guard] == GUARD_LINE and guard < compose


@pytest.mark.parametrize("target", RECREATING)
def test_force_only_with_1_and_never_through_uv(target: str) -> None:
    assert f"{GUARD_LINE} --force" in _make(target, "FORCE=1").stdout
    assert f"{GUARD_LINE} --force" not in _make(target, "FORCE=yes").stdout
    guard = next(ln for ln in _make(target).stdout.splitlines() if "replay_guard" in ln)
    assert "uv" not in guard.split()


def test_demo_replay_goes_through_the_guarded_api_up() -> None:
    assert GUARD_LINE in _make("demo-replay").stdout


@pytest.mark.parametrize("target", RECREATING)
def test_make_refuses_to_recreate_while_a_replay_runs(target: str, tmp_path: Path) -> None:
    """A real ``make <target>`` (not -n) with no uv on PATH (and UV=false) stops at the guard:
    compose never runs. ``COMPOSE`` is replaced, so even a broken guard touches nothing real."""
    marker = tmp_path / "compose-called"
    env = _system_env()
    with _Server(200, json.dumps(RUNNING).encode()) as srv:
        res = _make(
            target,
            f"API_GUARD_URL={srv.url}",
            f"COMPOSE=touch {marker}; echo",
            "UV=false",
            dry=False,
            env=env,
        )
    assert res.returncode != 0
    assert "refusing to recreate the api: 1 replay(s) running" in res.stderr, res.stderr
    assert "2024_5_20261115T164446.116Z" in res.stderr
    assert not marker.exists(), f"make {target} ran compose although a replay was running"
    assert "--profile" not in res.stdout
    assert srv.paths == ["/api/replays"]


def test_module_entry_point_still_works() -> None:
    """``python -m f1sa.replay_guard`` (project environment) is the same code."""
    res = subprocess.run(
        [sys.executable, "-m", "f1sa.replay_guard", "--url", f"http://127.0.0.1:{_free_port()}"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert res.returncode == 0 and "api not reachable" in res.stdout
