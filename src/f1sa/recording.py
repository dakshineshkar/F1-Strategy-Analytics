"""The one guard of every recording path that writes the committed ``results/`` (Fix C).

A recording (``RECORD=1``) never replaces an existing results file by accident:

* ``check`` refuses, **before any work**, when one of the recording's output files exists. The
  message names the files and how to proceed. Files that this same run already recorded (a
  ``RESUME=<run_id>`` of an interrupted recording) can be passed as ``allowed``.
* A deliberate new recording passes ``overwrite`` (``RECORD=1 OVERWRITE=1``). Before the new files
  are written, ``backup`` **moves** the existing ones to ``data/results_backup/<UTC stamp>/``. It
  never deletes anything and refuses an existing backup folder.

The deterministic generators that always rewrite their tracked files (``make experiments`` checks
that they reproduce byte for byte) and the pre-registered, refuse-only recordings
(``model-test-full``, ``ablation-full``, ``oracle-dev-full``, ``whatif-consistency-full``) do not
use this module (``docs/reproduce.md`` §3).

CLI, for guards that run in the Makefile before a target starts anything::

    python -m f1sa.recording check  [--overwrite] FILE...   # exit 2 if refused
    python -m f1sa.recording backup FILE...                 # moves the existing ones, prints them
"""

from __future__ import annotations

import argparse
import shutil
import sys
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path

BACKUP_ROOT = Path("data/results_backup")
"""Where ``backup`` moves replaced results files (gitignored via ``data/*``)."""


class RecordRefused(RuntimeError):
    """A recording would replace existing results files (or a backup could not be made)."""


def existing(paths: Iterable[Path]) -> list[Path]:
    """The files of ``paths`` that exist, in the given order."""
    return [Path(p) for p in paths if Path(p).exists()]


def refusal_message(found: Sequence[Path]) -> str:
    names = ", ".join(str(p) for p in found)
    return (
        f"refusing to record: {len(found)} output file(s) already exist: {names}. "
        "Committed results are never overwritten by accident. To proceed: run without RECORD=1 "
        "(outputs go to data/), or, for a deliberate new recording, add OVERWRITE=1: the existing "
        f"files are first moved to {BACKUP_ROOT}/<UTC stamp>/ (never deleted)."
    )


def check(paths: Iterable[Path], *, overwrite: bool, allowed: Iterable[Path] = ()) -> list[Path]:
    """The existing outputs (minus ``allowed``, files this same run already recorded). Raises
    ``RecordRefused`` if there are any and ``overwrite`` is not set."""
    keep = {Path(p).resolve() for p in allowed}
    found = [p for p in existing(paths) if p.resolve() not in keep]
    if found and not overwrite:
        raise RecordRefused(refusal_message(found))
    return found


def stamp(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%S.%fZ")


def backup(
    paths: Iterable[Path],
    *,
    root: Path = BACKUP_ROOT,
    now: datetime | None = None,
    out: Callable[[str], None] = print,
) -> list[tuple[Path, Path]]:
    """Move every existing file of ``paths`` to ``root/<stamp>/<name>`` and return the
    ``(from, to)`` pairs. It never deletes. Raises ``RecordRefused`` if the stamp folder already
    exists or two files share a name. Nothing to move gives ``[]`` and no folder."""
    found = existing(paths)
    if not found:
        return []
    names = [p.name for p in found]
    if len(set(names)) != len(names):
        raise RecordRefused(f"cannot back up two files with the same name: {names}")
    dest = Path(root) / stamp(now)
    if dest.exists():
        raise RecordRefused(f"backup folder {dest} already exists; nothing was moved")
    dest.mkdir(parents=True)
    moved = []
    for p in found:
        target = dest / p.name
        shutil.move(str(p), str(target))
        moved.append((p, target))
        out(f"OVERWRITE=1: moved {p} -> {target}")
    return moved


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="f1sa.recording", description="results/ recording guard")
    p.add_argument("action", choices=("check", "backup"))
    p.add_argument("--overwrite", action="store_true", help="OVERWRITE=1: do not refuse")
    p.add_argument("files", nargs="+", type=Path)
    args = p.parse_args(list(argv) if argv is not None else None)
    if args.action == "check":
        try:
            found = check(args.files, overwrite=args.overwrite)
        except RecordRefused as exc:
            print(f"refused: {exc}", file=sys.stderr)
            return 2
        if found:
            print(f"OVERWRITE=1: {len(found)} existing file(s) will be backed up before writing")
        return 0
    try:
        backup(args.files)
    except RecordRefused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
