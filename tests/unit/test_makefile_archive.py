"""The Feature 4 make targets (dry runs; nothing is executed): where each one runs, what lake it
uses, and that none writes raw, results/ or touches a service."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _make(*args: str) -> str:
    if shutil.which("make") is None:
        pytest.skip("make not installed")
    return subprocess.run(
        ["make", "-n", "-C", str(REPO), *args], capture_output=True, text=True, check=True
    ).stdout


def _line(out: str, needle: str) -> str:
    (line,) = [x for x in out.splitlines() if needle in x]
    return line


def test_archive_sample_runs_on_the_host_against_the_local_lake() -> None:
    out = _make("archive-sample")
    assert "make etl-sample features-sample entrants-sample analysis-sample" in out
    line = _line(out, "f1sa.archive.build")
    assert line.startswith(f"DATA_LAKE_URI=file://{REPO}/data/lake ")
    assert line.endswith("run python -m f1sa.archive.build --source sample")
    with_model = _line(_make("archive-sample", "MODEL_DIR=models/undercut/x"), "archive.build")
    assert with_model.endswith("--source sample --model-dir models/undercut/x")


def test_archive_full_runs_in_the_app_container_on_hdfs_through_httpfs() -> None:
    line = _line(_make("archive-full"), "f1sa.archive.build")
    assert line.startswith("docker compose exec -T -e PYTHONPATH=/workspace/src")
    assert "-e DATA_LAKE_URI=hdfs://namenode:8020/f1" in line
    assert "-e HDFS_HTTPFS_URL=http://httpfs:14000" in line and " app python " in line
    assert line.endswith("--source lake")
    sel = _line(
        _make("archive-full", "ARCHIVE_SEASON=2024", "ARCHIVE_ROUND=1"), "f1sa.archive.build"
    )
    assert sel.endswith("--source lake --season 2024 --round 1")


def test_archive_equivalence_needs_laps_and_picks_the_lake() -> None:
    sample = _line(
        _make("archive-equivalence", "SEASON=2024", "ROUND=5", "LAPS=5,22,45"),
        "f1sa.archive.equivalence",
    )
    assert "-e DATA_LAKE_URI=file:///workspace/data/lake" in sample
    assert sample.endswith("--season 2024 --round 5 --laps 5,22,45 --api http://api:8000")
    full = _line(
        _make("archive-equivalence", "FULL=1", "SEASON=2024", "ROUND=1", "LAPS=10,30,50"),
        "f1sa.archive.equivalence",
    )
    assert "-e DATA_LAKE_URI=hdfs://namenode:8020/f1" in full
    assert "LAPS is required" in _make("archive-equivalence")


def test_no_archive_target_writes_raw_or_results_or_touches_services() -> None:
    for target in ("archive-sample", "archive-full", "archive-equivalence LAPS=1,2,3"):
        out = _make(*target.split())
        assert "/f1/raw" not in out and "results/" not in out
        for verb in (" up ", " up -d", " down", " stop ", " restart", "--build", "rm "):
            assert verb not in out, (target, verb)


def test_demo_pipeline_builds_the_archive_after_the_sample_model() -> None:
    out = _make("demo-pipeline")
    lines = out.splitlines()
    model = next(i for i, x in enumerate(lines) if "model_save.py --source sample" in x)
    archive = next(i for i, x in enumerate(lines) if "f1sa.archive.build" in x)
    assert model < archive
    assert lines[archive].endswith(
        "--source sample --model-dir models/undercut/sample_deploy_real_G3.5_k2"
    )
