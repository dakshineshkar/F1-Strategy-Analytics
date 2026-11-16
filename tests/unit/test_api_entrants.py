"""``GET /api/races/{s}/{r}/entrants``: lake read, grid order, Redis meta cache, 404/422/500/503.

Invented rows only (no F1 data): three drivers of one race, one starting from the pit lane and
one with an unknown grid slot.
"""

from __future__ import annotations

import json
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from _api_fixtures import DirFakeHttpFS, httpfs_session, make_api, make_settings

from f1sa.api.entrants import COLUMNS, EntrantsDataError, grid_order, lake_fingerprint, to_entrants
from f1sa.api.models import EntrantOut
from f1sa.serving import keys as K

pytestmark = pytest.mark.anyio

KEY = "meta:entrants:2024:5"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _row(driver_id: str, grid: int | None, number: int, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "driver_id": driver_id,
        "code": driver_id[:3].upper(),
        "given_name": "Given",
        "family_name": driver_id.title(),
        "car_number": number,
        "grid": grid,
        "constructor_id": "ferrari",
        "team_name": "Ferrari",
        "team_code": "FER",
        "team_lineage_id": "ferrari",
        "team_colour_hex": "#D9142B",
        "colour_source": "project_palette",
        "nationality": "Monegasque",
        "nationality_code": "MON",
    }
    row.update(over)
    return row


ROWS = [
    _row("alpha", 2, 16),
    _row(
        "bravo",
        0,
        55,
        constructor_id="haas",
        team_name="Haas F1 Team",
        team_code="HAA",
        team_lineage_id="haas",
        team_colour_hex="#FFFFFF",
        colour_source="ti_neighbour_round_4",
        nationality="Danish",
        nationality_code="DEN",
    ),
    _row("charlie", 1, 20, colour_source="ti_race"),
    _row("delta", None, 3),
]


def _parquet(rows: list[dict[str, Any]]) -> bytes:
    cols = {c: [r[c] for r in rows] for c in COLUMNS}
    types = {"car_number": pa.int32(), "grid": pa.int32()}
    table = pa.table({c: pa.array(v, types.get(c, pa.string())) for c, v in cols.items()})
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    return bytes(sink.getvalue().to_pybytes())


def _files(
    season: int = 2024, round_: int = 5, rows: list[dict[str, Any]] = ROWS
) -> dict[str, bytes]:
    part = f"entrants/season={season}/round={round_}"
    return {
        f"{part}/part-00000-e.c000.snappy.parquet": _parquet(rows),
        f"{part}/.part-00000-e.c000.snappy.parquet.crc": b"junk",
        "entrants/_SUCCESS": b"",
    }


def _write(tmp_path: Path, files: dict[str, bytes]) -> None:
    for rel, data in files.items():
        p = tmp_path / "lake" / "clean" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


async def test_entrants_sorted_by_grid_with_every_field(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 200
    body = resp.json()
    assert (body["season"], body["round"]) == (2024, 5)
    assert [e["driver_id"] for e in body["entrants"]] == ["charlie", "alpha", "delta", "bravo"]
    bravo = body["entrants"][-1]
    assert bravo == {**ROWS[1], "team_text_hex": "#000000"}
    assert bravo["team_colour_hex"] == "#FFFFFF" and bravo["team_text_hex"] == "#000000"
    assert bravo["colour_source"] == "ti_neighbour_round_4"
    assert body["entrants"][0]["team_text_hex"] == "#FFFFFF"  # dark red badge -> white text
    assert set(body["entrants"][0]) == {*COLUMNS, "team_text_hex"}


async def test_entrants_are_cached_under_the_meta_key_with_a_ttl(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path, api_entrants_cache_s=120))
    async with api.client() as c:
        first = await c.get("/api/races/2024/5/entrants")
        ttl = await api.redis.ttl(KEY)
        keys = sorted(await api.redis.keys("*"))
        for f in (tmp_path / "lake" / "clean" / "entrants").rglob("*.parquet"):
            f.unlink()  # a hit never reads the lake
        second = await c.get("/api/races/2024/5/entrants")
    assert first.status_code == second.status_code == 200
    assert second.json() == first.json()
    assert 0 < ttl <= 120
    assert keys == [KEY]  # nothing under race:* and no driver hash
    stored = json.loads(await api.redis.get(KEY))
    assert stored == {
        "entrants": first.json(),
        "lake": lake_fingerprint(f"file://{tmp_path / 'lake'}"),
    }
    assert "file://" not in await api.redis.get(KEY)  # the lake URI itself is never stored


async def test_a_malformed_cache_entry_is_replaced_from_the_lake(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    await api.redis.set(KEY, "{not json", ex=60)
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 200 and len(resp.json()["entrants"]) == 4
    assert json.loads(await api.redis.get(KEY))["entrants"] == resp.json()


async def test_redis_down_falls_back_to_the_lake(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    api.server.connected = False
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 200 and len(resp.json()["entrants"]) == 4


async def test_unknown_race_is_404_and_not_cached(tmp_path: Path) -> None:
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get("/api/races/2024/6/entrants")
        empty_lake = make_api(make_settings(tmp_path / "other"))
        async with empty_lake.client() as c2:
            resp2 = await c2.get("/api/races/2024/5/entrants")
    assert resp.status_code == 404 and resp.json() == {"detail": "no entrants for 2024 R6"}
    assert resp2.status_code == 404
    assert await api.redis.keys("*") == []


@pytest.mark.parametrize("path", ["1949/5", "2101/5", "2024/0", "2024/31", "abc/5", "2024/x"])
async def test_bad_path_parameters_are_422(tmp_path: Path, path: str) -> None:
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get(f"/api/races/{path}/entrants")
    assert resp.status_code == 422


async def test_2025_is_sealed_unless_allowed(tmp_path: Path) -> None:
    _write(tmp_path, _files(2025, 6))
    sealed = make_api(make_settings(tmp_path))
    allowed = make_api(make_settings(tmp_path, allow_test_season=True))
    async with sealed.client() as c:
        no = await c.get("/api/races/2025/6/entrants")
    async with allowed.client() as c:
        yes = await c.get("/api/races/2025/6/entrants")
    assert no.status_code == 404 and await sealed.redis.keys("*") == []
    assert yes.status_code == 200 and len(yes.json()["entrants"]) == 4


async def test_a_malformed_row_is_500(tmp_path: Path) -> None:
    _write(tmp_path, _files(rows=[_row("alpha", 1, 16, team_colour_hex="red")]))
    api = make_api(make_settings(tmp_path))
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 500
    assert resp.json() == {"detail": "stored entrants are malformed"}
    assert await api.redis.keys("*") == []


async def test_over_httpfs_only_reads_the_entrants_table(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 200 and len(resp.json()["entrants"]) == 4
    assert {op for op, _ in fake.ops} <= {"LISTSTATUS", "OPEN"}
    assert set(fake.methods) == {"GET"}
    assert all(p.startswith("/f1/clean/entrants/season=2024/round=5") for _, p in fake.ops)


async def test_httpfs_failure_is_503(tmp_path: Path) -> None:
    fake = DirFakeHttpFS()
    fake.add_tree("/f1/clean", _files())
    fake.faults["LISTSTATUS"] = [500, 500, 500, 500, 500, 500, 500, 500]
    api = make_api(
        make_settings(tmp_path, data_lake_uri="hdfs://namenode:8020/f1"),
        http_session=httpfs_session(fake),
    )
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert resp.status_code == 503 and resp.json() == {"detail": "clean zone unavailable"}


# ------------------------------------------------------------------ pure helpers
def test_meta_key_is_outside_every_race_pattern() -> None:
    assert K.entrants_meta_key(2024, 5) == KEY
    assert not fnmatchcase(KEY, K.race_pattern(2024, 5))
    assert not KEY.startswith("race:")
    with pytest.raises(K.InvalidKeyError):
        K.entrants_meta_key(2024, 31)
    with pytest.raises(K.InvalidKeyError):
        K.entrants_meta_key(1949, 5)


def test_grid_order_and_duplicate_ids() -> None:
    out = to_entrants(2024, 5, ROWS)
    assert [e.driver_id for e in sorted(out.entrants, key=grid_order)] == [
        "charlie",
        "alpha",
        "delta",
        "bravo",
    ]
    with pytest.raises(EntrantsDataError, match="duplicate driver ids"):
        to_entrants(2024, 5, [ROWS[0], ROWS[0]])
    with pytest.raises(EntrantsDataError):
        to_entrants(2024, 5, [_row("x", 1, 1, colour_source="tracinginsights")])
    assert isinstance(out.entrants[0], EntrantOut)


def test_api_columns_match_the_table_and_import_no_spark() -> None:
    import subprocess
    import sys

    from f1sa.api import entrants as A
    from f1sa.lake import schemas_entrants as ES

    assert A.TABLE == ES.TABLE
    assert ("season", "round", *A.COLUMNS) == ES.COLUMNS
    code = "import sys, f1sa.api.app; print('pyspark' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


async def test_an_entry_from_another_lake_is_a_miss(tmp_path: Path) -> None:
    """An api switched from the sample to the full lake must not serve the sample's cached rows."""
    _write(tmp_path, _files())
    api = make_api(make_settings(tmp_path))
    other = [_row("zulu", 1, 99)]
    other_doc = {
        "lake": lake_fingerprint("hdfs://namenode:8020/f1"),
        "entrants": to_entrants(2024, 5, other).model_dump(mode="json"),
    }
    await api.redis.set(KEY, json.dumps(other_doc), ex=60)
    async with api.client() as c:
        resp = await c.get("/api/races/2024/5/entrants")
    assert [e["driver_id"] for e in resp.json()["entrants"]] == [
        "charlie",
        "alpha",
        "delta",
        "bravo",
    ]
    assert json.loads(await api.redis.get(KEY))["lake"] == lake_fingerprint(
        f"file://{tmp_path / 'lake'}"
    )


def test_lake_fingerprint() -> None:
    a, b = lake_fingerprint("file:///x/lake"), lake_fingerprint("hdfs://namenode:8020/f1")
    assert a != b and len(a) == 16 and int(a, 16) >= 0
    assert lake_fingerprint("file:///x/lake") == a
