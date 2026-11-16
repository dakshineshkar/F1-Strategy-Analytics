"""The display-only entrants dimension on the full HDFS lake (``make entrants-full`` first).

Real per-race cases, found in the clean ``drivers`` table on 2026-11-15 (not assumed):
2024 Bearman (Ferrari R2 #38, Haas R17 and R21 #50), Colapinto at Williams from R16, Lawson at RB
from R19; 2025 Tsunoda and Lawson swapping after R2, Colapinto at Alpine from R7, Hamilton at
Ferrari in all 24 races; the 12 races whose colour comes from a neighbouring round. Read-only
(HttpFS ``LISTSTATUS``/``OPEN`` from the host); skipped without HttpFS or the table.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
import requests

from f1sa.api.catalog import CatalogError, LakeReader, zone_reader
from f1sa.api.entrants import COLUMNS
from f1sa.config import Settings
from f1sa.etl.entrants import QUALITY_FILE

pytestmark = pytest.mark.integration

LAKE = "hdfs://namenode:8020/f1"
NEIGHBOURS = {
    (2023, 2): 1,
    (2023, 5): 4,
    (2023, 6): 4,
    (2023, 7): 8,
    (2024, 6): 5,
    (2024, 13): 12,
    (2024, 14): 12,
    (2024, 15): 16,
    (2024, 18): 17,
    (2024, 19): 17,
    (2024, 20): 22,
    (2024, 21): 22,
}


def _settings() -> Settings:
    return Settings(_env_file=None, data_lake_uri=LAKE, allow_test_season=True)  # type: ignore[call-arg]


@pytest.fixture(scope="module")
def reader() -> LakeReader:
    settings = _settings()
    try:
        r = zone_reader(settings, "clean", ("entrants",), allow_test_season=True)
        if not r.partitions("entrants", required=False):
            pytest.skip("no /f1/clean/entrants (run make entrants-full)")
    except (CatalogError, requests.RequestException):
        pytest.skip("HttpFS unavailable (make up-full)")
    return r


Rows = dict[str, dict[str, Any]]


def _race(reader: LakeReader, season: int, round_: int) -> Rows:
    return {r["driver_id"]: r for r in reader.read_rows("entrants", season, round_, COLUMNS)}


def _seat(rows: Rows, driver_id: str) -> tuple[str, str, int] | None:
    r = rows.get(driver_id)
    return None if r is None else (r["constructor_id"], r["team_name"], r["car_number"])


def test_every_race_is_built(reader: LakeReader) -> None:
    parts = reader.partitions("entrants")
    seasons = {s: sum(1 for ss, _ in parts if ss == s) for s in range(2021, 2026)}
    assert seasons == {2021: 22, 2022: 22, 2023: 22, 2024: 24, 2025: 24}


def test_2024_bearman_ferrari_once_haas_twice(reader: LakeReader) -> None:
    seats = {r: _seat(_race(reader, 2024, r), "bearman") for r in range(1, 25)}
    assert {r: s for r, s in seats.items() if s is not None} == {
        2: ("ferrari", "Ferrari", 38),
        17: ("haas", "Haas F1 Team", 50),
        21: ("haas", "Haas F1 Team", 50),
    }


def test_2024_colapinto_at_williams_and_lawson_at_rb(reader: LakeReader) -> None:
    assert _seat(_race(reader, 2024, 15), "colapinto") is None
    assert _seat(_race(reader, 2024, 15), "sargeant") == ("williams", "Williams", 2)
    assert _seat(_race(reader, 2024, 16), "colapinto") == ("williams", "Williams", 43)
    assert _seat(_race(reader, 2024, 16), "sargeant") is None
    assert _seat(_race(reader, 2024, 18), "lawson") is None
    assert _seat(_race(reader, 2024, 18), "ricciardo") == ("rb", "RB", 3)
    assert _seat(_race(reader, 2024, 19), "lawson") == ("rb", "RB", 30)


def test_2025_tsunoda_lawson_swap_after_two_rounds(reader: LakeReader) -> None:
    for r in (1, 2):
        rows = _race(reader, 2025, r)
        assert _seat(rows, "tsunoda") == ("rb", "Racing Bulls", 22)
        assert _seat(rows, "lawson") == ("red_bull", "Red Bull Racing", 30)
    rows = _race(reader, 2025, 3)
    assert _seat(rows, "tsunoda") == ("red_bull", "Red Bull Racing", 22)
    assert _seat(rows, "lawson") == ("rb", "Racing Bulls", 30)
    assert rows["tsunoda"]["team_code"] == "RBR" and rows["lawson"]["team_code"] == "RCB"


def test_2025_colapinto_alpine_and_hamilton_ferrari(reader: LakeReader) -> None:
    assert _seat(_race(reader, 2025, 6), "colapinto") is None
    assert _seat(_race(reader, 2025, 6), "doohan") == ("alpine", "Alpine", 7)
    assert _seat(_race(reader, 2025, 7), "colapinto") == ("alpine", "Alpine", 43)
    assert {_seat(_race(reader, 2025, r), "hamilton") for r in range(1, 25)} == {
        ("ferrari", "Ferrari", 44)
    }


def test_car_number_is_the_number_raced_not_todays(reader: LakeReader) -> None:
    assert _race(reader, 2021, 1)["max_verstappen"]["car_number"] == 33
    assert _race(reader, 2022, 1)["max_verstappen"]["car_number"] == 1
    assert _race(reader, 2023, 13)["lawson"]["car_number"] == 40
    assert _race(reader, 2021, 1)["norris"]["car_number"] == 4


def test_colour_source_per_race(reader: LakeReader) -> None:
    for season, round_ in reader.partitions("entrants"):
        rows = _race(reader, season, round_).values()
        sources = {r["colour_source"] for r in rows}
        if (season, round_) in NEIGHBOURS:
            assert sources == {f"ti_neighbour_round_{NEIGHBOURS[(season, round_)]}"}, (
                season,
                round_,
            )
        else:
            assert sources == {"ti_race"}, (season, round_)
        # teammates share one colour and one display name in every race
        teams: dict[str, set[tuple[str, str]]] = {}
        for r in rows:
            teams.setdefault(r["constructor_id"], set()).add((r["team_colour_hex"], r["team_name"]))
        assert all(len(v) == 1 for v in teams.values()), (season, round_)


def test_quality_report_has_no_ti_mismatch() -> None:
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
        pytest.skip("no entrants quality report (run make entrants-full)")
    report = json.loads(resp.content)
    assert report["tracinginsights_team_name_mismatches"] == []
    assert report["tracinginsights_rows_unmapped"] == 0
    assert report["palette_races"] == []
    assert [(n["season"], n["round"]) for n in report["neighbour_filled_races"]] == sorted(
        NEIGHBOURS
    )
