"""``archive.build`` on the real sample lake (2023 R5, 2024 R5): both bundles are built, valid and
byte-identical on a rebuild; only ``archive/race_bundle`` is written (never raw, clean, features or
results); refusals and missing prerequisites; the reported sizes."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from _stream_fixtures import scenario_doc_dir
from pyspark.sql import SparkSession

from f1sa.archive import build as B
from f1sa.archive.schema import ArchiveBundle, decode_bundle, parse_manifest
from f1sa.config import Settings, get_settings

RACES = [(2023, 5), (2024, 5)]


@contextmanager
def _cwd(path: Path) -> Iterator[None]:
    old = os.getcwd()
    os.chdir(path)  # the file-lake guard resolves ./data/lake against the working directory
    try:
        yield
    finally:
        os.chdir(old)


def _tree(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


@dataclass
class Built:
    base: Path
    settings: Settings
    model_dir: Path
    before: dict[str, str]
    lines: list[str]
    races: list[B.BuiltRace]

    def part(self, s: int, r: int) -> Path:
        return (
            self.base / "data" / "lake" / "archive" / "race_bundle" / f"season={s}" / f"round={r}"
        )

    def bundle(self, s: int, r: int) -> ArchiveBundle:
        return decode_bundle((self.part(s, r) / "bundle.json.gz").read_bytes())


@pytest.fixture(scope="module")
def built(
    spark: SparkSession, sample_archive_lake: Any, tmp_path_factory: pytest.TempPathFactory
) -> Built:
    base = tmp_path_factory.mktemp("archive_build")
    shutil.copytree(sample_archive_lake.lake, base / "data" / "lake")
    settings = Settings(_env_file=None, data_lake_uri=f"file://{base}/data/lake")  # type: ignore[call-arg]
    model_dir = scenario_doc_dir(base / "model")
    before = _tree(base / "data" / "lake")
    lines: list[str] = []
    with _cwd(base):
        races, failed = B.run_build(
            spark, settings, source="sample", model_dir=model_dir, out=lines.append
        )
    assert failed == []
    return Built(base, settings, model_dir, before, lines, races)


def test_both_sample_races_are_built_and_valid(built: Built) -> None:
    assert [(b.season, b.round) for b in built.races] == RACES
    for s, r in RACES:
        bundle = built.bundle(s, r)
        assert (bundle.meta.season, bundle.meta.round, bundle.meta.source) == (s, r, "sample")
        assert bundle.meta.synthetic is True and bundle.meta.n_partitions == 3
        assert bundle.meta.model.version == "model" and len(bundle.meta.model.scorer_sha256) == 64
        assert len(bundle.entrants) == 20 and bundle.race_control == []  # no TI in the sample
        assert [x.lap for x in bundle.snapshots] == list(range(1, bundle.meta.laps + 1))
        assert [t.lap for t in bundle.track] == list(range(1, bundle.meta.laps + 1))
        assert {t.neutralised_source for t in bundle.track} == {"heuristic"}
        assert all(len(x.drivers) <= 20 for x in bundle.snapshots)
        assert bundle.meta.race_start_utc and bundle.meta.race_start_utc.endswith("Z")
    r5 = built.bundle(2024, 5)
    neutral = [t.lap for t in r5.track if t.is_neutralised_lap]
    assert neutral == list(range(21, 32))  # the sample's heuristic SC/VSC laps (2024 R5)
    assert r5.meta.laps == 56


def test_only_the_archive_partitions_are_written(built: Built) -> None:
    after = _tree(built.base / "data" / "lake")
    new = {k for k in after if k not in built.before}
    assert {k for k in built.before if built.before[k] != after.get(k)} == set()
    assert new == {
        f"archive/race_bundle/season={s}/round={r}/{n}"
        for s, r in RACES
        for n in ("bundle.json.gz", "_manifest.json")
    }


def test_manifest_matches_the_bytes_and_the_sizes_are_reported(built: Built) -> None:
    for b in built.races:
        part = built.part(b.season, b.round)
        gz = (part / "bundle.json.gz").read_bytes()
        doc = json.loads((part / "_manifest.json").read_text())
        m = parse_manifest(json.dumps(doc).encode())
        assert m.sha256 == b.sha256 == hashlib.sha256(gz).hexdigest() and m.size_bytes == len(gz)
        assert doc["files"] == [
            {"name": "bundle.json.gz", "bytes": len(gz), "sha256": m.sha256, "rows": None}
        ]
        assert b.uri.startswith(built.settings.data_lake_uri + "/archive/race_bundle/")
        assert 10_000 < b.size_bytes < b.raw_bytes < 8_000_000
    assert any("B JSON ->" in line and "B gzip" in line for line in built.lines)
    assert built.lines[-1].startswith("2 bundles, model model")


def test_a_rebuild_is_byte_identical(spark: SparkSession, built: Built) -> None:
    first = _tree(built.part(2024, 5))
    with _cwd(built.base):
        B.run_build(
            spark,
            built.settings,
            source="sample",
            model_dir=built.model_dir,
            season=2024,
            round_=5,
            out=lambda _m: None,
        )
    again = _tree(built.part(2024, 5))
    assert again["bundle.json.gz"] == first["bundle.json.gz"]


def test_cli_refusals(spark: SparkSession, built: Built, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_LAKE_URI", built.settings.data_lake_uri)
    monkeypatch.chdir(built.base)

    def run(*a: str) -> int:
        return B.main([*a, "--model-dir", str(built.model_dir)], spark_factory=lambda _m: spark)

    assert run("--source", "sample", "--season", "2025") == 2
    assert run("--source", "sample", "--round", "5") == 2
    assert run("--source", "sample", "--season", "2022") == 2  # nothing selected
    assert B.main(["--source", "sample", "--model-dir", str(built.base / "nope")]) == 2
    assert run("--source", "sample", "--season", "2024", "--round", "5") == 0
    monkeypatch.setenv("DATA_LAKE_URI", "hdfs://namenode:8020/f1")
    get_settings.cache_clear()
    assert run("--source", "sample") == 2


def test_missing_prerequisites_fail_with_the_make_target(
    spark: SparkSession, built: Built, tmp_path: Path
) -> None:
    base = tmp_path / "lake_copy"
    shutil.copytree(built.base / "data" / "lake", base / "data" / "lake")
    shutil.rmtree(base / "data" / "lake" / "clean" / "entrants")
    settings = Settings(_env_file=None, data_lake_uri=f"file://{base}/data/lake")  # type: ignore[call-arg]
    lines: list[str] = []
    with _cwd(base):
        races, failed = B.run_build(
            spark, settings, source="sample", model_dir=built.model_dir, out=lines.append
        )
    assert races == [] and len(failed) == 2
    assert all("make entrants-sample analysis-sample" in f for f in failed)


def test_write_guards() -> None:
    s = Settings(_env_file=None, data_lake_uri="file://./data/lake")  # type: ignore[call-arg]
    ok = "file://./data/lake/archive/race_bundle/season=2024/round=5"
    assert B.check_archive_uri(ok, s) == ok
    for bad in (
        "file://./data/lake/raw/jolpica/laps/season=2024/round=5",
        "file://./data/lake/archive/race_bundle/../../raw/x",
        "file://./data/lake/clean/laps/season=2024/round=5",
    ):
        with pytest.raises(B.RefusedError):
            B.check_archive_uri(bad, s)
    outside = Settings(_env_file=None, data_lake_uri="file:///tmp/elsewhere")  # type: ignore[call-arg]
    with pytest.raises(B.RefusedError, match="data/lake"):
        B.check_archive_uri(
            "file:///tmp/elsewhere/archive/race_bundle/season=2024/round=5", outside
        )
    with pytest.raises(B.RefusedError, match="sealed"):
        B.check_test_season(2025, False)
    B.check_test_season(2025, True)


def test_start_time_and_iso_helpers() -> None:
    from datetime import UTC, date, datetime

    assert B.start_ms_of(datetime(2024, 5, 5, 20, 0, tzinfo=UTC), None) == 1_714_939_200_000
    assert B.start_ms_of(datetime(2024, 5, 5, 20, 0), None) == 1_714_939_200_000  # naive = UTC
    assert B.start_ms_of(None, date(2024, 5, 5)) == 1_714_867_200_000
    assert B.start_ms_of(None, None) == 0
    assert B._iso(datetime(2024, 5, 5, 20, 0, tzinfo=UTC)) == "2024-05-05T20:00:00Z"
    assert B._iso(date(2024, 5, 5)) == "2024-05-05" and B._iso(None) is None
