"""``GET /api/races/{s}/{r}/analysis/*``: lake read, shaping, Redis meta cache, 404/422/500/503.

Invented rows only (no F1 data): one race, two drivers (``alpha`` AAA, ``bravo`` BBB) over three
laps. ``alpha`` pits at the end of lap 2; lap 3 is a safety-car lap; ``bravo`` has no sector 1 on
lap 1; ``alpha``'s lap 1 speed trap is NaN (must become null).
"""

from __future__ import annotations

import json
import math
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from _api_fixtures import DirFakeHttpFS, httpfs_session, make_api, make_settings

from f1sa.api import analysis as A
from f1sa.api.entrants import lake_fingerprint
from f1sa.api.models import (
    AnalysisCoverageOut,
    AnalysisLapOut,
    AnalysisPitStopOut,
    AnalysisRaceControlOut,
    AnalysisStintOut,
)
from f1sa.serving import keys as K

pytestmark = pytest.mark.anyio

PREFIX = "/api/races/2024/5/analysis"
VIEWS = {
    "laps": "laps",
    "stints": "stints",
    "pitstops": "pitstops",
    "race-control": "race_control",
    "positions": "positions",
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


COVERAGE: dict[str, Any] = {
    "n_drivers": 2,
    "n_laps": 3,
    "n_lap_rows": 6,
    "tyre_source": "tracinginsights",
    "is_synthetic": False,
    "has_sectors": True,
    "has_speed_traps": True,
    "deleted_known": True,
    "neutralised_source": "track_status",
    "n_race_control": 2,
    "n_pitstops": 1,
    "n_quick_laps": 2,
    "n_ti_only_laps_dropped": 0,
}


def _lap(
    driver: str, code: str, lap: int, pos: int, time: float, cum: float, **over: Any
) -> dict[str, Any]:
    row: dict[str, Any] = {c: None for c in AnalysisLapOut.model_fields}
    row.update(
        driver_id=driver,
        driver_code=code,
        lap=lap,
        position=pos,
        lap_time_s=time,
        cumulative_time_s=cum,
        gap_to_leader_s=0.0,
        sector1_s=30.0,
        sector2_s=31.0,
        sector3_s=29.0,
        speed_st_kph=310.0,
        stint=1,
        compound="MEDIUM",
        tyre_life_laps=lap,
        compound_source="tracinginsights",
        is_synthetic=False,
        is_pit_in_lap=False,
        is_pit_out_lap=False,
        is_deleted=False,
        track_status="1",
        is_sc_lap=False,
        is_vsc_lap=False,
        is_red_flag_lap=False,
        is_neutralised_lap=False,
        neutralised_source="track_status",
        is_quick_lap=lap == 2,
        quick_lap_exclusion=None if lap == 2 else "lap_1",
    )
    row.update(over)
    return row


SC = {"track_status": "4", "is_sc_lap": True, "is_neutralised_lap": True, "is_quick_lap": False}
LAPS = [
    _lap("bravo", "BBB", 2, 2, 91.0, 192.5, sector1_s=30.5),
    _lap("alpha", "AAA", 1, 1, 100.0, 100.0, speed_st_kph=math.nan),
    _lap("alpha", "AAA", 2, 1, 90.0, 190.0, is_pit_in_lap=True),
    _lap("alpha", "AAA", 3, 2, 120.0, 310.0, is_pit_out_lap=True, compound="HARD", stint=2,
         tyre_life_laps=1, quick_lap_exclusion="pit_out", **SC),
    _lap("bravo", "BBB", 1, 2, 101.5, 101.5, sector1_s=None),
    _lap("bravo", "BBB", 3, 1, 110.0, 302.5, quick_lap_exclusion="neutralised", **SC),
]  # fmt: skip
STINTS = [
    {
        "driver_id": "alpha",
        "driver_code": "AAA",
        "stint": s,
        "compound": c,
        "start_lap": a,
        "end_lap": b,
        "laps": b - a + 1,
        "tyre_life_start": 1,
        "tyre_life_end": b - a + 1,
        "used_set": False,
        "ends_in_pit": s == 1,
        "n_quick_laps": 1 if s == 1 else 0,
        "deg_slope_s_per_lap": None,
        "deg_intercept_s": None,
        "median_quick_lap_s": 90.0 if s == 1 else None,
        "fit_status": "too_few_laps",
        "compound_source": "tracinginsights",
        "is_synthetic": False,
    }
    for s, c, a, b in ((2, "HARD", 3, 3), (1, "MEDIUM", 1, 2))
]
PITSTOPS = [
    {
        "driver_id": "alpha",
        "driver_code": "AAA",
        "stop": 1,
        "lap": 2,
        "time_of_day": "15:10:00",
        "duration_s": 22.4,
        "is_long_stop": False,
        "under_neutralisation": False,
        "compound_before": "MEDIUM",
        "compound_after": "HARD",
        "tyre_life_before": 2,
        "position_before": 1,
        "position_after": 2,
    }
]
RACE_CONTROL = [
    {
        "seq": seq,
        "lap": lap,
        "time_utc": f"2024-04-21T07:0{seq}:00.000Z",
        "category": "SafetyCar" if kind == "sc_deployed" else "Other",
        "message": msg,
        "status": None,
        "flag": None,
        "scope": None,
        "driver_id": None,
        "driver_code": None,
        "kind": kind,
        "is_key": kind == "sc_deployed",
    }
    for seq, lap, msg, kind in (
        (1, 3, "SAFETY CAR DEPLOYED", "sc_deployed"),
        (0, 1, "DRS ENABLED", "other"),
    )
]
ENTRANTS = [{"driver_id": "alpha", "grid": 2}, {"driver_id": "bravo", "grid": 1}]


def _parquet(rows: list[dict[str, Any]], columns: list[str]) -> bytes:
    table = pa.table({c: pa.array([r.get(c) for r in rows]) for c in columns})
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    return bytes(sink.getvalue().to_pybytes())


def _files(
    season: int = 2024, round_: int = 5, **override: list[dict[str, Any]]
) -> dict[str, bytes]:
    tables: dict[str, tuple[list[dict[str, Any]], list[str]]] = {
        A.RACE_TABLE: ([COVERAGE], list(AnalysisCoverageOut.model_fields)),
        A.LAPS_TABLE: (LAPS, list(AnalysisLapOut.model_fields)),
        A.STINTS_TABLE: (STINTS, list(AnalysisStintOut.model_fields)),
        A.PITSTOPS_TABLE: (PITSTOPS, list(AnalysisPitStopOut.model_fields)),
        A.RACE_CONTROL_TABLE: (RACE_CONTROL, list(AnalysisRaceControlOut.model_fields)),
        A.ENTRANTS_TABLE: (ENTRANTS, ["driver_id", "grid"]),
    }
    out: dict[str, bytes] = {}
    for table, (rows, cols) in tables.items():
        rows = override.get(table, rows)
        part = f"{table}/season={season}/round={round_}"
        out[f"{part}/part-00000-a.c000.snappy.parquet"] = _parquet(rows, cols)
        out[f"{part}/.part-00000-a.c000.snappy.parquet.crc"] = b"junk"
        out[f"{table}/_SUCCESS"] = b""
    return out


def _write(tmp_path: Path, files: dict[str, bytes]) -> None:
    for rel, data in files.items():
        p = tmp_path / "lake" / "clean" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


def _key(view: str) -> str:
    return f"meta:analysis:2024:5:{view}"


# ------------------------------------------------------------------ views
async def test_laps_sorted_with_coverage_and_nan_as_null(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/laps")
    assert resp.status_code == 200
    body = resp.json()
    assert (body["season"], body["round"], body["coverage"]) == (2024, 5, COVERAGE)
    assert [(r["driver_id"], r["lap"]) for r in body["rows"]] == [
        ("alpha", 1), ("alpha", 2), ("alpha", 3), ("bravo", 1), ("bravo", 2), ("bravo", 3),
    ]  # fmt: skip
    assert body["rows"][0]["speed_st_kph"] is None  # NaN in the lake
    assert set(body["rows"][0]) == set(AnalysisLapOut.model_fields)
    assert body["rows"][2]["is_sc_lap"] is True and body["rows"][2]["compound"] == "HARD"


async def test_stints_pitstops_and_race_control(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        stints = (await c.get(f"{PREFIX}/stints")).json()
        pits = (await c.get(f"{PREFIX}/pitstops")).json()
        rc = (await c.get(f"{PREFIX}/race-control")).json()
    assert [s["stint"] for s in stints["rows"]] == [1, 2]
    assert stints["rows"][0]["fit_status"] == "too_few_laps"
    assert pits["rows"] == PITSTOPS
    assert [r["seq"] for r in rc["rows"]] == [0, 1]
    assert rc["rows"][1]["kind"] == "sc_deployed" and rc["rows"][1]["is_key"] is True
    assert rc["coverage"] == COVERAGE


async def test_empty_race_control_is_200_with_coverage(tmp_path: Path) -> None:
    _write(
        tmp_path,
        _files(**{A.RACE_CONTROL_TABLE: [], A.RACE_TABLE: [COVERAGE | {"n_race_control": 0}]}),
    )
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/race-control")
    assert resp.status_code == 200
    assert resp.json()["rows"] == [] and resp.json()["coverage"]["n_race_control"] == 0


async def test_positions_in_finishing_order_with_the_grid(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        body = (await c.get(f"{PREFIX}/positions")).json()
    assert [r["driver_code"] for r in body["rows"]] == ["BBB", "AAA"]  # bravo P1 on the last lap
    assert body["rows"][0]["grid"] == 1 and body["rows"][1]["grid"] == 2
    assert body["rows"][1]["positions"] == [
        {"lap": 1, "position": 1},
        {"lap": 2, "position": 1},
        {"lap": 3, "position": 2},
    ]


async def test_compare_deltas_gap_and_sectors(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/compare", params={"a": "AAA", "b": "BBB"})
        keys = sorted(await api.redis.keys("*"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["a"] == {"driver_id": "alpha", "driver_code": "AAA"}
    assert body["b"] == {"driver_id": "bravo", "driver_code": "BBB"}
    r1, r2, r3 = body["rows"]
    assert (r1["delta_s"], r1["gap_s"], r1["sector1_delta_s"]) == (-1.5, -1.5, None)
    assert (r2["delta_s"], r2["gap_s"], r2["sector1_delta_s"]) == (-1.0, -2.5, -0.5)
    assert (r3["delta_s"], r3["gap_s"], r3["neutralised"]) == (10.0, 7.5, True)
    assert (r2["a_pit"], r3["a_pit"], r2["b_pit"]) == (True, True, False)
    assert (r3["a_compound"], r3["b_compound"]) == ("HARD", "MEDIUM")
    assert keys == [_key("laps")]  # compare is derived from the cached laps: no key of its own


@pytest.mark.parametrize(
    ("params", "status"),
    [
        ({"a": "AAA", "b": "AAA"}, 422),
        ({"a": "aaa", "b": "BBB"}, 422),
        ({"a": "AAAA", "b": "BBB"}, 422),
        ({"a": "AAA"}, 422),
        ({"a": "AAA", "b": "ZZZ"}, 404),
    ],
)
async def test_compare_validation(tmp_path: Path, params: dict[str, str], status: int) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/compare", params=params)
    assert resp.status_code == status
    if status == 404:
        assert resp.json() == {"detail": "no laps for ZZZ in 2024 R5"}


# ------------------------------------------------------------------ cache
async def test_every_view_is_cached_under_its_meta_key_with_a_ttl(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path, api_analysis_cache_s=120))
    async with api.client() as c:
        first = {v: (await c.get(f"{PREFIX}/{v}")).json() for v in VIEWS}
        ttls = [await api.redis.ttl(_key(k)) for k in VIEWS.values()]
        keys = sorted(await api.redis.keys("*"))
        for f in (tmp_path / "lake" / "clean").rglob("*.parquet"):
            f.unlink()  # a hit never reads the lake
        second = {v: (await c.get(f"{PREFIX}/{v}")).json() for v in VIEWS}
        compare = await c.get(f"{PREFIX}/compare", params={"a": "BBB", "b": "AAA"})
    assert second == first
    assert compare.status_code == 200
    assert all(0 < t <= 120 for t in ttls)
    assert keys == sorted(_key(k) for k in VIEWS.values())  # nothing under race:*
    for path, view in VIEWS.items():
        stored = json.loads(await api.redis.get(_key(view)))
        assert stored == {
            "data": first[path],
            "lake": lake_fingerprint(f"file://{tmp_path / 'lake'}"),
        }
    for view in VIEWS.values():
        assert "file://" not in await api.redis.get(_key(view))  # the lake URI is never stored


async def test_an_entry_from_another_lake_or_malformed_is_a_miss(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    other = {"lake": lake_fingerprint("hdfs://namenode:8020/f1"), "data": {"season": 2024}}
    await api.redis.set(_key("stints"), json.dumps(other), ex=60)
    await api.redis.set(_key("laps"), "{not json", ex=60)
    async with api.client() as c:
        stints = await c.get(f"{PREFIX}/stints")
        laps = await c.get(f"{PREFIX}/laps")
    assert stints.status_code == laps.status_code == 200
    assert json.loads(await api.redis.get(_key("stints")))["lake"] == lake_fingerprint(
        f"file://{tmp_path / 'lake'}"
    )
    assert json.loads(await api.redis.get(_key("laps")))["data"] == laps.json()


async def test_redis_down_falls_back_to_the_lake(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    api.server.connected = False
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/laps")
        cmp = await c.get(f"{PREFIX}/compare", params={"a": "AAA", "b": "BBB"})
    assert resp.status_code == cmp.status_code == 200 and len(resp.json()["rows"]) == 6


# ------------------------------------------------------------------ errors
@pytest.mark.parametrize("view", [*VIEWS, "compare?a=AAA&b=BBB"])
async def test_unknown_race_is_404_and_not_cached(tmp_path: Path, view: str) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"/api/races/2024/6/analysis/{view}")
    assert resp.status_code == 404 and resp.json() == {"detail": "no analysis for 2024 R6"}
    assert await api.redis.keys("*") == []


@pytest.mark.parametrize("path", ["1949/5", "2101/5", "2024/0", "2024/31", "abc/5", "2024/x"])
async def test_bad_path_parameters_are_422(tmp_path: Path, path: str) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"/api/races/{path}/analysis/laps")
    assert resp.status_code == 422


async def test_unknown_view_is_404(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/telemetry")
    assert resp.status_code == 404


async def test_2025_is_sealed_unless_allowed(tmp_path: Path) -> None:
    _write(tmp_path, _files(2025, 6))
    sealed = make_api(make_settings(tmp_path))
    allowed = make_api(make_settings(tmp_path, allow_test_season=True))
    async with sealed.client() as c:
        no = await c.get("/api/races/2025/6/analysis/laps")
        no_cmp = await c.get("/api/races/2025/6/analysis/compare", params={"a": "AAA", "b": "BBB"})
    async with allowed.client() as c:
        yes = await c.get("/api/races/2025/6/analysis/laps")
    assert no.status_code == no_cmp.status_code == 404 and await sealed.redis.keys("*") == []
    assert yes.status_code == 200 and len(yes.json()["rows"]) == 6


@pytest.mark.parametrize(
    "override",
    [
        {A.LAPS_TABLE: [LAPS[0] | {"compound": "HYPERSOFT"}]},
        {A.RACE_TABLE: [COVERAGE, COVERAGE]},
        {A.RACE_TABLE: [COVERAGE | {"tyre_source": "fastf1"}]},
    ],
)
async def test_a_malformed_row_is_500(tmp_path: Path, override: dict[str, Any]) -> None:
    _write(tmp_path, _files(**override))
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/laps")
    assert resp.status_code == 500
    assert resp.json() == {"detail": "stored analysis is malformed"}
    assert await api.redis.keys("*") == []


async def test_over_httpfs_only_reads_the_analysis_tables(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        for view in VIEWS:
            assert (await c.get(f"{PREFIX}/{view}")).status_code == 200
    assert {op for op, _ in fake.ops} <= {"LISTSTATUS", "OPEN"}
    assert set(fake.methods) == {"GET"}
    allowed = tuple(f"/f1/clean/{t}/season=2024/round=5" for t in A.TABLES)
    assert all(p.startswith(allowed) for _, p in fake.ops)


async def test_httpfs_failure_is_503(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    fake.faults["LISTSTATUS"] = [500] * 8
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        resp = await c.get(f"{PREFIX}/laps")
        cmp = await c.get(f"{PREFIX}/compare", params={"a": "AAA", "b": "BBB"})
    assert resp.status_code == cmp.status_code == 503
    assert resp.json() == {"detail": "clean zone unavailable"}


# ------------------------------------------------------------------ pure helpers
def test_meta_keys_are_outside_every_race_pattern() -> None:
    for view in K.ANALYSIS_VIEWS:
        key = K.analysis_meta_key(2024, 5, view)
        assert key == _key(view)
        assert not fnmatchcase(key, K.race_pattern(2024, 5)) and not key.startswith("race:")
    for bad in ((2024, 5, "compare"), (2024, 5, "laps:x"), (2024, 31, "laps"), (1949, 5, "laps")):
        with pytest.raises(K.InvalidKeyError):
            K.analysis_meta_key(*bad)


def test_unknown_view_in_the_service_is_an_error() -> None:
    import asyncio

    svc = A.AnalysisService(lambda: None, None, ttl_s=1, allow_test_season=False, lake_id="x")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="unknown analysis view"):
        asyncio.run(svc.get(2024, 5, "telemetry"))


def test_shaping_helpers() -> None:
    cov = A.to_coverage(2024, 5, [COVERAGE])
    laps = A.to_view("laps", 2024, 5, cov, LAPS)
    assert isinstance(laps, A.AnalysisLapsOut)
    pos = A.to_positions(laps, {"alpha": 0})
    assert [r.grid for r in pos.rows] == [None, 0]
    cmp = A.to_compare(laps, "BBB", "AAA")
    assert cmp.rows[0].delta_s == 1.5
    with pytest.raises(A.UnknownDriverError, match="ZZZ"):
        A.to_compare(laps, "AAA", "ZZZ")
    with pytest.raises(A.AnalysisDataError):
        A.to_coverage(2024, 5, [])


def test_api_tables_and_columns_match_the_lake_schemas_and_import_no_spark() -> None:
    import subprocess
    import sys

    from f1sa.lake import schemas_analysis as AS

    assert (A.RACE_TABLE, A.LAPS_TABLE, A.STINTS_TABLE, A.PITSTOPS_TABLE, A.RACE_CONTROL_TABLE) == (
        AS.RACE,
        AS.LAPS,
        AS.STINTS,
        AS.PITSTOPS,
        AS.RACE_CONTROL,
    )
    pairs = {
        AS.RACE: AnalysisCoverageOut,
        AS.LAPS: AnalysisLapOut,
        AS.STINTS: AnalysisStintOut,
        AS.PITSTOPS: AnalysisPitStopOut,
        AS.RACE_CONTROL: AnalysisRaceControlOut,
    }
    for table, model in pairs.items():
        assert ["season", "round", *model.model_fields] == AS.SCHEMAS[table].fieldNames(), table
    assert (*A.VIEW_TABLES, "positions") == K.ANALYSIS_VIEWS
    code = "import sys, f1sa.api.app; print('pyspark' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
