"""Refuse to recreate the api container while a replay is running (``make up``, ``up-full``,
``api-up``).

A replay runs inside the api container (the stream job and the producer are its subprocesses), so
recreating the container cuts it off mid-race. It is left without ``session_end``, with partial
outputs in ``data/demo/<run_id>/``. That happened twice (Fix E, Feature 1), so every target that
can recreate the api runs this check **before anything else**: ``make api-up`` (before the
UI-latency backup and the recreate), and ``make up`` / ``up-full``, whose ``--build`` recreates the
api whenever its image or configuration changed (``REPLAY_GUARD`` in the Makefile).

**Dependency-free.** It uses the standard library only and imports nothing from ``f1sa``. The
Makefile runs it as a plain script with the system ``python3`` (3.8 or newer), so ``make up`` on a
fresh clone needs neither ``uv`` nor the project environment::

    python3 -I src/f1sa/replay_guard.py [--url http://127.0.0.1:8000] [--force]
    python -m f1sa.replay_guard ...          # the same module, inside the project environment

It asks ``GET {url}/api/replays``:

* exit 0: no replay is running, or the api is not reachable at all (connection refused or reset:
  there is no running container to cut off);
* exit 2: one or more replays are running. They are listed with their run id, race, speed and
  start time. Wait for them to finish, or pass ``--force`` (``make api-up FORCE=1``) to recreate
  anyway;
* exit 3: the api answered but the answer could not be read (a timeout, an HTTP error, a body that
  is not the replay status). It cannot be verified, so it refuses too, unless ``--force``.

``--force`` never skips the request: it prints what it would have refused and exits 0.
"""

from __future__ import annotations

import argparse
import http.client
import json
import socket
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TextIO

if TYPE_CHECKING:  # annotations only: no runtime subscription of collections.abc (Python < 3.9)
    from collections.abc import Callable, Iterable

    Fetch = Callable[[str, float], bytes]

DEFAULT_URL = "http://127.0.0.1:8000"
EXIT_OK, EXIT_RUNNING, EXIT_UNVERIFIED = 0, 2, 3


class Unreachable(RuntimeError):
    """Nothing listens at the api URL (so there is no container whose replay could be cut off)."""


class Unverified(RuntimeError):
    """The api answered, but whether a replay runs cannot be read from the answer."""


def http_get(url: str, timeout_s: float) -> bytes:
    """GET ``url``; ``Unreachable`` for a refused or reset connection, ``Unverified`` otherwise."""
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as resp:
            body: bytes = resp.read()
            return body
    except urllib.error.HTTPError as exc:
        raise Unverified(f"HTTP {exc.code} from {url}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (ConnectionRefusedError, ConnectionResetError)):
            raise Unreachable(f"nothing listens at {url}") from exc
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise Unverified(f"no answer from {url} within {timeout_s:g} s") from exc
        raise Unverified(f"{url}: {exc.reason}") from exc
    except (ConnectionResetError, http.client.RemoteDisconnected) as exc:
        raise Unreachable(f"{url} closed the connection") from exc
    except TimeoutError as exc:
        raise Unverified(f"no answer from {url} within {timeout_s:g} s") from exc


@dataclass(frozen=True)
class Running:
    run_id: str
    season: Any
    round: Any
    speed: Any
    state: Any
    started_at: Any

    def describe(self) -> str:
        return (
            f"{self.run_id} ({self.season} R{self.round}, {self.speed}x, {self.state}, "
            f"started {self.started_at})"
        )


def parse_running(body: bytes) -> list[Running]:
    """The ``running`` list of ``GET /api/replays``; ``Unverified`` if the body is not that."""
    try:
        doc = json.loads(body)
    except ValueError as exc:
        raise Unverified("the replay status is not JSON") from exc
    running = doc.get("running") if isinstance(doc, dict) else None
    if not isinstance(running, list) or not all(isinstance(r, dict) for r in running):
        raise Unverified("the replay status has no 'running' list")
    return [
        Running(
            run_id=str(r.get("run_id", "?")),
            season=r.get("season"),
            round=r.get("round"),
            speed=r.get("speed"),
            state=r.get("state"),
            started_at=r.get("started_at"),
        )
        for r in running
    ]


def check(
    url: str,
    *,
    force: bool,
    timeout_s: float = 3.0,
    fetch: Fetch = http_get,
    out: TextIO = sys.stdout,
    err: TextIO = sys.stderr,
) -> int:
    """Exit code for ``make api-up`` (see the module docstring)."""
    status_url = url.rstrip("/") + "/api/replays"
    try:
        running = parse_running(fetch(status_url, timeout_s))
    except Unreachable as exc:
        print(f"replay guard: api not reachable ({exc}); no replay to cut off", file=out)
        return EXIT_OK
    except Unverified as exc:
        if force:
            print(f"replay guard: cannot verify ({exc}); FORCE=1, recreating anyway", file=err)
            return EXIT_OK
        print(
            f"replay guard: refusing to recreate the api: cannot tell whether a replay is running "
            f"({exc}). Check {status_url}, or run with FORCE=1.",
            file=err,
        )
        return EXIT_UNVERIFIED
    if not running:
        print("replay guard: no replay running", file=out)
        return EXIT_OK
    listed = "\n".join(f"  - {r.describe()}" for r in running)
    if force:
        print(
            f"replay guard: FORCE=1: recreating the api cuts off {len(running)} running "
            f"replay(s):\n{listed}",
            file=err,
        )
        return EXIT_OK
    print(
        f"replay guard: refusing to recreate the api: {len(running)} replay(s) running "
        f"(a recreate would cut them off mid-race):\n{listed}\n"
        "Wait until GET /api/replays shows none running, or run with FORCE=1.",
        file=err,
    )
    return EXIT_RUNNING


def main(argv: Iterable[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m f1sa.replay_guard", description=__doc__.split("\n\n")[0]
    )
    p.add_argument("--url", default=DEFAULT_URL, help=f"the api base URL (default {DEFAULT_URL})")
    p.add_argument("--force", action="store_true", help="recreate even if a replay is running")
    p.add_argument("--timeout", type=float, default=3.0, help="request timeout in seconds")
    args = p.parse_args(list(argv) if argv is not None else None)
    if not args.url.startswith(("http://", "https://")):
        print(f"replay guard: --url must be http(s)://..., got {args.url!r}", file=sys.stderr)
        return EXIT_UNVERIFIED
    return check(args.url, force=args.force, timeout_s=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
