"""The SYNTHETIC telemetry fixture (``ingest.synthetic_telemetry``, Feature 6; tests only)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from f1sa.config import get_settings
from f1sa.etl.telemetry_resample import resample_lap
from f1sa.ingest import synthetic_telemetry as G
from f1sa.lake import schemas_telemetry_trace as TT

LAPS = pd.DataFrame(
    {
        "driver_code": ["AAA", "AAA", "AAA", "BBB", "BBB"],
        "lap": [1, 2, 3, 1, 2],
        "lap_time_s": [101.5, 96.25, 97.0, 102.0, None],
    }
)


def test_a_lap_takes_exactly_its_lap_time_and_length() -> None:
    lap = G.lap_samples("AAA", 2, 96.25)
    assert list(lap.columns) == list(G.COLUMNS)
    assert lap["time_in_lap_s"].iloc[0] == 0.0 and lap["time_in_lap_s"].iloc[-1] == 96.25
    assert lap["distance_m"].iloc[0] == 0.0 and lap["distance_m"].iloc[-1] == G.TRACK_LENGTH_M
    assert np.all(np.diff(lap["time_in_lap_s"]) > 0) and np.all(np.diff(lap["distance_m"]) >= 0)
    assert lap["n_gear"].between(1, 8).all() and set(lap["drs"]) <= {0, 1}
    assert lap["throttle_pct"].between(0, 100).all() and lap["brake"].dtype == bool
    assert lap["speed_kph"].max() < 360 and lap["speed_kph"].min() > 40


def test_it_resamples_like_a_real_lap() -> None:
    trace = resample_lap(G.lap_samples("AAA", 2, 96.25))
    assert trace is not None
    assert trace.trace_time_s == pytest.approx(96.25) and trace.lap_length_m == G.TRACK_LENGTH_M
    assert len(trace.zones) >= 5 and trace.min_corner is not None
    assert 0.3 < (trace.full_throttle_share or 0) < 1.0


def test_lap_one_is_a_standing_start() -> None:
    assert G.lap_samples("AAA", 1, 101.5)["speed_kph"].iloc[0] < 5


def test_deterministic_per_driver_and_lap() -> None:
    a = G.build_fixture(LAPS)
    b = G.build_fixture(LAPS)
    assert sorted(a) == ["AAA", "BBB"]
    for code in a:
        assert G.parquet_bytes(a[code]) == G.parquet_bytes(b[code])
    assert not G.lap_samples("AAA", 2, 96.25).equals(G.lap_samples("BBB", 2, 96.25))
    assert sorted(a["BBB"]["lap"].unique()) == [1]  # BBB lap 2 has no lap time: skipped


def test_bad_inputs_are_refused() -> None:
    with pytest.raises(ValueError):
        G.lap_samples("AAA", 1, 0.0)
    with pytest.raises(ValueError, match="columns"):
        G.build_fixture(LAPS.drop(columns=["lap_time_s"]))
    with pytest.raises(ValueError, match="nothing to generate"):
        G.build_fixture(LAPS.assign(lap_time_s=None))


def test_parquet_is_marked_synthetic_and_readable_with_the_raw_schema() -> None:
    data = G.parquet_bytes(G.build_fixture(LAPS)["AAA"])
    table = pq.read_table(pa.BufferReader(data))
    assert table.schema.metadata[b"is_synthetic"] == b"true"
    assert table.schema.metadata[b"generator"] == G.GENERATOR.encode()
    needed = {f.name for f in TT.RAW_TELEMETRY.fields} - {"season", "round"}
    assert needed <= set(table.column_names)


def test_write_fixture_layout_and_guard(tmp_path: Path) -> None:
    lake = tmp_path / "data" / "lake"
    paths = G.write_fixture(lake, G.build_fixture(LAPS), allowed_root=tmp_path / "data" / "lake")
    rel = sorted(str(p.relative_to(lake)) for p in paths)
    assert rel == [
        "fixtures/telemetry_raw/tracinginsights/telemetry/season=2024/round=5/driver=AAA/telemetry.parquet",
        "fixtures/telemetry_raw/tracinginsights/telemetry/season=2024/round=5/driver=BBB/telemetry.parquet",
    ]
    with pytest.raises(ValueError, match="refusing"):
        G.write_fixture(tmp_path / "elsewhere", G.build_fixture(LAPS), allowed_root=lake)


def test_main_reads_the_sample_laps_and_writes_under_data_lake(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lake = tmp_path / "data" / "lake"
    part = lake / "clean" / "analysis_laps" / "season=2024" / "round=5"
    part.mkdir(parents=True)
    pq.write_table(pa.Table.from_pandas(LAPS, preserve_index=False), part / "part-0.parquet")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{lake}")
    assert G.main([]) == 0
    assert (lake / G.FIXTURE_DIR / "tracinginsights" / "telemetry" / "season=2024").is_dir()
    monkeypatch.setenv("DATA_LAKE_URI", "hdfs://namenode:8020/f1")
    get_settings.cache_clear()
    assert G.main([]) == 2
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{tmp_path}/empty")
    get_settings.cache_clear()
    assert G.main([]) == 1
