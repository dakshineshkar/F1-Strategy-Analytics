"""Display-only race-analysis tables (Feature 2) on invented races, plus the real sample bundle.

Invented 2024 R1 (TracingInsights present), 16 laps, two drivers. No F1 data is committed.

* ``drv_a`` (TI code AAA, car 1), always P1. Stint 1 = laps 1-6 on a used SOFT (tyre age 2 at the
  start), pit stop on lap 6; stint 2 = laps 7-16 on a new HARD. Stint 2 lap times are exactly
  ``85 + 0.1 * tyre_life`` on its quick laps; the other laps of stint 2 are lap 7 (pit out),
  lap 10 (track status "41" = SC), lap 12 (deleted) and lap 14 (95 s > 1.07 x the fastest).
* ``drv_b`` (TI code XXX, so mapped by car number 2), one stint with a compound conflict (no
  compound), and a TI-only lap 17 (an uncompleted lap Jolpica does not have).

Invented 2024 R2 has no TracingInsights at all and synthetic v1 stints (the sample's situation);
its lap 3 is neutralised by the v1 heuristic.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyspark.sql import SparkSession

from conftest import SampleLake
from f1sa.config import Settings
from f1sa.etl import analysis as A
from f1sa.etl import clean
from f1sa.etl.clean import CleanError
from f1sa.etl.clean_tracinginsights import write_ti_table
from f1sa.lake import schemas as S
from f1sa.lake import schemas_analysis as AS
from f1sa.lake import schemas_tracinginsights as TS

LAPS_R1 = 16


def _row(schema: Any, **values: Any) -> tuple[Any, ...]:
    return tuple(values.get(f.name) for f in schema.fields)


def _a_time(lap: int) -> float:
    """drv_a's lap time (see the module docstring)."""
    if lap == 1:
        return 100.0
    if lap <= 5:
        return round(90.0 + 0.2 * (lap + 2), 3)
    if lap == 6:
        return 110.0
    if lap == 7:
        return 120.0
    if lap == 10:
        return 130.0
    if lap == 14:
        return 95.0
    return round(85.0 + 0.1 * (lap - 6), 3)


def _b_time(lap: int) -> float:
    return 101.0 if lap == 1 else (131.0 if lap == 10 else 88.0)


def _v1_laps() -> list[tuple[Any, ...]]:
    rows = []
    for driver, timer, pos in (("drv_a", _a_time, 1), ("drv_b", _b_time, 2)):
        cum = 0.0
        for lap in range(1, LAPS_R1 + 1):
            cum += timer(lap)
            rows.append(
                _row(
                    S.LAPS,
                    season=2024,
                    round=1,
                    driver_id=driver,
                    lap=lap,
                    position=pos,
                    lap_time_s=timer(lap),
                    cumulative_time_s=round(cum, 3),
                    is_pit_in_lap=driver == "drv_a" and lap == 6,
                    is_pit_out_lap=driver == "drv_a" and lap == 7,
                    is_red_flag_lap=False,
                    is_neutralised_lap=False,
                    track_status_source="heuristic",
                )
            )
    for driver, pos in (("drv_a", 1), ("drv_b", 2)):
        for lap in range(1, 6):
            rows.append(
                _row(
                    S.LAPS,
                    season=2024,
                    round=2,
                    driver_id=driver,
                    lap=lap,
                    position=pos,
                    lap_time_s=95.0 + pos,
                    is_pit_in_lap=False,
                    is_pit_out_lap=False,
                    is_red_flag_lap=False,
                    is_neutralised_lap=lap == 3,
                    track_status_source="heuristic",
                )
            )
    return rows


def _ti_laps() -> pa.Table:
    rows: list[dict[str, Any]] = []
    for lap in range(1, LAPS_R1 + 1):
        stint, life = (1, lap + 2) if lap <= 6 else (2, lap - 6)
        rows.append(
            {
                "driver_code": "AAA",
                "driver_number": "1",
                "team": "Team A",
                "lap": lap,
                "lap_time_s": _a_time(lap),
                "sector1_s": None if lap == 1 else 28.0,
                "sector2_s": 30.0,
                "sector3_s": 27.0,
                "speed_i1_kph": 280.0,
                "speed_i2_kph": 270.0,
                "speed_fl_kph": 260.0,
                "speed_st_kph": 320.0 + lap,
                "compound": "soft" if stint == 1 else "HARD",
                "stint": stint,
                "tyre_life": life,
                "track_status": "41" if lap == 10 else "1",
                "deleted": lap == 12,
                "deleted_reason": "TRACK LIMITS AT TURN 4" if lap == 12 else None,
            }
        )
    for lap in range(1, LAPS_R1 + 2):  # lap 17: TI only
        rows.append(
            {
                "driver_code": "XXX",
                "driver_number": "2",
                "team": "Team B",
                "lap": lap,
                "lap_time_s": None if lap == 17 else _b_time(lap),
                "sector1_s": 29.0,
                "sector2_s": 31.0,
                "sector3_s": 28.0,
                "speed_i1_kph": None,
                "speed_i2_kph": None,
                "speed_fl_kph": None,
                "speed_st_kph": 310.0,
                "compound": "MEDIUM",
                "stint": 1,
                "tyre_life": lap,
                "track_status": "41" if lap == 10 else "1",
                "deleted": False,
                "deleted_reason": None,
            }
        )
    return pa.Table.from_pylist(rows)


def _ti_stints() -> list[tuple[Any, ...]]:
    base = {"season": 2024, "round": 1, "is_synthetic": False, "source": "tracinginsights"}
    return [
        _row(
            TS.STINTS_TRACINGINSIGHTS,
            **base,
            driver_id="drv_a",
            driver_code="AAA",
            stint=1,
            start_lap=1,
            end_lap=6,
            laps=6,
            compound="SOFT",
            compound_conflict=False,
            tyre_age_at_start=2,
        ),
        _row(
            TS.STINTS_TRACINGINSIGHTS,
            **base,
            driver_id="drv_a",
            driver_code="AAA",
            stint=2,
            start_lap=7,
            end_lap=16,
            laps=10,
            compound="HARD",
            compound_conflict=False,
            tyre_age_at_start=0,
        ),
        _row(
            TS.STINTS_TRACINGINSIGHTS,
            **base,
            driver_id="drv_b",
            driver_code="XXX",
            stint=1,
            start_lap=1,
            end_lap=17,
            laps=17,
            compound=None,
            compound_conflict=True,
            tyre_age_at_start=0,
        ),
    ]


RC_MESSAGES: list[tuple[int, int, str, str | None, bool, bool, str | None, str]] = [
    # seq, lap, message, flag, is_red_flag, is_penalty, driver_id, expected kind
    (0, 3, "VIRTUAL SAFETY CAR DEPLOYED", None, False, False, None, "vsc_deployed"),
    (1, 4, "VIRTUAL SAFETY CAR ENDING", None, False, False, None, "vsc_ending"),
    (2, 10, "SAFETY CAR DEPLOYED", None, False, False, None, "sc_deployed"),
    (3, 11, "SAFETY CAR IN THIS LAP", None, False, False, None, "sc_ending"),
    (4, 12, "RED FLAG", "RED", True, False, None, "red_flag"),
    (
        5,
        13,
        "5 SECOND TIME PENALTY FOR CAR 1 (AAA) - SPEEDING",
        None,
        False,
        True,
        "drv_a",
        "penalty",
    ),
    (
        6,
        13,
        "CAR 2 (XXX) NOTED - UNDER INVESTIGATION",
        None,
        False,
        False,
        "drv_b",
        "investigation",
    ),
    (
        7,
        12,
        "CAR 1 (AAA) TIME 1:25.000 DELETED - TRACK LIMITS AT TURN 4",
        None,
        False,
        False,
        "drv_a",
        "track_limits",
    ),
    (8, 16, "CHEQUERED FLAG", "CHEQUERED", False, False, None, "chequered"),
    (9, 1, "DRS ENABLED", None, False, False, None, "other"),
]


def _race_control() -> list[tuple[Any, ...]]:
    return [
        _row(
            TS.RACE_CONTROL,
            season=2024,
            round=1,
            seq=seq,
            time_utc=datetime(2024, 3, 2, 15, 0, seq, tzinfo=UTC),
            lap=lap,
            category="Other",
            message=msg,
            flag=flag,
            is_sc_deployed=kind == "sc_deployed",
            is_vsc_deployed=kind == "vsc_deployed",
            is_red_flag=red,
            is_penalty=pen,
            driver_id=driver,
            source="tracinginsights",
        )
        for seq, lap, msg, flag, red, pen, driver, kind in RC_MESSAGES
    ]


def _periods() -> list[tuple[Any, ...]]:
    return [
        _row(
            TS.RACE_CONTROL_TRACK_STATUS,
            season=2024,
            round=1,
            seq=0,
            status="4",
            is_sc=True,
            is_vsc=False,
            is_vsc_ending=False,
            lap_from=10,
            lap_to=10,
        ),
        _row(
            TS.RACE_CONTROL_TRACK_STATUS,
            season=2024,
            round=1,
            seq=1,
            status="1",
            is_sc=False,
            is_vsc=False,
            is_vsc_ending=False,
            lap_from=11,
            lap_to=16,
        ),
    ]


def _write_lake(spark: SparkSession, base: Path) -> Settings:
    lake = base / "data" / "lake"
    root = f"file://{lake}/clean"
    drivers = [
        _row(S.DRIVERS, season=2024, round=r, driver_id=d, code=c, car_number=n, constructor_id="x")
        for r in (1, 2)
        for d, c, n in (("drv_a", "AAA", 1), ("drv_b", "BBB", 2))
    ]
    clean.write_table(spark.createDataFrame(drivers, S.DRIVERS), root, "drivers")
    clean.write_table(spark.createDataFrame(_v1_laps(), S.LAPS), root, "laps")
    pits = [
        _row(
            S.PITSTOPS,
            season=2024,
            round=1,
            driver_id="drv_a",
            stop=1,
            lap=6,
            time_of_day="15:10:00",
            duration_s=22.5,
            is_long_stop=False,
        )
    ]
    clean.write_table(spark.createDataFrame(pits, S.PITSTOPS), root, "pitstops")
    v1_stints = [
        # R1: Jolpica-inferred (never used: TI exists); R2: synthetic
        _row(S.STINTS, season=2024, round=1, driver_id="drv_a", stint=1, start_lap=1, end_lap=6,
             laps=6, compound=None, is_synthetic=False, source="jolpica_inferred"),
        _row(S.STINTS, season=2024, round=2, driver_id="drv_a", stint=1, start_lap=1, end_lap=5,
             laps=5, compound="MEDIUM", tyre_age_at_start=1, is_synthetic=True, source="synthetic"),
        _row(S.STINTS, season=2024, round=2, driver_id="drv_b", stint=1, start_lap=1, end_lap=5,
             laps=5, compound="HARD", tyre_age_at_start=0, is_synthetic=True, source="synthetic"),
    ]  # fmt: skip
    clean.write_table(spark.createDataFrame(v1_stints, S.STINTS), root, "stints")
    write_ti_table(
        spark.createDataFrame(_ti_stints(), TS.STINTS_TRACINGINSIGHTS),
        root,
        "stints_tracinginsights",
    )
    write_ti_table(spark.createDataFrame(_race_control(), TS.RACE_CONTROL), root, "race_control")
    write_ti_table(
        spark.createDataFrame(_periods(), TS.RACE_CONTROL_TRACK_STATUS),
        root,
        "race_control_track_status",
    )
    ti_dir = lake / "raw" / "tracinginsights" / "laps" / "season=2024" / "round=1"
    ti_dir.mkdir(parents=True)
    pq.write_table(_ti_laps(), ti_dir / "laps.parquet")
    return Settings(_env_file=None, data_lake_uri=f"file://{lake}")  # type: ignore[call-arg]


class Built:
    def __init__(self, base: Path, result: A.AnalysisResult, tables: dict[str, list[Any]]):
        self.base = base
        self.result = result
        self.tables = tables

    def laps(self, round_: int, driver: str) -> dict[int, Any]:
        return {
            r["lap"]: r
            for r in self.tables[AS.LAPS]
            if r["round"] == round_ and r["driver_id"] == driver
        }


def _run(spark: SparkSession, base: Path, settings: Settings, source: str) -> Built:
    cwd = os.getcwd()
    os.chdir(base)  # the output guard resolves ./data/lake against the working directory
    try:
        result = A.run_analysis(spark, settings, source=source)
    finally:
        os.chdir(cwd)
    root = f"{settings.data_lake_uri.rstrip('/')}/clean"
    tables = {t: A.read_analysis(spark, root, t).collect() for t in AS.TABLES}
    return Built(base, result, tables)


@pytest.fixture(scope="module")
def built(spark: SparkSession, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Built]:
    base = tmp_path_factory.mktemp("analysis")
    settings = _write_lake(spark, base)
    yield _run(spark, base, settings, "lake")


# ============================================================================== laps
def test_one_row_per_jolpica_lap_with_the_exact_schema(built: Built) -> None:
    laps = built.tables[AS.LAPS]
    assert len(laps) == 2 * LAPS_R1 + 2 * 5
    assert built.result.rows[AS.LAPS] == len(laps)
    assert list(laps[0].asDict()) == AS.ANALYSIS_LAPS.fieldNames()
    assert 17 not in built.laps(1, "drv_b")  # the TI-only lap is dropped
    assert built.result.report["ti_only_laps_dropped"] == 1
    assert built.result.report["ti_rows_unmapped"] == 0


def test_ti_fields_mapped_by_code_and_by_car_number(built: Built) -> None:
    a, b = built.laps(1, "drv_a"), built.laps(1, "drv_b")
    assert a[2]["driver_code"] == "AAA" and b[2]["driver_code"] == "BBB"
    assert a[1]["sector1_s"] is None and a[2]["sector1_s"] == 28.0
    assert b[5]["sector2_s"] == 31.0  # TI code XXX -> car 2 -> drv_b
    assert a[3]["speed_st_kph"] == 323.0 and b[3]["speed_fl_kph"] is None
    assert a[3]["lap_time_s"] == _a_time(3) and a[3]["position"] == 1


def test_tyres_from_tracinginsights_and_a_conflict_has_no_compound(built: Built) -> None:
    a, b = built.laps(1, "drv_a"), built.laps(1, "drv_b")
    assert (a[3]["stint"], a[3]["compound"], a[3]["tyre_life_laps"]) == (1, "SOFT", 5)
    assert (a[9]["stint"], a[9]["compound"], a[9]["tyre_life_laps"]) == (2, "HARD", 3)
    assert {r["compound_source"] for r in a.values()} == {"tracinginsights"}
    assert not any(r["is_synthetic"] for r in a.values())
    assert b[4]["compound"] is None and b[4]["stint"] == 1 and b[4]["tyre_life_laps"] == 4


def test_synthetic_tyres_without_tracinginsights(built: Built) -> None:
    a, b = built.laps(2, "drv_a"), built.laps(2, "drv_b")
    assert (a[1]["compound"], a[1]["tyre_life_laps"], a[5]["tyre_life_laps"]) == ("MEDIUM", 2, 6)
    assert (b[3]["compound"], b[3]["tyre_life_laps"]) == ("HARD", 3)
    assert {r["compound_source"] for r in [*a.values(), *b.values()]} == {"synthetic"}
    assert all(r["is_synthetic"] for r in a.values())


def test_neutralised_from_track_status_codes_or_the_heuristic(built: Built) -> None:
    a = built.laps(1, "drv_a")
    assert (a[10]["track_status"], a[10]["is_sc_lap"], a[10]["is_vsc_lap"]) == ("41", True, False)
    assert a[10]["is_neutralised_lap"] and a[10]["neutralised_source"] == "track_status"
    assert a[9]["is_neutralised_lap"] is False and a[9]["is_red_flag_lap"] is False
    r2 = built.laps(2, "drv_a")
    assert r2[3]["is_neutralised_lap"] and r2[3]["neutralised_source"] == "heuristic"
    assert r2[3]["is_sc_lap"] is None and r2[3]["track_status"] is None


def test_deleted_known_with_ti_and_unknown_without(built: Built) -> None:
    a = built.laps(1, "drv_a")
    assert a[12]["is_deleted"] is True and a[12]["deleted_reason"] == "TRACK LIMITS AT TURN 4"
    assert a[11]["is_deleted"] is False and a[11]["deleted_reason"] is None
    assert all(r["is_deleted"] is None for r in built.laps(2, "drv_a").values())


def test_quick_lap_reasons_in_priority_order(built: Built) -> None:
    a = built.laps(1, "drv_a")
    expected = {1: "lap_1", 6: "pit_in", 7: "pit_out", 10: "neutralised", 12: "deleted"}
    expected[14] = "slow_107"
    for lap, row in a.items():
        assert row["quick_lap_exclusion"] == expected.get(lap), lap
        assert row["is_quick_lap"] is (lap not in expected)
    assert built.laps(2, "drv_a")[3]["quick_lap_exclusion"] == "neutralised"
    assert set(built.result.report["quick_lap_exclusions"]) <= set(AS.QUICK_LAP_EXCLUSIONS)


# ============================================================================== stints
def test_stint_fit_is_the_known_line_and_short_stints_are_not_fitted(built: Built) -> None:
    st = {(r["driver_id"], r["stint"]): r for r in built.tables[AS.STINTS] if r["round"] == 1}
    s2 = st[("drv_a", 2)]
    assert s2["fit_status"] == "ok" and s2["n_quick_laps"] == 6
    assert s2["deg_slope_s_per_lap"] == pytest.approx(0.1)
    assert s2["deg_intercept_s"] == pytest.approx(85.0)
    assert s2["median_quick_lap_s"] == pytest.approx(85.6)
    assert (s2["tyre_life_start"], s2["tyre_life_end"], s2["used_set"]) == (1, 10, False)
    assert s2["ends_in_pit"] is False and s2["laps"] == 10
    s1 = st[("drv_a", 1)]
    assert s1["fit_status"] == "too_few_laps" and s1["n_quick_laps"] == 4
    assert s1["deg_slope_s_per_lap"] is None and s1["deg_intercept_s"] is None
    assert (s1["tyre_life_start"], s1["used_set"], s1["ends_in_pit"]) == (3, True, True)
    assert st[("drv_b", 1)]["compound"] is None
    assert {r["compound_source"] for r in built.tables[AS.STINTS] if r["round"] == 2} == {
        "synthetic"
    }


def test_fit_without_tyre_life_is_reported(spark: SparkSession) -> None:
    laps = spark.createDataFrame(
        [
            _row(AS.ANALYSIS_LAPS, season=2024, round=1, driver_id="d", lap=lap, stint=1,
                 lap_time_s=90.0 + lap, is_quick_lap=True, is_pit_in_lap=False)
            for lap in range(2, 9)
        ],
        AS.ANALYSIS_LAPS,
    )  # fmt: skip
    stints = spark.createDataFrame(
        [(2024, 1, "d", 1, 1, 8, None, None, "none", False)],
        "season int, round int, driver_id string, stint int, start_lap int, end_lap int, "
        "compound string, tyre_age_at_start int, compound_source string, is_synthetic boolean",
    )
    (row,) = A.build_stints(spark, laps, stints).collect()
    assert row["fit_status"] == "no_tyre_life" and row["n_quick_laps"] == 7


# ============================================================================== pit stops, rc
def test_pitstop_context(built: Built) -> None:
    (p,) = built.tables[AS.PITSTOPS]
    assert (p["driver_code"], p["stop"], p["lap"], p["duration_s"]) == ("AAA", 1, 6, 22.5)
    assert (p["compound_before"], p["compound_after"], p["tyre_life_before"]) == (
        "SOFT",
        "HARD",
        8,
    )
    assert (p["position_before"], p["position_after"], p["under_neutralisation"]) == (1, 1, False)


def test_race_control_kinds_and_key_events(built: Built) -> None:
    rc = {r["seq"]: r for r in built.tables[AS.RACE_CONTROL]}
    assert len(rc) == len(RC_MESSAGES)
    for seq, *_rest, kind in RC_MESSAGES:
        assert rc[seq]["kind"] == kind, seq
        assert rc[seq]["is_key"] is (kind in AS.KEY_RACE_CONTROL_KINDS)
    assert rc[5]["driver_code"] == "AAA" and rc[0]["driver_code"] is None
    assert rc[2]["time_utc"] == "2024-03-02T15:00:02.000Z"


def test_race_coverage_rows(built: Built) -> None:
    race = {r["round"]: r for r in built.tables[AS.RACE]}
    r1, r2 = race[1], race[2]
    assert (r1["n_drivers"], r1["n_laps"], r1["n_lap_rows"]) == (2, LAPS_R1, 2 * LAPS_R1)
    assert (r1["tyre_source"], r1["is_synthetic"], r1["neutralised_source"]) == (
        "tracinginsights",
        False,
        "track_status",
    )
    assert r1["has_sectors"] and r1["has_speed_traps"] and r1["deleted_known"]
    assert (r1["n_race_control"], r1["n_pitstops"], r1["n_ti_only_laps_dropped"]) == (10, 1, 1)
    assert (r2["tyre_source"], r2["is_synthetic"], r2["neutralised_source"]) == (
        "synthetic",
        True,
        "heuristic",
    )
    assert not (r2["has_sectors"] or r2["has_speed_traps"] or r2["deleted_known"])
    assert (r2["n_race_control"], r2["n_pitstops"], r2["n_ti_only_laps_dropped"]) == (0, 0, 0)
    assert r1["n_quick_laps"] == sum(
        1 for r in built.tables[AS.LAPS] if r["round"] == 1 and r["is_quick_lap"]
    )


def test_quality_report(built: Built) -> None:
    path = built.base / "data" / "lake" / "clean" / "_quality" / A.QUALITY_FILE
    rep = json.loads(path.read_text(encoding="utf-8"))
    assert rep["source"] == "lake" and rep["races"] == 2 and rep["seasons"] == [2024]
    cov = rep["coverage_by_season"]["2024"]
    assert cov["lap_rows"] == 42 and cov["sector1"] == 2 * LAPS_R1 - 1 and cov["deleted"] == 1
    assert cov["neutralised_track_status"] == 32 and cov["neutralised_heuristic"] == 10
    assert cov["deleted_known"] == 32 and cov["compound"] == LAPS_R1 + 10
    assert rep["races_by_tyre_source"] == {"synthetic": 1, "tracinginsights": 1}
    assert rep["stints_by_fit_status"]["ok"] >= 1
    assert rep["race_control_by_kind"]["penalty"] == 1
    assert rep["track_status_crosscheck"] == {
        "both": 1,
        "lap_codes_only": 0,
        "periods_only": 0,
        "leader_laps": LAPS_R1,
    }
    assert rep["rows"] == built.result.rows and set(rep["checksums"]) == set(AS.TABLES)


def test_rerun_is_idempotent(spark: SparkSession, built: Built) -> None:
    settings = Settings(_env_file=None, data_lake_uri=f"file://{built.base}/data/lake")  # type: ignore[call-arg]
    again = _run(spark, built.base, settings, "lake")
    assert again.result.checksums == built.result.checksums


# ============================================================================== pure helpers
def test_neutral_flags_from_codes(spark: SparkSession) -> None:
    from pyspark.sql import functions as F

    df = spark.createDataFrame([("1",), ("41",), ("671",), ("45",), ("2",)], "code string")
    rows = df.select("code", *[c.alias(n) for n, c in A.neutral_flags(F.col("code")).items()])
    got = {r["code"]: (r["_ts_sc"], r["_ts_vsc"], r["_ts_red"]) for r in rows.collect()}
    assert got == {
        "1": (False, False, False),
        "41": (True, False, False),
        "671": (False, True, False),
        "45": (True, False, True),
        "2": (False, False, False),
    }


def test_unknown_compound_fails(spark: SparkSession) -> None:
    df = spark.createDataFrame([("SOFT",), (None,), ("HYPERSOFT",)], "compound string")
    with pytest.raises(CleanError, match="HYPERSOFT"):
        A.check_compounds(df, "stints")
    A.check_compounds(df.where("compound <> 'HYPERSOFT' OR compound IS NULL"), "stints")


def test_duplicate_ti_lap_fails_instead_of_fanning_out(spark: SparkSession) -> None:
    raw = _ti_laps().to_pylist()
    rows = [
        (2024, 1, r["driver_code"], r["driver_number"], r["lap"], *[None] * 8, r["tyre_life"],
         r["track_status"], r["deleted"], None)
        for r in raw
    ]  # fmt: skip
    rows.append(rows[0])
    ti = spark.createDataFrame(rows, AS.RAW_TI_LAPS)
    drivers = spark.createDataFrame(
        [_row(S.DRIVERS, season=2024, round=1, driver_id="drv_a", code="AAA", car_number=1)],
        S.DRIVERS,
    )
    with pytest.raises(CleanError, match="fan out"):
        A.map_ti_laps(ti, drivers)


def test_missing_inputs_are_empty_and_no_laps_fails(spark: SparkSession, tmp_path: Path) -> None:
    lake = f"file://{tmp_path}/data/lake"
    assert A.read_ti_laps(spark, f"{lake}/raw").isEmpty()
    assert A.read_ti_table(spark, f"{lake}/clean", "race_control").isEmpty()
    assert A.read_analysis(spark, f"{lake}/clean", AS.LAPS).isEmpty()
    (tmp_path / "data" / "lake").mkdir(parents=True)
    settings = Settings(_env_file=None, data_lake_uri=lake)  # type: ignore[call-arg]
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        with pytest.raises(CleanError, match="no clean laps"):
            A.run_analysis(spark, settings, source="lake")
        with pytest.raises(CleanError, match="unknown source"):
            A.run_analysis(spark, settings, source="full")
    finally:
        os.chdir(cwd)


def test_sample_source_needs_a_file_lake(spark: SparkSession) -> None:
    settings = Settings(_env_file=None, data_lake_uri="hdfs://namenode:8020/f1")  # type: ignore[call-arg]
    with pytest.raises(CleanError, match="file:// lake"):
        A.run_analysis(spark, settings, source="sample")


def test_main_exit_codes(
    spark: SparkSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "data" / "lake").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{tmp_path}/data/lake")
    monkeypatch.setattr(A, "build_spark", lambda *_a, **_k: spark)
    monkeypatch.setattr(spark, "stop", lambda: None)
    assert A.main(["--source", "lake"]) == 1  # no clean laps
    with pytest.raises(SystemExit):
        A.main(["--source", "nope"])


# ============================================================================== real sample
@pytest.fixture(scope="module")
def sample_built(
    spark: SparkSession, sample_clean_lake: SampleLake, tmp_path_factory: pytest.TempPathFactory
) -> Built:
    base = tmp_path_factory.mktemp("analysis_sample")
    shutil.copytree(sample_clean_lake.lake / "clean", base / "data" / "lake" / "clean")
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        data_lake_uri=f"file://{base}/data/lake",
        sample_dir=sample_clean_lake.settings().sample_dir,
    )
    return _run(spark, base, settings, "sample")


def test_sample_bundle_is_synthetic_tyres_and_jolpica_laps(sample_built: Built) -> None:
    race = {(r["season"], r["round"]): r for r in sample_built.tables[AS.RACE]}
    assert set(race) == {(2023, 5), (2024, 5)}
    r = race[(2024, 5)]
    assert (r["n_lap_rows"], r["n_drivers"], r["n_laps"]) == (1030, 20, 56)
    assert (r["tyre_source"], r["is_synthetic"], r["neutralised_source"]) == (
        "synthetic",
        True,
        "heuristic",
    )
    assert not (r["has_sectors"] or r["has_speed_traps"] or r["deleted_known"])
    assert r["n_race_control"] == 0 and r["n_pitstops"] > 0
    laps = [x for x in sample_built.tables[AS.LAPS] if (x["season"], x["round"]) == (2024, 5)]
    assert all(x["is_synthetic"] and x["is_deleted"] is None for x in laps)
    neutral = {x["lap"] for x in laps if x["is_neutralised_lap"]}
    assert neutral == set(range(21, 32))  # the documented heuristic laps 21-31
    assert sample_built.tables[AS.RACE_CONTROL] == []
    assert sample_built.result.report["source"] == "sample"


def test_sample_pitstops_and_stints(sample_built: Built) -> None:
    pits = [p for p in sample_built.tables[AS.PITSTOPS] if p["season"] == 2024]
    assert pits and all(p["duration_s"] is not None for p in pits)
    stints = [s for s in sample_built.tables[AS.STINTS] if s["season"] == 2024]
    assert len(stints) == 60
    assert {s["fit_status"] for s in stints} <= set(AS.FIT_STATUSES)
    assert all(s["compound"] in TS.KNOWN_COMPOUNDS for s in stints)


def test_schema_module_is_outside_the_v1_and_ti_lists() -> None:
    assert not set(AS.TABLES) & set(S.CLEAN_SCHEMAS)
    assert not set(AS.TABLES) & set(TS.CLEAN_SCHEMAS_TI)
    assert all(t.startswith("analysis_") for t in AS.TABLES)
    assert set(AS.PRIMARY_KEYS) == set(AS.SCHEMAS)
    for table, keys in AS.PRIMARY_KEYS.items():
        assert set(keys) <= set(AS.SCHEMAS[table].fieldNames())
