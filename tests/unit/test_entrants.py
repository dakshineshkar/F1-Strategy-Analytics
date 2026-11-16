"""Display-only entrants dimension (Feature 1) on invented races, plus the real sample bundle.

The fixture season is 2024 with real constructor ids (the committed TEAM_NAMES rows) and invented
drivers, codes, numbers and TracingInsights colours. No F1 data is committed.

Rounds and TracingInsights ``drivers.json``:
* R1: tc for ferrari (AA0000, lower-case on disk); haas is "None"; one ferrari driver missing
  from TI (DNS-like) and one haas driver matched only by car number.
* R2: a drivers.json without ``tc`` keys (as 12 real races) -> ferrari's nearest rounds are R1
  and R3 (a tie): the earlier wins.
* R3: tc for ferrari (BB0000).
* R4: no drivers.json at all -> nearest is R3.
haas never has a colour in 2024 -> project_palette. A 2023 R1 race with alphatauri has no TI
data (palette) and checks the lineage id.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from pyspark.sql import DataFrame, SparkSession

from conftest import SampleLake
from f1sa.config import Settings
from f1sa.etl import clean
from f1sa.etl import entrants as E
from f1sa.etl import entrants_reference as R
from f1sa.etl.clean import CleanError, read_clean
from f1sa.lake import schemas as S
from f1sa.lake import schemas_entrants as ES

# (season, round, driver_id, code, permanent_number, car_number, nationality, constructor, grid)
ENTRIES: list[tuple[int, int, str, str, int, int, str, str, int]] = [
    (2024, 1, "drv_a", "AAA", 99, 16, "Monegasque", "ferrari", 2),
    (2024, 1, "drv_b", "BBB", 98, 38, "British", "ferrari", 1),
    (2024, 1, "drv_c", "CCC", 97, 20, "Danish", "haas", 0),
    (2024, 1, "drv_d", "DDD", 96, 27, "German", "haas", 3),
    (2024, 2, "drv_a", "AAA", 99, 16, "Monegasque", "ferrari", 1),
    (2024, 2, "drv_e", "EEE", 95, 55, "Spanish", "ferrari", 2),
    (2024, 2, "drv_c", "CCC", 97, 20, "Danish", "haas", 3),
    (2024, 2, "drv_d", "DDD", 96, 27, "German", "haas", 4),
    (2024, 3, "drv_a", "AAA", 99, 16, "Monegasque", "ferrari", 1),
    (2024, 3, "drv_e", "EEE", 95, 55, "Spanish", "ferrari", 2),
    (2024, 3, "drv_b", "BBB", 98, 50, "British", "haas", 3),
    (2024, 3, "drv_d", "DDD", 96, 27, "German", "haas", 4),
    (2024, 4, "drv_a", "AAA", 99, 16, "Monegasque", "ferrari", 1),
    (2024, 4, "drv_e", "EEE", 95, 55, "Spanish", "ferrari", 2),
    (2024, 4, "drv_c", "CCC", 97, 20, "Danish", "haas", 3),
    (2024, 4, "drv_d", "DDD", 96, 27, "German", "haas", 4),
    (2023, 1, "drv_f", "FFF", 94, 22, "Japanese", "alphatauri", 1),
    (2023, 1, "drv_g", "GGG", 93, 21, "Dutch", "alphatauri", 2),
]

# TI files per (season, round): list of driver dicts; R4 has no file.
TI_FILES: dict[tuple[int, int], list[dict[str, str]]] = {
    (2024, 1): [
        {"driver": "AAA", "team": "Ferrari", "dn": "16", "tc": "aa0000"},
        {"driver": "CCC", "team": "Haas F1 Team", "dn": "20", "tc": "None"},
        # the haas car 27 under another code: mapped by number
        {"driver": "XXX", "team": "Haas F1 Team", "dn": "27", "tc": "None"},
    ],
    (2024, 2): [
        {"driver": "AAA", "team": "Ferrari"},
        {"driver": "EEE", "team": "Ferrari"},
        {"driver": "CCC", "team": "Haas F1 Team"},
    ],
    (2024, 3): [
        {"driver": "AAA", "team": "Ferrari", "dn": "16", "tc": "BB0000"},
        {"driver": "EEE", "team": "Ferrari", "dn": "55", "tc": "BB0000"},
        {"driver": "BBB", "team": "Haas F1 Team", "dn": "50", "tc": "None"},
    ],
}


def _row(schema: Any, **values: Any) -> tuple[Any, ...]:
    return tuple(values.get(f.name) for f in schema.fields)


def _frames(
    spark: SparkSession,
    entries: list[tuple[int, int, str, str, int, int, str, str, int]] = ENTRIES,
    names: dict[str, str] | None = None,
) -> tuple[DataFrame, DataFrame, DataFrame]:
    jolpica = {cid: t.jolpica_name for (_s, cid), t in R.TEAM_NAMES.items()} | (names or {})
    drivers = [
        _row(
            S.DRIVERS,
            season=s,
            round=r,
            driver_id=d,
            code=c,
            permanent_number=pn,
            car_number=n,
            given_name=d.upper(),
            family_name="Family",
            date_of_birth=date(2000, 1, 1),
            nationality=nat,
            constructor_id=cid,
        )
        for s, r, d, c, pn, n, nat, cid, _g in entries
    ]
    results = [
        _row(
            S.RESULTS,
            season=s,
            round=r,
            driver_id=d,
            constructor_id=cid,
            car_number=n,
            grid=g,
            position=1,
        )
        for s, r, d, _c, _pn, n, _nat, cid, g in entries
    ]
    constructors = sorted(
        {
            _row(S.CONSTRUCTORS, season=s, round=r, constructor_id=cid, name=jolpica[cid])
            for s, r, _d, _c, _pn, _n, _nat, cid, _g in entries
        }
    )
    return (
        spark.createDataFrame(drivers, S.DRIVERS),
        spark.createDataFrame(results, S.RESULTS),
        spark.createDataFrame(constructors, S.CONSTRUCTORS),
    )


def _ti_frame(spark: SparkSession, rows: list[tuple[Any, ...]] | None = None) -> DataFrame:
    if rows is None:
        rows = [
            (
                s,
                r,
                d["driver"],
                int(d["dn"]) if "dn" in d else None,
                d["team"],
                (d.get("tc") or "").upper() if d.get("tc") not in (None, "None") else None,
            )
            for (s, r), ds in TI_FILES.items()
            for d in ds
        ]
    return spark.createDataFrame(rows, ES.TI_DRIVER_ROWS)


def _write_lake(spark: SparkSession, base: Path) -> Settings:
    lake = base / "data" / "lake"
    drivers, results, constructors = _frames(spark)
    root = f"file://{lake}/clean"
    clean.write_table(drivers, root, "drivers")
    clean.write_table(results, root, "results")
    clean.write_table(constructors, root, "constructors")
    for (s, r), ds in TI_FILES.items():
        d = lake / "raw" / "tracinginsights" / "drivers" / f"season={s}" / f"round={r}"
        d.mkdir(parents=True)
        (d / "drivers.json").write_text(json.dumps({"drivers": ds}, indent=1), encoding="utf-8")
    return Settings(_env_file=None, data_lake_uri=f"file://{lake}")  # type: ignore[call-arg]


class Built:
    def __init__(self, base: Path, result: E.EntrantsResult, rows: dict[tuple[int, int, str], Any]):
        self.base = base
        self.result = result
        self.rows = rows


@pytest.fixture(scope="module")
def built(spark: SparkSession, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Built]:
    base = tmp_path_factory.mktemp("entrants")
    cwd = os.getcwd()
    os.chdir(base)  # the output guard resolves ./data/lake against the working directory
    try:
        settings = _write_lake(spark, base)
        result = E.run_entrants(spark, settings)
        stored = E.read_entrants(spark, f"file://{base}/data/lake/clean").collect()
    finally:
        os.chdir(cwd)
    yield Built(base, result, {(r["season"], r["round"], r["driver_id"]): r for r in stored})


# ============================================================================== happy path
def test_one_row_per_race_entry_with_the_exact_schema(built: Built) -> None:
    assert built.result.rows == len(ENTRIES) == len(built.rows)
    assert built.result.races == 5
    row = next(iter(built.rows.values()))
    assert tuple(row.asDict()) == ES.COLUMNS


def test_colour_rule_race_tie_to_earlier_neighbour_and_palette(built: Built) -> None:
    def colour(s: int, r: int, d: str) -> tuple[str, str]:
        row = built.rows[(s, r, d)]
        return row["team_colour_hex"], row["colour_source"]

    assert colour(2024, 1, "drv_a") == ("#AA0000", "ti_race")
    assert colour(2024, 2, "drv_a") == ("#AA0000", "ti_neighbour_round_1")  # R1/R3 tie -> R1
    assert colour(2024, 3, "drv_a") == ("#BB0000", "ti_race")
    assert colour(2024, 4, "drv_a") == ("#BB0000", "ti_neighbour_round_3")  # no file at all
    palette = R.PROJECT_PALETTE[(2024, "haas")]
    for r in (1, 2, 3, 4):
        assert colour(2024, r, "drv_d") == (palette, "project_palette")  # tc "None" everywhere
    assert colour(2023, 1, "drv_f") == (R.PROJECT_PALETTE[(2023, "alphatauri")], "project_palette")


def test_entrant_missing_from_ti_gets_the_teammate_colour(built: Built) -> None:
    assert built.rows[(2024, 1, "drv_b")]["team_colour_hex"] == "#AA0000"
    assert built.rows[(2024, 1, "drv_b")]["colour_source"] == "ti_race"


def test_car_number_not_permanent_number_and_seat_change_per_race(built: Built) -> None:
    r1, r3 = built.rows[(2024, 1, "drv_b")], built.rows[(2024, 3, "drv_b")]
    assert (r1["constructor_id"], r1["team_name"], r1["team_code"], r1["car_number"]) == (
        "ferrari",
        "Ferrari",
        "FER",
        38,
    )
    assert (r3["constructor_id"], r3["team_name"], r3["team_code"], r3["car_number"]) == (
        "haas",
        "Haas F1 Team",
        "HAA",
        50,
    )
    assert all(
        row["car_number"] != 98 for row in built.rows.values() if row["driver_id"] == "drv_b"
    )


def test_names_nationality_lineage_and_grid(built: Built) -> None:
    a = built.rows[(2024, 1, "drv_a")]
    assert (a["code"], a["given_name"], a["family_name"]) == ("AAA", "DRV_A", "Family")
    assert (a["nationality"], a["nationality_code"]) == ("Monegasque", "MON")
    assert built.rows[(2024, 1, "drv_c")]["grid"] == 0  # pit-lane start kept as 0
    f = built.rows[(2023, 1, "drv_f")]
    assert (f["team_name"], f["team_code"], f["team_lineage_id"]) == ("AlphaTauri", "APT", "rb")
    assert a["team_lineage_id"] == "ferrari"
    assert all(R.COLOUR_SOURCE_PATTERN.match(r["colour_source"]) for r in built.rows.values())


def test_quality_report_lists_neighbour_races_and_counts(built: Built) -> None:
    report = json.loads(
        (built.base / "data" / "lake" / "clean" / "_quality" / E.QUALITY_FILE).read_text()
    )
    assert report["rows"] == len(ENTRIES)
    assert report["neighbour_filled_races"] == [
        {"season": 2024, "round": 2, "constructors": {"ferrari": "ti_neighbour_round_1"}},
        {"season": 2024, "round": 4, "constructors": {"ferrari": "ti_neighbour_round_3"}},
    ]
    assert report["team_races_by_colour_source"] == {
        "project_palette": 5,
        "ti_neighbour_round": 2,
        "ti_race": 2,
    }
    assert report["tracinginsights_rows_unmapped"] == 0  # XXX matched by car number 27
    assert report["tracinginsights_team_name_mismatches"] == []
    assert report["checksum"] == built.result.checksum


def test_rerun_is_idempotent(spark: SparkSession, built: Built) -> None:
    cwd = os.getcwd()
    os.chdir(built.base)
    try:
        settings = Settings(
            _env_file=None,  # type: ignore[call-arg]
            data_lake_uri=f"file://{built.base}/data/lake",
        )
        again = E.run_entrants(spark, settings)
    finally:
        os.chdir(cwd)
    assert (again.rows, again.checksum) == (built.result.rows, built.result.checksum)


def test_read_ti_drivers_parses_files_and_missing_values(spark: SparkSession, built: Built) -> None:
    raw = f"file://{built.base}/data/lake/raw"
    rows = {
        (r["season"], r["round"], r["driver_code"]): r
        for r in E.read_ti_drivers(spark, raw).collect()
    }
    assert len(rows) == 9
    assert rows[(2024, 1, "AAA")]["tc"] == "AA0000"
    assert rows[(2024, 1, "CCC")]["tc"] is None  # "None"
    assert rows[(2024, 2, "AAA")]["tc"] is None  # no tc key
    assert rows[(2024, 2, "AAA")]["driver_number"] is None  # no dn key
    assert rows[(2024, 1, "XXX")]["driver_number"] == 27
    assert E.read_ti_drivers(spark, raw, [2023]).count() == 0
    assert E.read_ti_drivers(spark, f"file://{built.base}/nowhere").count() == 0


# ============================================================================== failures
def test_unmapped_constructor_fails(spark: SparkSession) -> None:
    entries = [(2024, 1, "drv_x", "XXX", 1, 1, "British", "brawn", 1)]
    drivers, results, constructors = _frames(spark, entries, names={"brawn": "Brawn"})
    with pytest.raises(CleanError, match=r"not in entrants_reference.TEAM_NAMES.*brawn"):
        E.build_entrants(spark, drivers, results, constructors, _ti_frame(spark, []))


def test_constructor_id_not_raced_that_season_fails(spark: SparkSession) -> None:
    entries = [(2024, 1, "drv_x", "XXX", 1, 1, "British", "alphatauri", 1)]
    drivers, results, constructors = _frames(spark, entries)
    with pytest.raises(CleanError, match=r"TEAM_NAMES.*2024, 'alphatauri'"):
        E.build_entrants(spark, drivers, results, constructors, _ti_frame(spark, []))


def test_jolpica_name_mismatch_fails(spark: SparkSession) -> None:
    drivers, results, constructors = _frames(spark, names={"ferrari": "Scuderia Ferrari"})
    with pytest.raises(CleanError, match=r"name differs.*Scuderia Ferrari"):
        E.build_entrants(spark, drivers, results, constructors, _ti_frame(spark))


def test_missing_constructors_row_fails(spark: SparkSession) -> None:
    drivers, results, constructors = _frames(spark)
    constructors = constructors.where("constructor_id != 'haas'")
    with pytest.raises(CleanError, match="no clean constructors row"):
        E.build_entrants(spark, drivers, results, constructors, _ti_frame(spark))


def test_unmapped_demonym_fails(spark: SparkSession) -> None:
    entries = [*ENTRIES[:3], (2024, 1, "drv_d", "DDD", 96, 27, "Martian", "haas", 3)]
    drivers, results, constructors = _frames(spark, entries)
    with pytest.raises(CleanError, match=r"NATIONALITY_CODES: \['Martian'\]"):
        E.build_entrants(spark, drivers, results, constructors, _ti_frame(spark))


def test_teammates_with_different_colours_fail(spark: SparkSession) -> None:
    drivers, results, constructors = _frames(spark)
    ti = _ti_frame(
        spark,
        [(2024, 3, "AAA", 16, "Ferrari", "BB0000"), (2024, 3, "EEE", 55, "Ferrari", "CC0000")],
    )
    with pytest.raises(
        CleanError, match=r"different TracingInsights colours.*\(2024, 3, 'ferrari'\)"
    ):
        E.build_entrants(spark, drivers, results, constructors, ti)


def test_malformed_tc_fails(spark: SparkSession) -> None:
    drivers, results, constructors = _frames(spark)
    ti = _ti_frame(spark, [(2024, 1, "AAA", 16, "Ferrari", "RED")])
    with pytest.raises(CleanError, match="malformed TracingInsights tc"):
        E.build_entrants(spark, drivers, results, constructors, ti)


def test_team_without_any_colour_fails(spark: SparkSession) -> None:
    drivers, _results, _constructors = _frames(spark)
    _names, palette = E._reference_frames(spark)
    with pytest.raises(CleanError, match="teams without any colour"):
        E.resolve_colours(
            drivers.select("season", "round", "constructor_id").distinct(),
            E.ti_team_colours(_ti_frame(spark, []), drivers),
            palette.where("constructor_id != 'haas'"),
        )


def test_ti_team_name_mismatch_is_reported(spark: SparkSession) -> None:
    drivers, results, constructors = _frames(spark)
    ti = _ti_frame(spark, [(2024, 1, "AAA", 16, "Scuderia Ferrari", "AA0000")])
    df, ti_colours = E.build_entrants(spark, drivers, results, constructors, ti)
    report = E.build_report(df, ti_colours, 0)
    assert report["tracinginsights_team_name_mismatches"] == [
        {
            "season": 2024,
            "round": 1,
            "constructor_id": "ferrari",
            "tracinginsights_team": "Scuderia Ferrari",
            "team_name": "Ferrari",
        }
    ]


def test_no_clean_drivers_fails(spark: SparkSession, tmp_path: Path) -> None:
    (tmp_path / "data" / "lake").mkdir(parents=True)
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        data_lake_uri=f"file://{tmp_path}/data/lake",
    )
    with pytest.raises(CleanError, match="no clean drivers"):
        E.run_entrants(spark, settings)


def test_main_exit_codes(
    spark: SparkSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "data" / "lake").mkdir(parents=True)
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{tmp_path}/data/lake")
    monkeypatch.setattr(E, "build_spark", lambda *_a, **_k: spark)
    monkeypatch.setattr(spark, "stop", lambda: None)
    assert E.main([]) == 1  # no clean drivers


# ============================================================================== real sample
def test_sample_bundle_uses_the_project_palette(
    spark: SparkSession, sample_clean_lake: SampleLake
) -> None:
    root = sample_clean_lake.clean_root
    drivers, results, constructors = (
        read_clean(spark, root, t) for t in ("drivers", "results", "constructors")
    )
    no_ti = spark.createDataFrame([], ES.TI_DRIVER_ROWS)
    df, _ = E.build_entrants(spark, drivers, results, constructors, no_ti)
    rows = df.collect()
    assert len(rows) == 40
    assert {(r["season"], r["round"]) for r in rows} == {(2023, 5), (2024, 5)}
    assert {r["colour_source"] for r in rows} == {"project_palette"}
    assert all(r[c] is not None for r in rows for c in ES.COLUMNS)
    by = {(r["season"], r["driver_id"]): r for r in rows}
    assert by[(2024, "leclerc")]["nationality_code"] == "MON"
    assert by[(2024, "max_verstappen")]["nationality_code"] == "NED"
    assert by[(2024, "max_verstappen")]["car_number"] == 1
    assert by[(2024, "tsunoda")]["team_name"] == "RB"
    assert by[(2024, "bottas")]["team_name"] == "Kick Sauber"
    assert by[(2023, "bottas")]["team_lineage_id"] == "sauber"
