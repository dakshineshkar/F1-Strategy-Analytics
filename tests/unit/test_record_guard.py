"""Fix C: every recording path refuses to replace existing results files before doing any work;
``OVERWRITE=1`` first moves them to ``data/results_backup/<stamp>/`` (never deletes); the merge
paths (bench-supplement, RESUME of the same run) keep their own guards. Temp dirs only."""

from __future__ import annotations

import csv
import hashlib
import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from test_bench_report import (  # noqa: F401
    NOW,
    RAW,
    SMALL,
    FakeContainer,
    _partitioning_container,
    fake_host,
)
from test_bench_supplement import ROWS
from test_streaming_runs import _run

from f1sa import recording as REC
from f1sa.api.latency import LatencyRecorder, in_results
from f1sa.bench import host as H
from f1sa.bench import report as R
from f1sa.bench import streaming_runs as S
from f1sa.serving import latency_bench as LB

REPO = Path(__file__).resolve().parents[2]
T = datetime(2026, 11, 15, 10, 0, 0, 123456, tzinfo=UTC)


def _hashes(root: Path) -> dict[str, str]:
    if not root.exists():
        return {}
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def _write(root: Path, *names: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for n in names:
        (root / n).write_text(f"committed {n}\n")


# ------------------------------------------------------------------ the shared helper
def test_check_refuses_existing_outputs_and_names_them(tmp_path: Path) -> None:
    a, b, c = tmp_path / "a.csv", tmp_path / "b.png", tmp_path / "c.jsonl"
    assert REC.check([a, b], overwrite=False) == []
    _write(tmp_path, "a.csv", "b.png")
    with pytest.raises(REC.RecordRefused) as exc:
        REC.check([a, b, c], overwrite=False)
    msg = str(exc.value)
    assert str(a) in msg and str(b) in msg and str(c) not in msg
    assert "OVERWRITE=1" in msg and "data/results_backup" in msg and "never overwritten" in msg
    assert REC.check([a, b, c], overwrite=True) == [a, b]
    assert REC.check([a, b, c], overwrite=False, allowed=[a, b]) == []  # this run's own files


def test_backup_moves_never_deletes_and_refuses_an_existing_folder(tmp_path: Path) -> None:
    res = tmp_path / "results"
    _write(res, "x.csv", "y.png")
    before = _hashes(res)
    root = tmp_path / "data" / "results_backup"
    lines: list[str] = []
    moved = REC.backup(
        [res / "x.csv", res / "y.png", res / "missing.csv"], root=root, now=T, out=lines.append
    )
    dest = root / "20261115T100000.123456Z"
    assert moved == [(res / "x.csv", dest / "x.csv"), (res / "y.png", dest / "y.png")]
    assert not (res / "x.csv").exists() and _hashes(dest) == before
    assert len(lines) == 2 and all("OVERWRITE=1: moved" in ln for ln in lines)
    _write(res, "x.csv")
    with pytest.raises(REC.RecordRefused, match="already exists"):
        REC.backup([res / "x.csv"], root=root, now=T)
    assert (res / "x.csv").exists(), "nothing moved when the stamp folder exists"
    assert REC.backup([res / "nothing.csv"], root=root, now=T) == []
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "x.csv").write_text("dup")
    with pytest.raises(REC.RecordRefused, match="same name"):
        REC.backup([res / "x.csv", tmp_path / "other" / "x.csv"], root=tmp_path / "b2", now=T)


def test_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    _write(tmp_path / "results", "ui_latency.csv")
    target = "results/ui_latency.csv"
    assert REC.main(["check", target]) == 2
    assert "refused:" in capsys.readouterr().err
    assert REC.main(["check", "--overwrite", target]) == 0
    assert REC.main(["check", "results/none.csv"]) == 0
    assert REC.main(["backup", target]) == 0
    assert not (tmp_path / target).exists()
    assert [p.name for p in (tmp_path / "data" / "results_backup").rglob("*.csv")] == [
        "ui_latency.csv"
    ]


# ------------------------------------------------------------------ make stream-demo RECORD=1
def _script() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "streaming_latency_guard", REPO / "experiments" / "streaming_latency.py"
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ARGS = ["--season", "2024", "--round", "5", "--speed", "60"]


def test_stream_demo_record_refuses_before_anything_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _script()
    monkeypatch.chdir(tmp_path)
    _write(tmp_path / "results", *mod.RECORD_FILES)
    before = _hashes(tmp_path)
    calls: list[list[str]] = []
    monkeypatch.setattr(mod, "demo_main", lambda argv, **kw: calls.append(list(argv)) or 0)
    assert mod.main([*ARGS, "--record"]) == 2
    assert calls == [], "nothing executed"
    assert _hashes(tmp_path) == before, "nothing written or moved"
    # one existing file is enough to refuse
    for n in mod.RECORD_FILES[1:]:
        (tmp_path / "results" / n).unlink()
    assert mod.main([*ARGS, "--record"]) == 2 and calls == []


def test_stream_demo_overwrite_backs_up_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _script()
    monkeypatch.chdir(tmp_path)
    _write(tmp_path / "results", *mod.RECORD_FILES)
    before = _hashes(tmp_path / "results")
    seen: list[list[str]] = []

    def demo(argv: list[str], **kw: Any) -> int:
        # by the time the run starts, the committed files are safe in the backup folder
        assert not any((tmp_path / "results" / n).exists() for n in mod.RECORD_FILES)
        seen.append(list(argv))
        return 0

    monkeypatch.setattr(mod, "demo_main", demo)
    assert mod.main([*ARGS, "--record", "--overwrite"]) == 0
    assert seen and "--overwrite" not in seen[0] and seen[0][-2:] == ["--results-dir", "results"]
    backups = list((tmp_path / "data" / "results_backup").iterdir())
    assert len(backups) == 1 and _hashes(backups[0]) == before
    with pytest.raises(SystemExit, match="only applies to a recording"):
        mod.guard_record([*ARGS, "--overwrite"])
    # without RECORD nothing is guarded or moved
    assert mod.guard_record(ARGS) == ARGS


# ------------------------------------------------------------------ make experiments-spark RECORD=1
SCAL = H.RECORD_OUTPUTS["scalability"]
PART = H.RECORD_OUTPUTS["partitioning"]


def test_scalability_record_refuses_before_the_grid(fake_host: Path) -> None:  # noqa: F811
    _write(fake_host / "results", SCAL[0])
    before = _hashes(fake_host)
    box = FakeContainer(fake_host)
    lines: list[str] = []
    rid = "bench_20261115T100000Z"
    code = H.main_scalability(
        ["--record", "--run-id", rid, "--repo", str(fake_host), *SMALL],
        runner=box,
        out=lines.append,
        now=NOW,
    )
    assert code == 2 and box.cmds == [], "no cell ran"
    assert not (fake_host / "data" / "bench" / rid).exists(), "no run folder"
    assert _hashes(fake_host) == before
    assert "refusing to record" in lines[0] and "OVERWRITE=1" in lines[0]


def test_scalability_overwrite_backs_up_only_when_the_grid_is_complete(fake_host: Path) -> None:  # noqa: F811
    _write(fake_host / "results", *SCAL)
    committed = _hashes(fake_host / "results")
    rid = "bench_20261115T110000Z"
    lines: list[str] = []
    code = H.main_scalability(
        ["--record", "--overwrite", "--run-id", rid, "--repo", str(fake_host), *SMALL],
        runner=FakeContainer(fake_host, stop_after=2),
        out=lines.append,
        now=NOW,
    )
    assert code == 1 and lines[1].endswith(
        f"make experiments-spark RECORD=1 OVERWRITE=1 RESUME={rid}"
    )
    assert _hashes(fake_host / "results") == committed, "an interrupted run replaces nothing"
    assert not (fake_host / "data" / "results_backup").exists()
    # RESUME without OVERWRITE=1 is refused (the committed files are not this run's)
    assert (
        H.main_scalability(
            ["--record", "--resume", "--run-id", rid, "--repo", str(fake_host)],
            runner=FakeContainer(fake_host),
            out=lines.append,
            now=NOW,
        )
        == 2
    )
    code = H.main_scalability(
        [
            "--record",
            "--overwrite",
            "--resume",
            "--run-id",
            rid,
            "--keep-data",
            "--repo",
            str(fake_host),
        ],
        runner=FakeContainer(fake_host),
        out=lines.append,
        now=NOW,
    )
    assert code == 0
    backups = list((fake_host / "data" / "results_backup").iterdir())
    assert len(backups) == 1 and _hashes(backups[0]) == committed, "the old files, moved intact"
    rows = list(csv.DictReader((fake_host / "results" / SCAL[0]).open()))
    assert len(rows) == 5 and (fake_host / "results" / "scalability_build.png").exists()
    assert f"run_id={rid}," in (fake_host / "results" / "README.md").read_text()
    # a later RESUME of this same, complete run: its own files, allowed without OVERWRITE
    assert (
        H.main_scalability(
            ["--record", "--resume", "--run-id", rid, "--keep-data", "--repo", str(fake_host)],
            runner=FakeContainer(fake_host),
            out=lines.append,
            now=NOW,
        )
        == 0
    )
    assert len(list((fake_host / "data" / "results_backup").iterdir())) == 1, "no second backup"


def test_a_later_supplement_makes_the_original_run_not_resumable_as_owner(tmp_path: Path) -> None:
    res = tmp_path / "results"
    _write(res, *SCAL)
    readme = res / "README.md"
    readme.write_text(
        "# Results\n\n## `scalability.csv` (a)\n\n| run_id=bench_A, x |\n"
        "\n## `partitioning.csv` (b)\n\n| run_id=bench_A_part, y |\n"
    )
    assert H.fingerprinted_file(readme, "scalability.csv", "bench_A")
    assert H.record_check("scalability", "bench_A", tmp_path, overwrite=False)[0] == []
    with readme.open("a") as fh:
        fh.write("\n## `scalability.csv` (c)\n\n| run_id=bench_A_supp, z |\n")
    assert not H.fingerprinted_file(readme, "scalability.csv", "bench_A")
    with pytest.raises(H.RunError, match="refusing to record"):
        H.record_check("scalability", "bench_A", tmp_path, overwrite=False)
    assert H.fingerprinted_file(readme, "partitioning.csv", "bench_A_part")


def test_partitioning_record_refuses_and_overwrites(fake_host: Path) -> None:  # noqa: F811
    _write(fake_host / "results", *PART)
    committed = _hashes(fake_host / "results")
    rid = "bench_20261115T120000Z"
    box = _partitioning_container(RAW, complete=True)
    lines: list[str] = []
    assert (
        H.main_partitioning(
            ["--record", "--run-id", rid, "--repo", str(fake_host)],
            runner=box,
            out=lines.append,
            now=NOW,
        )
        == 2
    )
    assert not hasattr(box, "cmd"), "partitioning never ran"
    assert not (fake_host / "data" / "bench" / f"{rid}_part").exists()
    assert _hashes(fake_host / "results") == committed
    code = H.main_partitioning(
        ["--record", "--overwrite", "--run-id", rid, "--keep-data", "--repo", str(fake_host)],
        runner=_partitioning_container(RAW, complete=True),
        out=lines.append,
        now=NOW,
    )
    assert code == 0
    backups = list((fake_host / "data" / "results_backup").iterdir())
    assert len(backups) == 1 and _hashes(backups[0]) == committed
    assert (
        fake_host / "results" / "partitioning.csv"
    ).read_text() != "committed partitioning.csv\n"


def test_check_record_covers_both_scripts_before_the_grid(tmp_path: Path) -> None:
    lines: list[str] = []
    assert (
        H.main_check_record(["--run-id", "bench_X", "--repo", str(tmp_path)], out=lines.append) == 0
    )
    _write(tmp_path / "results", SCAL[0], PART[0])
    assert (
        H.main_check_record(["--run-id", "bench_X", "--repo", str(tmp_path)], out=lines.append) == 2
    )
    refused = [ln for ln in lines if ln.startswith("refused:")]
    assert len(refused) == 2 and "scalability" in refused[0] and "partitioning" in refused[1]
    assert (
        H.main_check_record(
            ["--run-id", "bench_X", "--overwrite", "--repo", str(tmp_path)], out=lines.append
        )
        == 0
    )
    assert "2 results file(s) will be moved" in lines[-1]
    assert (tmp_path / "results" / SCAL[0]).exists(), "the check never moves anything"


def test_overwrite_needs_record_and_is_not_for_the_supplement(fake_host: Path) -> None:  # noqa: F811
    with pytest.raises(SystemExit):
        H.main_scalability(
            ["--overwrite", "--repo", str(fake_host), *SMALL], runner=FakeContainer(fake_host)
        )
    with pytest.raises(SystemExit):
        H.main_scalability(
            [
                "--record",
                "--overwrite",
                "--supplement-of",
                "bench_A",
                "--only-cells",
                "x",
                "--repo",
                str(fake_host),
            ],
            runner=FakeContainer(fake_host),
        )
    with pytest.raises(SystemExit):
        H.main_partitioning(
            ["--overwrite", "--repo", str(fake_host)],
            runner=_partitioning_container(RAW, complete=True),
        )


# ------------------------------------------------------------------ make bench-replot RECORD=1
def test_replot_into_results_refuses_unless_overwrite(tmp_path: Path) -> None:
    res = tmp_path / "results"
    res.mkdir()
    R.write_csv(res / "scalability.csv", ROWS, R.SUPPLEMENT_COLUMNS)
    (res / "scalability_build.png").write_text("committed plot")
    args = [
        "--replot",
        str(res / "scalability.csv"),
        "--out",
        str(res / "scalability_build.png"),
        "--repo",
        str(tmp_path),
    ]
    before = _hashes(res)
    assert R.main(args) == 2 and _hashes(res) == before
    assert R.main([*args, "--overwrite"]) == 0
    assert (res / "scalability_build.png").read_bytes()[:4] == b"\x89PNG"
    backups = list((tmp_path / "data" / "results_backup").iterdir())
    assert [p.read_text() for p in backups[0].iterdir()] == ["committed plot"]
    # outside results/ (data/bench/replot) nothing is guarded
    out = tmp_path / "data" / "bench" / "replot" / "scalability_build.png"
    out.parent.mkdir(parents=True)
    out.write_text("old")
    assert (
        R.main(
            ["--replot", str(res / "scalability.csv"), "--out", str(out), "--repo", str(tmp_path)]
        )
        == 0
    )


# ------------------------------------------------------------- streaming suite and Redis latency
def test_suite_record_overwrite_backs_up_first(tmp_path: Path) -> None:
    suite = tmp_path / "suite"
    r = _run(suite, S.SUITE[1])
    S.summarise(suite, [r], tmp_path / "none.jsonl")
    results = tmp_path / "results"
    targets = S.record_targets([S.SUITE[1]], ui=False)
    _write(results, *targets)
    committed = _hashes(results)
    with pytest.raises(S.SuiteError, match="never overwritten"):
        S.record(suite, [r], False, [("measured_at_utc", "T")], results)
    assert _hashes(results) == committed
    root = tmp_path / "data" / "results_backup"
    written = S.record(
        suite, [r], False, [("measured_at_utc", "T")], results, overwrite=True, backup_root=root
    )
    assert sorted(written) == sorted(targets)
    backup = next(root.iterdir())
    assert _hashes(backup) == {k: v for k, v in committed.items() if k in targets}


def test_redis_latency_record_refuses_unless_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    assert LB.output_target(None, True) == (Path("results"), LB.RECORD_CSV_NAME)
    _write(tmp_path / "results", LB.RECORD_CSV_NAME)
    with pytest.raises(LB.BenchError, match="never overwritten"):
        LB.output_target(None, True)
    assert LB.output_target(None, True, overwrite=True) == (Path("results"), LB.RECORD_CSV_NAME)
    assert LB.main(["--overwrite"]) == 2, "--overwrite needs --record"
    assert (
        tmp_path / "results" / LB.RECORD_CSV_NAME
    ).read_text() == f"committed {LB.RECORD_CSV_NAME}\n"


# ------------------------------------------------------------------ api DEBUG=1 UI latency samples
def test_ui_latency_recorder_never_appends_to_an_existing_results_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    committed = tmp_path / "results" / "ui_latency.csv"
    _write(committed.parent, committed.name)
    assert in_results(Path("results/ui_latency.csv")) and not in_results(Path("data/demo/x.csv"))
    with pytest.raises(REC.RecordRefused, match=r"ui_latency\.csv"):
        LatencyRecorder(Path("results/ui_latency.csv"), enabled=True)
    LatencyRecorder(Path("results/ui_latency.csv"), enabled=False)  # debug off: never writes
    LatencyRecorder(Path("results/new.csv"), enabled=True)  # a new results file is allowed
    LatencyRecorder(Path("data/demo/ui_latency/ui_latency.csv"), enabled=True)
    assert committed.read_text() == "committed ui_latency.csv\n"
