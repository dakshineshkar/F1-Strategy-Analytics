"""``GET /api/races/{s}/{r}/telemetry/*`` (Feature 6): 2024 only, lake read by driver partition,
Redis meta cache, 404 / 422 / 500 / 503.

Invented rows only (no F1 data): 2024 R5, AAA laps 1-3 (lap 2 a pit-in lap, lap 3 the fastest
clean lap) and BBB laps 1-2, each at a constant speed over a 1000 m lap.
"""

from __future__ import annotations

import json
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from _api_fixtures import DirFakeHttpFS, httpfs_session, make_api, make_settings

from f1sa.api import catalog as C
from f1sa.api import telemetry as T
from f1sa.api.entrants import lake_fingerprint
from f1sa.api.models import TelemetryLapOut
from f1sa.serving import keys as K

pytestmark = pytest.mark.anyio

BASE = "/api/races/2024/5/telemetry"
DATA_COLUMNS = [*T.META_COLUMNS, *T.SUMMARY_COLUMNS, *T.ARRAY_COLUMNS]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _row(
    driver_id: str, lap: int, speed_ms: float, lap_time: float | None, **over: Any
) -> dict[str, Any]:
    grid = np.arange(0.0, 1001.0, 5.0)
    n = len(grid)
    row: dict[str, Any] = {c: None for c in DATA_COLUMNS}
    row.update(
        driver_id=driver_id, is_synthetic=False, source="tracinginsights", grid_step_m=5.0,
        lap=lap, lap_time_s=lap_time, trace_time_s=1000.0 / speed_ms, lap_length_m=1000.0,
        n_samples=400, max_gap_s=0.3, coverage="full", is_pit_in_lap=False, is_pit_out_lap=False,
        is_deleted=False, is_neutralised_lap=False, is_red_flag_lap=False, compound="SOFT",
        tyre_life_laps=lap, top_speed_kph=speed_ms * 3.6, top_speed_at_m=10.0,
        min_corner_speed_kph=80.0, min_corner_at_m=500.0, full_throttle_share=0.6,
        brake_share=0.1, drs_share=0.0, n_braking_zones=1,
        distance_m=grid.tolist(), elapsed_s=(grid / speed_ms).tolist(),
        speed_kph=[speed_ms * 3.6] * n, throttle_pct=[100.0] * n, rpm=[11000.0] * n,
        brake=[0] * n, n_gear=[7] * n, drs=[0] * n,
        braking_start_m=[480.0], braking_end_m=[520.0], braking_apex_kph=[80.0],
    )  # fmt: skip
    row.update(over)
    return row


ROWS = {
    "AAA": [
        _row("alpha", 1, 48.0, 21.0),
        _row("alpha", 2, 51.0, 19.6, is_pit_in_lap=True),
        _row("alpha", 3, 50.0, 20.0),
    ],
    "BBB": [_row("bravo", 2, 40.0, 25.0), _row("bravo", 1, 41.0, 24.4)],
}


def _parquet(rows: list[dict[str, Any]]) -> bytes:
    table = pa.Table.from_pylist(rows)
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    return bytes(sink.getvalue().to_pybytes())


def _files(
    season: int = 2024, round_: int = 5, rows: dict[str, list[dict[str, Any]]] | None = None
) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for code, drv_rows in (rows or ROWS).items():
        part = f"{T.TABLE}/season={season}/round={round_}/driver_code={code}"
        out[f"{part}/part-00000-a.c000.zstd.parquet"] = _parquet(drv_rows)
        out[f"{part}/.part-00000-a.c000.zstd.parquet.crc"] = b"junk"
    out[f"{T.TABLE}/_SUCCESS"] = b""
    out[f"{T.TABLE}/_quality.json"] = b"{}"
    return out


def _write(tmp_path: Path, files: dict[str, bytes]) -> None:
    for rel, data in files.items():
        p = tmp_path / "lake" / "clean" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


# ------------------------------------------------------------------ laps
async def test_laps_in_lap_order_with_the_fastest_clean_lap(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
    assert resp.status_code == 200
    body = resp.json()
    assert (body["season"], body["round"], body["driver_id"], body["driver_code"]) == (
        2024,
        5,
        "alpha",
        "AAA",
    )
    assert body["is_synthetic"] is False and body["source"] == "tracinginsights"
    assert [r["lap"] for r in body["rows"]] == [1, 2, 3]
    assert body["fastest_lap"] == 3  # lap 2 is quicker but a pit-in lap
    assert set(body["rows"][0]) == set(TelemetryLapOut.model_fields)
    assert body["rows"][1]["is_pit_in_lap"] is True


async def test_laps_and_traces_are_cached_under_meta_keys_with_ttl(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path, api_telemetry_cache_s=120))
    async with api.client() as c:
        laps = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert laps.status_code == cmp.status_code == 200
    keys = sorted(await api.redis.keys("*"))
    assert keys == [
        "meta:telemetry:2024:5:laps:AAA",
        "meta:telemetry:2024:5:trace:AAA:3",
        "meta:telemetry:2024:5:trace:BBB:1",
    ]
    for key in keys:
        assert 0 < await api.redis.ttl(key) <= 120
        doc = json.loads(await api.redis.get(key))
        assert doc["lake"] == lake_fingerprint(f"file://{tmp_path / 'lake'}")
        assert "file://" not in await api.redis.get(key)
    assert json.loads(await api.redis.get(keys[0]))["data"] == laps.json()
    assert not any(k.startswith("race:") for k in keys)


async def test_a_cache_hit_is_served_without_the_lake(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        first = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        for p in (tmp_path / "lake" / "clean").rglob("*.parquet"):
            p.unlink()
        again = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
    assert again.status_code == 200 and again.json() == first.json()


async def test_an_entry_from_another_lake_or_malformed_is_a_miss(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    other = {"lake": lake_fingerprint("hdfs://namenode:8020/f1"), "data": {"season": 2024}}
    await api.redis.set("meta:telemetry:2024:5:laps:AAA", json.dumps(other), ex=60)
    await api.redis.set("meta:telemetry:2024:5:trace:AAA:3", "{not json", ex=60)
    async with api.client() as c:
        laps = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert laps.status_code == cmp.status_code == 200
    stored = json.loads(await api.redis.get("meta:telemetry:2024:5:laps:AAA"))
    assert stored["lake"] == lake_fingerprint(f"file://{tmp_path / 'lake'}")


async def test_redis_down_falls_back_to_the_lake(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    api.server.connected = False
    async with api.client() as c:
        laps = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert laps.status_code == cmp.status_code == 200


# ------------------------------------------------------------------ compare
async def test_compare_two_drivers(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert resp.status_code == 200
    body = resp.json()
    picked = (
        body["a"]["driver_code"],
        body["a"]["lap"],
        body["b"]["driver_code"],
        body["b"]["lap"],
    )
    assert picked == ("AAA", 3, "BBB", 1)
    n = len(body["distance_m"])
    assert n == 201 and len(body["delta_s"]) == n and len(body["b"]["speed_kph"]) == n
    assert body["final_delta_s"] == pytest.approx(20.0 - 1000 / 41, abs=1e-3)
    assert body["lap_time_delta_s"] == pytest.approx(20.0 - 24.4)
    assert len(body["segments"]) == T.N_SEGMENTS
    assert body["a"]["summary"]["lap"] == 3


async def test_the_same_driver_on_two_laps_is_allowed(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 1, "b": "AAA", "blap": 3})
        same = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "AAA", "blap": 3})
    assert resp.status_code == 200 and resp.json()["final_delta_s"] == pytest.approx(
        1000 / 48 - 20.0, abs=1e-3
    )
    assert same.status_code == 422 and "two different laps" in same.json()["detail"]


# ------------------------------------------------------------------ errors
@pytest.mark.parametrize("season", [2021, 2023, 2025])
async def test_other_seasons_are_404_2024_only_and_never_read(tmp_path: Path, season: int) -> None:
    _write(tmp_path, _files(season=season))  # even with a table there, it is never read
    api = make_api(make_settings(tmp_path, allow_test_season=True))
    async with api.client() as c:
        laps = await c.get(f"/api/races/{season}/5/telemetry/laps", params={"driver": "AAA"})
        cmp = await c.get(
            f"/api/races/{season}/5/telemetry/compare",
            params={"a": "AAA", "alap": 1, "b": "BBB", "blap": 1},
        )
    assert laps.status_code == cmp.status_code == 404
    assert laps.json() == cmp.json() == {"detail": "telemetry traces are available for 2024 only"}
    assert await api.redis.keys("*") == []


@pytest.mark.parametrize(
    "path, params, detail",
    [
        ("/api/races/2024/6/telemetry/laps", {"driver": "AAA"},
         "no telemetry traces for 2024 R6 in the lake (run make telemetry-trace-full)"),
        (f"{BASE}/laps", {"driver": "ZZZ"}, "no telemetry for ZZZ in 2024 R5"),
        (f"{BASE}/compare", {"a": "AAA", "alap": 9, "b": "BBB", "blap": 1},
         "no telemetry trace for AAA lap 9 in 2024 R5"),
        (f"{BASE}/compare", {"a": "AAA", "alap": 1, "b": "ZZZ", "blap": 1},
         "no telemetry for ZZZ in 2024 R5"),
    ],
)  # fmt: skip
async def test_missing_race_driver_or_lap_is_404_and_not_cached(
    tmp_path: Path, path: str, params: dict[str, Any], detail: str
) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(path, params=params)
    assert resp.status_code == 404 and resp.json() == {"detail": detail}
    assert not [k for k in await api.redis.keys("*") if "ZZZ" in k or ":9" in k or ":6:" in k]


async def test_no_table_at_all_is_404(tmp_path: Path) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
    assert resp.status_code == 404 and "make telemetry-trace-full" in resp.json()["detail"]


@pytest.mark.parametrize(
    "path, params",
    [
        (f"{BASE}/laps", {}),
        (f"{BASE}/laps", {"driver": "aaa"}),
        (f"{BASE}/laps", {"driver": "AAAA"}),
        (f"{BASE}/compare", {"a": "AAA", "alap": 0, "b": "BBB", "blap": 1}),
        (f"{BASE}/compare", {"a": "AAA", "alap": 201, "b": "BBB", "blap": 1}),
        (f"{BASE}/compare", {"a": "AAA", "alap": 1, "b": "BBB"}),
        (f"{BASE}/compare", {"a": "AAA", "alap": "x", "b": "BBB", "blap": 1}),
        ("/api/races/2024/31/telemetry/laps", {"driver": "AAA"}),
        ("/api/races/1949/5/telemetry/laps", {"driver": "AAA"}),
    ],
)
async def test_bad_parameters_are_422(tmp_path: Path, path: str, params: dict[str, Any]) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(path, params=params)
    assert resp.status_code == 422


@pytest.mark.parametrize(
    "rows",
    [
        {"AAA": [_row("alpha", 3, 50.0, 20.0, coverage="unknown")]},
        {"AAA": [_row("alpha", 3, 50.0, 20.0, speed_kph=[1.0])]},
        {"AAA": [_row("alpha", 3, 50.0, 20.0), _row("alpha", 3, 50.0, 20.0)]},
        {"AAA": [_row("alpha", 3, 50.0, 20.0, source="fastf1")]},
    ],
)
async def test_a_malformed_row_is_500_and_not_cached(tmp_path: Path, rows: dict[str, Any]) -> None:
    _write(tmp_path, _files(rows=rows))
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        laps = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "AAA", "blap": 2})
    assert 500 in (laps.status_code, cmp.status_code)
    for resp in (laps, cmp):
        if resp.status_code == 500:
            assert resp.json() == {"detail": "stored telemetry trace is malformed"}
    assert not [k for k in await api.redis.keys("*") if k.endswith(":3")]


async def test_over_httpfs_only_the_driver_partition_is_read(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        assert (await c.get(f"{BASE}/laps", params={"driver": "AAA"})).status_code == 200
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert cmp.status_code == 200
    assert {op for op, _ in fake.ops} <= {"LISTSTATUS", "OPEN"} and set(fake.methods) == {"GET"}
    race = f"/f1/clean/{T.TABLE}/season=2024/round=5"
    assert all(p == race or p.startswith(f"{race}/driver_code=") for _, p in fake.ops)
    opened = {p for op, p in fake.ops if op == "OPEN"}
    assert all(p.endswith(".parquet") and "/." not in p for p in opened)


async def test_httpfs_failure_is_503(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    fake.faults["LISTSTATUS"] = [500] * 8
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        laps = await c.get(f"{BASE}/laps", params={"driver": "AAA"})
        cmp = await c.get(f"{BASE}/compare", params={"a": "AAA", "alap": 3, "b": "BBB", "blap": 1})
    assert laps.status_code == cmp.status_code == 503
    assert laps.json() == {"detail": "clean zone unavailable"}


# ------------------------------------------------------------------ reader and keys
def test_driver_reader_limits(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    reader = C.FileLakeReader(
        tmp_path / "lake" / "clean", allow_test_season=False, tables=C.TELEMETRY_TABLES
    )
    rows = reader.read_driver_rows(T.TABLE, 2024, 5, "BBB", ["lap"])
    assert sorted(r["lap"] for r in rows or []) == [1, 2]
    assert reader.read_driver_rows(T.TABLE, 2024, 5, "ZZZ", ["lap"]) == []
    assert reader.read_driver_rows(T.TABLE, 2024, 6, "AAA", ["lap"]) is None
    for code in ("../x", "aaa", "AAAA", "A/B", ""):
        with pytest.raises(C.CatalogError, match="driver code"):
            reader.read_driver_rows(T.TABLE, 2024, 5, code, ["lap"])
    with pytest.raises(C.CatalogError, match="not readable"):
        reader.read_driver_rows("analysis_laps", 2024, 5, "AAA", ["lap"])
    with pytest.raises(C.CatalogError, match="sealed"):
        reader.read_driver_rows(T.TABLE, 2025, 5, "AAA", ["lap"])


def test_telemetry_reader_is_limited_to_the_one_table(tmp_path: Path) -> None:
    reader = C.telemetry_reader(make_settings(tmp_path))
    assert isinstance(reader, C.FileLakeReader) and reader.tables == (T.TABLE,)
    assert C.TELEMETRY_TABLES == T.TABLES


def test_table_name_matches_the_lake_schema() -> None:
    from f1sa.lake import schemas_telemetry_trace as TT

    assert T.TABLE == TT.TABLE and T.SEASON == TT.SEASON
    stored = set(TT.TELEMETRY_TRACE.fieldNames()) - set(TT.PARTITION_COLUMNS)
    assert set(DATA_COLUMNS) <= stored


def test_meta_keys_are_outside_every_race_pattern() -> None:
    laps = K.telemetry_laps_meta_key(2024, 5, "VER")
    trace = K.telemetry_trace_meta_key(2024, 5, "VER", 12)
    assert (laps, trace) == ("meta:telemetry:2024:5:laps:VER", "meta:telemetry:2024:5:trace:VER:12")
    for key in (laps, trace):
        assert not fnmatchcase(key, K.race_pattern(2024, 5)) and not key.startswith("race:")
    for bad in ((2024, 5, "ver"), (2024, 5, "VE"), (2024, 31, "VER"), (1949, 5, "VER")):
        with pytest.raises(K.InvalidKeyError):
            K.telemetry_laps_meta_key(*bad)
    for lap in (0, 201, True, "3"):
        with pytest.raises(K.InvalidKeyError):
            K.telemetry_trace_meta_key(2024, 5, "VER", lap)  # type: ignore[arg-type]
