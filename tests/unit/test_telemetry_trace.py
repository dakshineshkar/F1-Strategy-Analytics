"""The telemetry-trace job (``etl.telemetry_trace``, Feature 6) on a hand-made file lake.

Invented samples only (no F1 data): 2024 R5 with drivers AAA (3 laps; lap 3 has a 3 s feed gap),
BBB (2 laps; lap 2 has a single sample), DDD (a lap-1 retirement: no analysis_laps row, mapped by
the clean ``drivers`` code) and CCC (in neither: unmapped). A 2023 raw partition exists and must
never be read. The raw tree must be byte-identical afterwards.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyspark.sql import SparkSession

from f1sa.config import Settings
from f1sa.etl import clean
from f1sa.etl import telemetry_trace as J
from f1sa.etl.clean import CleanError
from f1sa.etl.io import write_partitioned
from f1sa.lake import schemas as S
from f1sa.lake import schemas_analysis as AS
from f1sa.lake import schemas_telemetry_trace as TT


def _samples(
    code: str, lap: int, lap_time: float, *, length: float = 1000.0, gap_at: float | None = None
) -> pd.DataFrame:
    t = np.round(np.arange(0.0, lap_time + 1e-9, 0.25), 3)
    if t[-1] < lap_time:
        t = np.append(t, lap_time)
    if gap_at is not None:
        t = t[(t < gap_at) | (t >= gap_at + 3.0)]
    d = t / lap_time * length
    n = len(t)
    return pd.DataFrame(
        {
            "driver_code": [code] * n,
            "lap": np.full(n, lap, dtype=np.int64),
            "time_in_lap_s": t,
            "speed_kph": np.full(n, length / lap_time * 3.6),
            "rpm": np.full(n, 11000.0),
            "n_gear": np.full(n, 7, dtype=np.int64),
            "throttle_pct": np.where(d < length / 2, 100.0, 20.0),
            "brake": (d >= 600) & (d < 700),
            "drs": np.zeros(n, dtype=np.int64),
            "distance_m": d,
            "x": np.zeros(n),  # an extra raw column the job never reads
        }
    )


def _raw(lake: Path, season: int, code: str, frame: pd.DataFrame) -> None:
    part = (
        lake
        / "raw"
        / "tracinginsights"
        / "telemetry"
        / f"season={season}"
        / "round=5"
        / f"driver={code}"
    )
    part.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), part / "telemetry.parquet")
    (part / "_manifest.json").write_text("{}")


def _lap_row(driver_id: str, code: str, lap: int, time: float, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {f: None for f in AS.ANALYSIS_LAPS.fieldNames()}
    row.update(
        season=2024, round=5, driver_id=driver_id, driver_code=code, lap=lap, lap_time_s=time,
        is_pit_in_lap=False, is_pit_out_lap=False, is_deleted=False, is_neutralised_lap=False,
        is_red_flag_lap=False, compound="SOFT", tyre_life_laps=lap,
    )  # fmt: skip
    row.update(over)
    return row


def _drivers(extra: tuple[str, str] | None = None) -> list[dict[str, Any]]:
    pairs = [("alpha", "AAA"), ("bravo", "BBB"), ("delta", "DDD"), *([extra] if extra else [])]
    rows = []
    for n, (driver_id, code) in enumerate(pairs, start=1):
        row: dict[str, Any] = {f: None for f in S.DRIVERS.fieldNames()}
        row.update(season=2024, round=5, driver_id=driver_id, code=code, car_number=n)
        rows.append(row)
    return rows


def _tree_hash(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def _write_lake(spark: SparkSession, base: Path) -> Settings:
    lake = base / "data" / "lake"
    _raw(lake, 2024, "AAA", pd.concat([
        _samples("AAA", 1, 100.0, length=950.0),
        _samples("AAA", 2, 90.0),
        _samples("AAA", 3, 91.0, gap_at=40.0),
    ]))  # fmt: skip
    _raw(
        lake, 2024, "BBB", pd.concat([_samples("BBB", 1, 101.0), _samples("BBB", 2, 92.0).iloc[:1]])
    )
    _raw(lake, 2024, "CCC", _samples("CCC", 1, 100.0))
    _raw(lake, 2024, "DDD", _samples("DDD", 1, 60.0, length=400.0))
    _raw(lake, 2023, "AAA", _samples("AAA", 1, 80.0))  # another season: never read
    rows = [
        _lap_row("alpha", "AAA", 1, 100.5),
        _lap_row("alpha", "AAA", 2, 90.0, is_pit_in_lap=True),
        _lap_row("alpha", "AAA", 3, 91.0),
        _lap_row("bravo", "BBB", 1, 101.0),
        _lap_row("bravo", "BBB", 2, 92.0, is_deleted=True),
    ]
    laps = spark.createDataFrame(rows, AS.ANALYSIS_LAPS)
    write_partitioned(laps, f"file://{lake}/clean", AS.LAPS, AS.PRIMARY_KEYS[AS.LAPS])
    clean.write_table(
        spark.createDataFrame(_drivers(), S.DRIVERS), f"file://{lake}/clean", "drivers"
    )
    return Settings(_env_file=None, data_lake_uri=f"file://{lake}")  # type: ignore[call-arg]


class Built:
    def __init__(
        self, base: Path, result: J.TraceResult, rows: list[Any], raw_before: dict[str, str]
    ):
        self.base = base
        self.lake = base / "data" / "lake"
        self.result = result
        self.rows = {(r["driver_code"], r["lap"]): r for r in rows}
        self.raw_before = raw_before


def _run(
    spark: SparkSession, base: Path, settings: Settings, source: str = "lake"
) -> J.TraceResult:
    cwd = os.getcwd()
    os.chdir(base)  # the output guard resolves ./data/lake against the working directory
    try:
        return J.run_traces(spark, settings, source=source)
    finally:
        os.chdir(cwd)


@pytest.fixture(scope="module")
def built(spark: SparkSession, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Built]:
    base = tmp_path_factory.mktemp("telemetry_trace")
    settings = _write_lake(spark, base)
    raw_before = _tree_hash(base / "data" / "lake" / "raw")
    result = _run(spark, base, settings)
    rows = J.read_traces(spark, f"file://{base}/data/lake/clean/{TT.TABLE}").collect()
    yield Built(base, result, rows, raw_before)


# ------------------------------------------------------------------ output
def test_one_row_per_mapped_lap_with_the_exact_schema(built: Built) -> None:
    assert sorted(built.rows) == [("AAA", 1), ("AAA", 2), ("AAA", 3), ("BBB", 1), ("DDD", 1)]
    row = built.rows[("AAA", 2)]
    assert list(row.asDict()) == TT.TELEMETRY_TRACE.fieldNames()
    assert (row["season"], row["round"], row["driver_id"]) == (2024, 5, "alpha")
    assert row["is_synthetic"] is False and row["source"] == "tracinginsights"
    assert row["grid_step_m"] == TT.GRID_STEP_M


def test_partitioned_by_season_round_and_driver(built: Built) -> None:
    table = built.lake / "clean" / TT.TABLE
    parts = sorted(str(p.relative_to(table)) for p in table.glob("season=*/round=*/driver_code=*"))
    assert parts == [f"season=2024/round=5/driver_code={c}" for c in ("AAA", "BBB", "DDD")]
    assert (table / TT.QUALITY_FILE).is_file()
    assert sorted(p.name for p in (built.lake / "clean").iterdir()) == [
        AS.LAPS,
        "drivers",
        TT.TABLE,
    ]


def test_the_raw_zone_is_untouched_and_2023_never_read(built: Built) -> None:
    assert _tree_hash(built.lake / "raw") == built.raw_before
    assert {r["season"] for r in built.rows.values()} == {2024}


def test_trace_values_on_the_grid(built: Built) -> None:
    row = built.rows[("AAA", 2)]
    n = len(row["distance_m"])
    assert (
        n == 201 and row["distance_m"][:3] == [0.0, 5.0, 10.0] and row["distance_m"][-1] == 1000.0
    )
    assert all(
        len(row[c]) == n
        for c in ("elapsed_s", "speed_kph", "throttle_pct", "rpm", "brake", "n_gear", "drs")
    )
    assert row["elapsed_s"][100] == pytest.approx(45.0, abs=1e-3)  # 500 m at a constant speed
    assert row["trace_time_s"] == 90.0 and row["lap_length_m"] == 1000.0
    assert row["full_throttle_share"] == pytest.approx(0.5, abs=0.01)
    assert row["brake_share"] == pytest.approx(0.1, abs=0.01)
    assert row["n_braking_zones"] == 1 and row["braking_start_m"] == [pytest.approx(600.0, abs=5)]


def test_lap_info_and_coverage(built: Built) -> None:
    assert built.rows[("AAA", 2)]["is_pit_in_lap"] is True
    assert (
        built.rows[("AAA", 1)]["lap_time_s"] == 100.5
        and built.rows[("AAA", 1)]["compound"] == "SOFT"
    )
    assert built.rows[("AAA", 1)]["coverage"] == "full"
    assert built.rows[("AAA", 3)]["coverage"] == "partial"  # a 3 s gap > MAX_GAP_S
    assert built.rows[("AAA", 3)]["max_gap_s"] == pytest.approx(3.0, abs=0.26)


def test_a_lap_1_retirement_is_mapped_by_the_race_drivers(built: Built) -> None:
    row = built.rows[("DDD", 1)]
    assert (
        row["driver_id"] == "delta" and row["lap_time_s"] is None and row["is_pit_in_lap"] is None
    )
    assert row["coverage"] == "full" and row["lap_length_m"] == 400.0


def test_a_code_with_two_driver_ids_fails(spark: SparkSession, tmp_path: Path) -> None:
    settings = _write_lake(spark, tmp_path)
    lake = tmp_path / "data" / "lake"
    clean.write_table(
        spark.createDataFrame(_drivers(("other_a", "AAA")), S.DRIVERS),
        f"file://{lake}/clean",
        "drivers",
    )
    with pytest.raises(CleanError, match="more than one driver_id"):
        _run(spark, tmp_path, settings)


def test_quality_report(built: Built) -> None:
    rep = built.result.report
    stored = json.loads((built.lake / "clean" / TT.TABLE / TT.QUALITY_FILE).read_text())
    assert stored == json.loads(json.dumps(rep))
    assert rep["lap_groups_in"] == 7 and rep["rows"] == 5 and built.result.rows == 5
    assert rep["laps_without_trace"] == 1  # BBB lap 2: one sample
    assert rep["rows_unmapped_driver"] == 1 and rep["unmapped_drivers"] == ["R5:CCC"]
    assert rep["rows_without_lap_info"] == 1  # DDD lap 1
    assert rep["coverage"] == {"full": 4, "partial": 1}
    assert rep["drivers_per_round"] == {"5": 3} and rep["rows_per_round"] == {"5": 5}
    assert rep["season"] == 2024 and rep["is_synthetic"] is False and rep["table_bytes"] > 0


def test_rerun_is_idempotent(spark: SparkSession, built: Built) -> None:
    settings = Settings(_env_file=None, data_lake_uri=f"file://{built.lake}")  # type: ignore[call-arg]
    again = _run(spark, built.base, settings)
    assert again.report["checksum"] == built.result.report["checksum"]
    assert again.rows == built.result.rows


def test_sample_source_reads_only_the_fixture_and_is_synthetic(
    spark: SparkSession, tmp_path: Path
) -> None:
    settings = _write_lake(spark, tmp_path)
    lake = tmp_path / "data" / "lake"
    fixture = lake / J.FIXTURE_DIR
    fixture.parent.mkdir(parents=True)
    (lake / "raw").rename(fixture)  # only the fixture exists; there is no raw zone at all
    result = _run(spark, tmp_path, settings, "sample")
    rows = J.read_traces(spark, f"file://{lake}/clean/{TT.TABLE}").collect()
    assert result.report["is_synthetic"] is True and result.rows == 5
    assert {(r["is_synthetic"], r["source"]) for r in rows} == {(True, "synthetic")}


# ------------------------------------------------------------------ guards
def test_output_path_is_only_the_clean_table() -> None:
    assert J.output_path("file:///x/data/lake") == "file:///x/data/lake/clean/telemetry_trace"
    assert (
        J.output_path("hdfs://namenode:8020/f1") == "hdfs://namenode:8020/f1/clean/telemetry_trace"
    )
    for bad in ("hdfs://namenode:8020/f1/raw", "file:///x/raw/lake", "/no/scheme", "file://"):
        with pytest.raises(CleanError):
            J.output_path(bad)


def test_only_2024_and_valid_rounds_are_accepted() -> None:
    assert J.parse_season("2024") == 2024
    for bad in ("2023", "2025", "2021-2024", "x"):
        with pytest.raises(argparse.ArgumentTypeError, match="2024 only"):
            J.parse_season(bad)
    assert J.parse_rounds("5") == [5] and J.parse_rounds("3-5,1") == [1, 3, 4, 5]
    for bad in ("0", "31", "5-3", "a", ""):
        with pytest.raises(argparse.ArgumentTypeError):
            J.parse_rounds(bad)


def test_sample_source_needs_a_file_lake(spark: SparkSession) -> None:
    settings = Settings(_env_file=None, data_lake_uri="hdfs://namenode:8020/f1")  # type: ignore[call-arg]
    with pytest.raises(CleanError, match="file:// lake"):
        J.run_traces(spark, settings, source="sample")


def test_missing_inputs_fail_with_the_make_target(spark: SparkSession, tmp_path: Path) -> None:
    lake = tmp_path / "data" / "lake"
    lake.mkdir(parents=True)
    settings = Settings(_env_file=None, data_lake_uri=f"file://{lake}")  # type: ignore[call-arg]
    with pytest.raises(CleanError, match="make ingest-ti-full"):
        _run(spark, tmp_path, settings)
    _raw(lake, 2024, "AAA", _samples("AAA", 1, 100.0))
    with pytest.raises(CleanError, match="analysis job"):
        _run(spark, tmp_path, settings)


def test_writing_outside_data_lake_is_refused(spark: SparkSession, tmp_path: Path) -> None:
    settings = Settings(_env_file=None, data_lake_uri=f"file://{tmp_path}/elsewhere")  # type: ignore[call-arg]
    with pytest.raises(CleanError, match=r"outside \./data/lake"):
        J.run_traces(spark, settings, source="lake")


def test_main_exit_codes(
    spark: SparkSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "data" / "lake").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{tmp_path}/data/lake")
    monkeypatch.setattr(J, "build_spark", lambda *_a, **_k: spark)
    monkeypatch.setattr(spark, "stop", lambda: None)
    assert J.main(["--source", "lake"]) == 1  # no raw telemetry
    for argv in (["--source", "nope"], ["--source", "lake", "--seasons", "2023"]):
        with pytest.raises(SystemExit):
            J.main(argv)


# ------------------------------------------------------------------ isolation
def test_schema_module_is_outside_every_other_table_list() -> None:
    from f1sa.lake import schemas as S
    from f1sa.lake import schemas_tracinginsights as TS

    for tables in (S.CLEAN_SCHEMAS, TS.CLEAN_SCHEMAS_TI, AS.SCHEMAS):
        assert TT.TABLE not in tables
    assert set(TT.PRIMARY_KEY) <= set(TT.TELEMETRY_TRACE.fieldNames())
    assert set(TT.PARTITION_COLUMNS) <= set(TT.PRIMARY_KEY)
    assert set(TT.LAP_INFO_COLUMNS) <= set(AS.ANALYSIS_LAPS.fieldNames())


def test_no_model_stream_sim_or_archive_code_uses_the_traces() -> None:
    src = Path(__file__).resolve().parents[2] / "src" / "f1sa"
    names = (
        "telemetry_trace",
        "telemetry_resample",
        "synthetic_telemetry",
        "api.telemetry",
        "api import telemetry",
    )
    for pkg in (
        "streaming",
        "serving",
        "features",
        "model",
        "sim",
        "archive",
        "etl/clean.py",
        "etl/analysis.py",
    ):
        path = src / pkg
        files = [path] if path.is_file() else sorted(path.rglob("*.py"))
        for f in files:
            if f == src / "serving" / "keys.py":  # names the API cache key only
                continue
            text = f.read_text()
            assert not any(n in text for n in names), f
