"""The controlled live replay of Feature 4 on the real `make up` infrastructure: the stored sample
2024 R5 bundle equals what the real stream job (Kafka -> Structured Streaming -> Redis) leaves in
Redis at the end of laps 5, 22 and 45, after ``session_end``, and in every published message.

The stream job runs on the host (Kafka connector from ``data/cache/ivy``) against a tmp copy of
the sample lake. Refused while an api replay runs. It writes the race's Redis keys (as any
replay) and ``data/checkpoints`` / ``data/demo`` inside the tmp working directory.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path
from typing import Any

import pytest
from pyspark.sql import SparkSession

from f1sa.archive import build as B
from f1sa.archive import equivalence as EQ
from f1sa.config import Settings, get_settings
from f1sa.streaming.demo import DemoError, check_services

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = REPO_ROOT / "models" / "undercut" / "deploy_real_G3.5_k2"


def test_stored_bundle_equals_a_live_replay(
    spark: SparkSession,
    sample_archive_lake: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not (MODEL_DIR / "lr" / "scorer.json").is_file():
        pytest.skip("deployment model not saved (make model-save-full); it is gitignored")
    shutil.copytree(sample_archive_lake.lake, tmp_path / "data" / "lake")
    lake_uri = f"file://{tmp_path}/data/lake"
    monkeypatch.setenv("DATA_LAKE_URI", lake_uri)
    get_settings.cache_clear()
    settings: Settings = get_settings()
    try:
        check_services(settings)
    except DemoError as exc:
        pytest.skip(f"needs make up: {exc}")
    os.chdir(tmp_path)
    B.write_bundle(
        settings,
        B.build_bundle(spark, settings, 2024, 5, model_dir=MODEL_DIR, source="sample"),
    )
    args = argparse.Namespace(
        season=2024,
        round=5,
        laps=(5, 22, 45),
        model_dir=MODEL_DIR,
        api=os.environ.get("API_GUARD_URL", "http://127.0.0.1:8000"),
        skip_live=False,
        allow_test_season=False,
        timeout_s=900.0,
        master="local[2]",
    )
    lines: list[str] = []
    report = EQ.run(
        args,
        settings,
        spark_factory=lambda _m: spark,
        out=lines.append,
        ivy_dir=REPO_ROOT / "data" / "cache" / "ivy",
    )
    assert report["ok"], (report["problems"], lines)
    assert [c["lap"] for c in report["live_checks"]] == [5, 22, 45, 56]
    assert all(c["ok"] for c in report["live_checks"])
    assert report["live_messages"]["undercut_alert"] == 141
