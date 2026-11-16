"""The display-only race-analysis tables on the full HDFS lake (``make analysis-full`` first).

Real cases, measured on 2026-11-16 before the job was written (Step 1 of Feature 2) and in the
read-only dry run: the Jolpica lap counts per season, 221 TracingInsights-only uncompleted laps
(``docs/data_dictionary.md``, lap reconciliation), 2024 R5 (China) whose safety car the per-lap
track-status codes put on laps 22-31 (the Jolpica heuristic said 21-31), and 2021 R12 (Belgium,
one lap behind the safety car). Every stored row of every race must also validate against the API
models. Read-only (HttpFS ``LISTSTATUS``/``OPEN`` from the host); skipped without HttpFS or the
tables.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
import requests

from f1sa.api import analysis as A
from f1sa.api.catalog import CatalogError, LakeReader, zone_reader
from f1sa.api.models import AnalysisLapOut
from f1sa.config import Settings
from f1sa.etl.analysis import QUALITY_FILE

pytestmark = pytest.mark.integration

LAKE = "hdfs://namenode:8020/f1"
JOLPICA_LAPS = {"2021": 23_688, "2022": 23_529, "2023": 24_386, "2024": 26_574, "2025": 26_657}
RACES = {2021: 22, 2022: 22, 2023: 22, 2024: 24, 2025: 24}


def _settings() -> Settings:
    return Settings(_env_file=None, data_lake_uri=LAKE, allow_test_season=True)  # type: ignore[call-arg]


@pytest.fixture(scope="module")
def reader() -> LakeReader:
    try:
        r = zone_reader(_settings(), "clean", A.TABLES, allow_test_season=True)
        if not r.partitions(A.RACE_TABLE, required=False):
            pytest.skip("no /f1/clean/analysis_race (run make analysis-full)")
    except (CatalogError, requests.RequestException):
        pytest.skip("HttpFS unavailable (make up-full)")
    return r


@pytest.fixture(scope="module")
def report() -> dict[str, Any]:
    settings = _settings()
    try:
        resp = requests.get(
            f"{settings.hdfs_httpfs_url}/webhdfs/v1/f1/clean/_quality/{QUALITY_FILE}",
            params={"op": "OPEN", "user.name": settings.hdfs_user},
            timeout=10,
        )
    except requests.RequestException:
        pytest.skip("HttpFS unavailable")
    if resp.status_code == 404:
        pytest.skip("no analysis quality report (run make analysis-full)")
    doc: dict[str, Any] = json.loads(resp.content)
    return doc


def _view(reader: LakeReader, view: str, season: int, round_: int) -> Any:
    race = reader.read_rows(A.RACE_TABLE, season, round_, A.COVERAGE_COLUMNS)
    coverage = A.to_coverage(season, round_, race)
    model = A.ROW_MODELS[view]
    rows = reader.read_rows(A.VIEW_TABLES[view], season, round_, tuple(model.model_fields))
    return A.to_view(view, season, round_, coverage, rows)


def test_every_race_is_built(reader: LakeReader) -> None:
    for table in (A.RACE_TABLE, A.LAPS_TABLE, A.STINTS_TABLE, A.RACE_CONTROL_TABLE):
        parts = reader.partitions(table)
        seasons = {s: sum(1 for ss, _ in parts if ss == s) for s in RACES}
        assert seasons == RACES, table
    # A race without pit stops has no pitstops partition: only 2021 R12 (one lap behind the SC).
    no_stops = {
        (s, r)
        for s, r in reader.partitions(A.RACE_TABLE)
        if reader.read_rows(A.RACE_TABLE, s, r, ("n_pitstops",))[0]["n_pitstops"] == 0
    }
    assert no_stops == {(2021, 12)}
    assert (
        set(reader.partitions(A.PITSTOPS_TABLE)) == set(reader.partitions(A.RACE_TABLE)) - no_stops
    )


def test_quality_report_counts(report: dict[str, Any]) -> None:
    assert report["source"] == "lake" and report["races"] == sum(RACES.values())
    cov = report["coverage_by_season"]
    assert {s: c["lap_rows"] for s, c in cov.items()} == JOLPICA_LAPS
    assert report["ti_only_laps_dropped"] == 221 and report["ti_rows_unmapped"] == 0
    assert cov["2024"]["deleted"] == 326
    assert all(c["neutralised_heuristic"] == 0 for c in cov.values())
    assert report["races_by_tyre_source"] == {"tracinginsights": sum(RACES.values())}
    assert report["races_by_neutralised_source"] == {"track_status": sum(RACES.values())}


def test_every_stored_row_validates_against_the_api_models(reader: LakeReader) -> None:
    for season, n in RACES.items():
        for round_ in range(1, n + 1):
            for view in A.VIEW_TABLES:
                out = _view(reader, view, season, round_)
                assert out.coverage.n_lap_rows > 0 or view != "laps"


def test_2024_r5_safety_car_from_track_status(reader: LakeReader) -> None:
    laps = _view(reader, "laps", 2024, 5)
    assert laps.coverage.n_lap_rows == 1030 and laps.coverage.n_race_control == 56
    leader = sorted(r.lap for r in laps.rows if r.position == 1 and r.is_neutralised_lap)
    assert leader == list(range(22, 32))
    ver: dict[int, AnalysisLapOut] = {r.lap: r for r in laps.rows if r.driver_code == "VER"}
    assert (ver[21].track_status, ver[21].is_neutralised_lap) == ("12", False)  # yellow only
    assert (ver[24].compound, ver[24].tyre_life_laps, ver[24].stint) == ("HARD", 1, 3)
    assert ver[23].quick_lap_exclusion == "pit_in" and ver[19].sector1_s is not None
    rc = _view(reader, "race_control", 2024, 5)
    key = [(r.lap, r.kind) for r in rc.rows if r.is_key]
    assert key[:5] == [
        (22, "vsc_deployed"),  # the per-lap codes: 26 (VSC) on lap 22, 64 on lap 23
        (23, "sc_deployed"),
        (26, "sc_ending"),
        (27, "sc_deployed"),
        (31, "sc_ending"),
    ]
    assert sum(k == "penalty" for _, k in key) == 3


def test_2021_r12_one_lap_and_the_uncompleted_laps_dropped(reader: LakeReader) -> None:
    laps = _view(reader, "laps", 2021, 12)
    cov = laps.coverage
    assert (cov.n_laps, cov.n_lap_rows, cov.n_ti_only_laps_dropped) == (1, 20, 40)
    assert {r.quick_lap_exclusion for r in laps.rows} == {"lap_1"}
    rc = _view(reader, "race_control", 2021, 12)
    assert sum(r.kind == "red_flag" for r in rc.rows) == 2
