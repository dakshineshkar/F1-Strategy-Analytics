"""Display-only post-race analysis tables (Feature 2): ``clean/analysis_*``.

    python -m f1sa.etl.analysis --source sample|lake [--seasons 2021-2025]   (make analysis-*)

Inputs, all read-only: the v1 clean ``laps`` (Jolpica; the base of every per-lap row), ``pitstops``
(Jolpica durations), ``drivers`` (codes) and ``stints``; the TracingInsights clean
``stints_tracinginsights`` and ``race_control``; and the as-received TracingInsights
``raw/tracinginsights/laps/season=S/round=R/laps.parquet`` (only the columns of
``schemas_analysis.RAW_TI_LAPS``). A missing TracingInsights input (the sample bundle has none) is
an empty frame, never an error. Output: the five ``clean/analysis_*`` tables (partitioned by
season and round, dynamic overwrite) and ``clean/_quality/analysis.json``. Nothing else reads these
tables except the API's ``/api/races/{s}/{r}/analysis/*``: no feature, model, rule, alert or stream.

Per-lap rules (``analysis_laps``):

* **Rows** are the Jolpica laps. TracingInsights rows are left-joined onto them (TI code -> the
  race's ``drivers.code``, else the car number: ``clean_tracinginsights.driver_map``), so a TI lap
  that Jolpica does not have (an uncompleted lap) is dropped and counted; a duplicate TI lap
  (fan-out) fails the job.
* **Tyres:** a race with TracingInsights stints uses them (``compound_source =
  tracinginsights``; the stint covering the lap; a conflicting stint has no compound) and the
  real per-lap TI ``tyre_life``. Otherwise a race whose v1 stints are synthetic (the sample) uses
  those, with ``tyre_life_laps = tyre_age_at_start + lap - start_lap + 1`` and ``is_synthetic =
  true``. Otherwise there is no tyre data (``none``); Jolpica-inferred stints are never used.
* **Neutralised:** the TI per-lap ``track_status`` codes (the race-control track-status feed over
  the lap): 4 = SC, 6 or 7 = VSC, 5 = red flag (``neutralised_source = track_status``). A lap
  without a TI status uses the v1 Jolpica heuristic (``heuristic``; SC and VSC unknown there).
  ``is_neutralised_lap`` = SC or VSC, as in v1; the red flag is its own column.
* **Deleted:** TI ``deleted`` / ``deleted_reason``; null (unknown) without TI, never false.
* **Quick laps** for the degradation proxy: the first reason that applies is stored in
  ``quick_lap_exclusion`` (``schemas_analysis.QUICK_LAP_EXCLUSIONS``): no lap time, lap 1, pit-in
  lap, pit-out lap, SC/VSC/red flag, deleted, then slower than 1.07 x the fastest lap of the same
  driver and stint that passed every earlier test (the FastF1 ``pick_quicklaps`` convention, per
  stint so that a wet stint is not measured against a dry one).

``analysis_stints`` fits ``lap_time_s ~ tyre_life_laps`` over each stint's quick laps with Spark
SQL ``regr_slope``/``regr_intercept`` (at least 5 laps). It is a lap-time proxy, not tyre wear:
fuel burn-off and track evolution are in it. ``analysis_pitstops`` adds the compounds, tyre life
and positions around each Jolpica stop, ``analysis_race_control`` classifies every race-control
message (``kind``; SC/VSC/red flag/penalty are ``is_key``) and ``analysis_race`` records the
coverage of each race. The job fails (exit 1) on a duplicate key, a fan-out, a compound outside the
known five, or no clean laps.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pyspark.errors import AnalysisException
from pyspark.sql import Column, DataFrame, SparkSession, Window
from pyspark.sql import functions as F

from f1sa.config import Settings, get_settings
from f1sa.etl.clean import (
    CleanError,
    check_output_root,
    conform,
    empty,
    read_clean,
    read_parquet_table,
    select_races,
    spark_uri,
    table_checksum,
    write_text,
)
from f1sa.etl.clean_tracinginsights import driver_map
from f1sa.etl.io import sample_races, write_partitioned
from f1sa.etl.spark import build_spark
from f1sa.lake import schemas_analysis as AS
from f1sa.lake import schemas_tracinginsights as TS

QUALITY_FILE = "analysis.json"
SOURCES = ("sample", "lake")
_RACE = ["season", "round"]
_DRIVER_LAP = ["season", "round", "driver_id", "lap"]
_KNOWN = list(TS.KNOWN_COMPOUNDS)


def _glob(seasons: Sequence[int] | None) -> str:
    return "*" if not seasons else "{" + ",".join(str(s) for s in sorted(seasons)) + "}"


# ============================================================================== inputs
def read_ti_laps(
    spark: SparkSession, raw_root: str, seasons: Sequence[int] | None = None
) -> DataFrame:
    """The analysis columns of the raw TI ``laps.parquet`` files; empty if none exist."""
    pattern = f"{raw_root}/tracinginsights/laps/season={_glob(seasons)}/round=*/laps.parquet"
    return read_parquet_table(spark, pattern, AS.RAW_TI_LAPS, "TI laps")


def read_ti_table(spark: SparkSession, clean_root: str, table: str) -> DataFrame:
    """A TracingInsights clean table as stored, or empty if it was never written."""
    schema = TS.CLEAN_SCHEMAS_TI[table]
    try:
        df = spark.read.schema(schema).parquet(f"{clean_root}/{table}")
    except AnalysisException as exc:
        if "PATH_NOT_FOUND" in str(exc) or "does not exist" in str(exc):
            return empty(spark, schema)
        raise
    return df.select(schema.fieldNames())


def read_analysis(spark: SparkSession, clean_root: str, table: str) -> DataFrame:
    """A stored ``clean/analysis_*`` table (partition columns restored), or empty."""
    schema = AS.SCHEMAS[table]
    try:
        df = spark.read.schema(schema).parquet(f"{clean_root}/{table}")
    except AnalysisException as exc:
        if "PATH_NOT_FOUND" in str(exc) or "does not exist" in str(exc):
            return empty(spark, schema)
        raise
    return df.select(schema.fieldNames())


@dataclass
class Inputs:
    laps: DataFrame
    pitstops: DataFrame
    drivers: DataFrame
    stints: DataFrame
    ti_laps: DataFrame
    ti_stints: DataFrame
    race_control: DataFrame


# ============================================================================== helpers
def check_compounds(df: DataFrame, what: str) -> None:
    """Fail on a compound outside the known five (null is allowed: unknown)."""
    bad = (
        df.where(F.col("compound").isNotNull() & ~F.col("compound").isin(_KNOWN))
        .select("compound")
        .distinct()
        .limit(5)
        .collect()
    )
    if bad:
        raise CleanError(f"{what}: unknown compounds {sorted(r['compound'] for r in bad)}")


def _ti_compound(col: str) -> Column:
    """Upper-cased, trimmed TI compound; ``UNKNOWN``, ``None`` and anything else become null."""
    c = F.upper(F.trim(F.col(col)))
    return F.when(c.isin(_KNOWN), c)


def map_ti_laps(ti_laps: DataFrame, drivers: DataFrame) -> tuple[DataFrame, int]:
    """TI lap rows keyed by (season, round, driver_id, lap) and the number of unmapped TI rows.

    Fails if a mapped (driver, lap) occurs twice, which would fan out the Jolpica laps."""
    mapping = driver_map(ti_laps, drivers)
    mapped = ti_laps.join(mapping, [*_RACE, "driver_code"], "left")
    unmapped = mapped.where(F.col("driver_id").isNull()).count()
    rows = mapped.where(F.col("driver_id").isNotNull()).select(
        *_RACE,
        "driver_id",
        F.col("lap").cast("int").alias("lap"),
        *[
            F.col(c).alias(f"ti_{c}")
            for c in (
                "lap_time_s",
                "sector1_s",
                "sector2_s",
                "sector3_s",
                "speed_i1_kph",
                "speed_i2_kph",
                "speed_fl_kph",
                "speed_st_kph",
                "deleted",
                "deleted_reason",
            )
        ],
        F.col("tyre_life").cast("int").alias("ti_tyre_life"),
        F.trim(F.col("track_status")).alias("ti_track_status"),
    )
    dups = rows.groupBy(*_DRIVER_LAP).count().where(F.col("count") > 1).count()
    if dups:
        raise CleanError(f"TI laps: {dups} duplicate (driver, lap) rows would fan out the laps")
    return rows, unmapped


def tyre_stints(ti_stints: DataFrame, stints: DataFrame) -> DataFrame:
    """One stint table for the analysis: TI stints per race, else synthetic v1 stints.

    Columns: season, round, driver_id, stint, start_lap, end_lap, compound, tyre_age_at_start,
    compound_source, is_synthetic."""
    ti = ti_stints.select(
        *_RACE,
        "driver_id",
        "stint",
        "start_lap",
        "end_lap",
        F.when(~F.coalesce("compound_conflict", F.lit(False)), _ti_compound("compound")).alias(
            "compound"
        ),
        "tyre_age_at_start",
        F.lit("tracinginsights").alias("compound_source"),
        F.lit(False).alias("is_synthetic"),
    )
    ti_races = ti.select(*_RACE).distinct()
    synthetic = (
        stints.where(F.coalesce("is_synthetic", F.lit(False)))
        .join(ti_races, _RACE, "left_anti")
        .select(
            *_RACE,
            "driver_id",
            "stint",
            "start_lap",
            "end_lap",
            F.upper(F.trim(F.col("compound"))).alias("compound"),
            "tyre_age_at_start",
            F.lit("synthetic").alias("compound_source"),
            F.lit(True).alias("is_synthetic"),
        )
    )
    out = ti.unionByName(synthetic)
    check_compounds(out, "stints")
    return out


def _attach_stints(laps: DataFrame, stints: DataFrame) -> DataFrame:
    """The stint covering each lap (start_lap <= lap <= end_lap); fails on overlapping stints."""
    s = stints.select(
        F.col("season").alias("_s_season"),
        F.col("round").alias("_s_round"),
        F.col("driver_id").alias("_s_driver_id"),
        F.col("stint"),
        F.col("start_lap").alias("_start_lap"),
        F.col("end_lap").alias("_end_lap"),
        F.col("compound"),
        F.col("tyre_age_at_start").alias("_age0"),
        F.col("compound_source").alias("_csrc"),
        F.col("is_synthetic").alias("_synthetic"),
    )
    cond = (
        (F.col("season") == F.col("_s_season"))
        & (F.col("round") == F.col("_s_round"))
        & (F.col("driver_id") == F.col("_s_driver_id"))
        & F.col("lap").between(F.col("_start_lap"), F.col("_end_lap"))
    )
    return laps.join(s, cond, "left")


def neutral_flags(code: Column) -> dict[str, Column]:
    """SC / VSC / red-flag flags from a TI track-status code string (digits concatenated)."""
    return {
        "_ts_sc": code.contains("4"),
        "_ts_vsc": code.contains("6") | code.contains("7"),
        "_ts_red": code.contains("5"),
    }


def quick_lap_exclusion() -> Column:
    """The first reason that applies (before the 107% test, which needs a window)."""
    return (
        F.when(F.col("lap_time_s").isNull(), F.lit("no_time"))
        .when(F.col("lap") == 1, F.lit("lap_1"))
        .when(F.coalesce("is_pit_in_lap", F.lit(False)), F.lit("pit_in"))
        .when(F.coalesce("is_pit_out_lap", F.lit(False)), F.lit("pit_out"))
        .when(
            F.coalesce("is_neutralised_lap", F.lit(False))
            | F.coalesce("is_red_flag_lap", F.lit(False)),
            F.lit("neutralised"),
        )
        .when(F.coalesce("is_deleted", F.lit(False)), F.lit("deleted"))
    )


# ============================================================================== builders
def build_laps(inp: Inputs) -> tuple[DataFrame, dict[str, int]]:
    """``analysis_laps`` plus counts (TI rows unmapped / dropped)."""
    ti, unmapped = map_ti_laps(inp.ti_laps, inp.drivers)
    ti = ti.cache()
    base = inp.laps
    codes = inp.drivers.select(*_RACE, "driver_id", F.col("code").alias("driver_code"))
    joined = base.join(ti, _DRIVER_LAP, "left").join(codes, [*_RACE, "driver_id"], "left")
    ti_only = ti.join(base.select(*_DRIVER_LAP), _DRIVER_LAP, "left_anti").count()
    stints = tyre_stints(inp.ti_stints, inp.stints)
    with_stint = _attach_stints(joined, stints)
    ts = F.col("ti_track_status")
    has_ts = ts.isNotNull() & (ts != "")
    flags = neutral_flags(F.coalesce(ts, F.lit("")))
    age_formula = F.coalesce(F.col("_age0"), F.lit(0)) + F.col("lap") - F.col("_start_lap") + 1
    df = (
        with_stint.withColumns(flags)
        .withColumns(
            {
                "sector1_s": F.col("ti_sector1_s"),
                "sector2_s": F.col("ti_sector2_s"),
                "sector3_s": F.col("ti_sector3_s"),
                "speed_i1_kph": F.col("ti_speed_i1_kph"),
                "speed_i2_kph": F.col("ti_speed_i2_kph"),
                "speed_fl_kph": F.col("ti_speed_fl_kph"),
                "speed_st_kph": F.col("ti_speed_st_kph"),
                "tyre_life_laps": F.when(
                    F.col("_csrc") == "tracinginsights", F.col("ti_tyre_life")
                ).when(F.col("_csrc") == "synthetic", age_formula.cast("int")),
                "compound_source": F.coalesce(F.col("_csrc"), F.lit("none")),
                "is_synthetic": F.coalesce(F.col("_synthetic"), F.lit(False)),
                "is_deleted": F.col("ti_deleted"),
                "deleted_reason": F.when(
                    F.coalesce("ti_deleted", F.lit(False)), F.col("ti_deleted_reason")
                ),
                "track_status": F.when(has_ts, ts),
                "is_sc_lap": F.when(has_ts, F.col("_ts_sc")).otherwise(F.col("is_sc_lap")),
                "is_vsc_lap": F.when(has_ts, F.col("_ts_vsc")).otherwise(F.col("is_vsc_lap")),
                "is_red_flag_lap": F.when(has_ts, F.col("_ts_red")).otherwise(
                    F.col("is_red_flag_lap")
                ),
                "is_neutralised_lap": F.when(has_ts, F.col("_ts_sc") | F.col("_ts_vsc")).otherwise(
                    F.col("is_neutralised_lap")
                ),
                "neutralised_source": F.when(
                    has_ts | (F.col("track_status_source") == "fastf1"), F.lit("track_status")
                ).otherwise(F.lit("heuristic")),
            }
        )
        .withColumn("_excl", quick_lap_exclusion())
    )
    w = Window.partitionBy(*_RACE, "driver_id", "stint")
    fastest = F.min(F.when(F.col("_excl").isNull(), F.col("lap_time_s"))).over(w)
    slow = F.col("lap_time_s") > fastest * F.lit(AS.QUICK_LAP_FACTOR)
    df = df.withColumn(
        "quick_lap_exclusion",
        F.when(F.col("_excl").isNotNull(), F.col("_excl")).when(slow, F.lit("slow_107")),
    ).withColumn("is_quick_lap", F.col("quick_lap_exclusion").isNull())
    out = conform(df, AS.ANALYSIS_LAPS, AS.LAPS)
    ti.unpersist()
    return out, {"ti_rows_unmapped": unmapped, "ti_only_laps_dropped": ti_only}


def build_stints(spark: SparkSession, laps: DataFrame, stints: DataFrame) -> DataFrame:
    """``analysis_stints``: the stint table plus a Spark SQL fit over each stint's quick laps."""
    view = "_f1sa_analysis_quick_laps"
    laps.createOrReplaceTempView(view)
    fits = spark.sql(
        f"""
        SELECT season, round, driver_id, stint,
               CAST(count_if(is_quick_lap) AS INT) AS n_quick_laps,
               CAST(regr_count(CASE WHEN is_quick_lap THEN lap_time_s END,
                               CASE WHEN is_quick_lap THEN tyre_life_laps END) AS INT) AS n_fit,
               regr_slope(CASE WHEN is_quick_lap THEN lap_time_s END,
                          CASE WHEN is_quick_lap THEN tyre_life_laps END) AS slope,
               regr_intercept(CASE WHEN is_quick_lap THEN lap_time_s END,
                              CASE WHEN is_quick_lap THEN tyre_life_laps END) AS intercept,
               percentile(CASE WHEN is_quick_lap THEN lap_time_s END, 0.5) AS median_quick,
               first(driver_code, true) AS driver_code
        FROM {view}
        WHERE stint IS NOT NULL
        GROUP BY season, round, driver_id, stint
        """
    )
    spark.catalog.dropTempView(view)
    pits = laps.where(F.col("is_pit_in_lap")).select(
        *_RACE, "driver_id", F.col("lap").alias("end_lap"), F.lit(True).alias("_pit")
    )
    ok = (F.col("n_fit") >= AS.MIN_FIT_LAPS) & F.col("slope").isNotNull()
    df = (
        stints.join(fits, [*_RACE, "driver_id", "stint"], "left")
        .join(pits, [*_RACE, "driver_id", "end_lap"], "left")
        .withColumns(
            {
                "laps": F.col("end_lap") - F.col("start_lap") + 1,
                "tyre_life_start": F.col("tyre_age_at_start") + 1,
                "tyre_life_end": F.col("tyre_age_at_start")
                + F.col("end_lap")
                - F.col("start_lap")
                + 1,
                "used_set": F.col("tyre_age_at_start") > 0,
                "ends_in_pit": F.coalesce("_pit", F.lit(False)),
                "n_quick_laps": F.coalesce("n_quick_laps", F.lit(0)),
                "deg_slope_s_per_lap": F.when(ok, F.round("slope", 4)),
                "deg_intercept_s": F.when(ok, F.round("intercept", 3)),
                "median_quick_lap_s": F.round("median_quick", 3),
                "fit_status": F.when(ok, F.lit("ok"))
                .when(
                    F.coalesce("n_quick_laps", F.lit(0)) >= AS.MIN_FIT_LAPS, F.lit("no_tyre_life")
                )
                .otherwise(F.lit("too_few_laps")),
            }
        )
    )
    return conform(df, AS.ANALYSIS_STINTS, AS.STINTS)


def build_pitstops(laps: DataFrame, pitstops: DataFrame) -> DataFrame:
    """``analysis_pitstops``: Jolpica stops with the in-lap and out-lap context."""
    before = laps.select(
        *_RACE,
        "driver_id",
        "lap",
        "driver_code",
        F.col("compound").alias("compound_before"),
        F.col("tyre_life_laps").alias("tyre_life_before"),
        F.col("position").alias("position_before"),
        (
            F.coalesce("is_neutralised_lap", F.lit(False))
            | F.coalesce("is_red_flag_lap", F.lit(False))
        ).alias("under_neutralisation"),
    )
    after = laps.select(
        *_RACE,
        "driver_id",
        (F.col("lap") - 1).alias("lap"),
        F.col("compound").alias("compound_after"),
        F.col("position").alias("position_after"),
    )
    df = pitstops.join(before, _DRIVER_LAP, "left").join(after, _DRIVER_LAP, "left")
    return conform(df, AS.ANALYSIS_PITSTOPS, AS.PITSTOPS)


_KIND_SQL = """
CASE
  WHEN msg RLIKE 'VIRTUAL SAFETY CAR DEPLOYED' THEN 'vsc_deployed'
  WHEN msg RLIKE 'VIRTUAL SAFETY CAR ENDING' THEN 'vsc_ending'
  WHEN msg RLIKE '(?<!VIRTUAL )SAFETY CAR DEPLOYED' THEN 'sc_deployed'
  WHEN msg RLIKE '(?<!VIRTUAL )SAFETY CAR IN THIS LAP' THEN 'sc_ending'
  WHEN coalesce(is_red_flag, false) THEN 'red_flag'
  WHEN coalesce(is_penalty, false) THEN 'penalty'
  WHEN msg RLIKE 'UNDER INVESTIGATION' THEN 'investigation'
  WHEN msg RLIKE 'DELETED' THEN 'track_limits'
  WHEN upper(coalesce(flag, '')) = 'CHEQUERED' THEN 'chequered'
  ELSE 'other'
END
"""


def build_race_control(spark: SparkSession, rc: DataFrame, drivers: DataFrame) -> DataFrame:
    """``analysis_race_control``: every message with a Spark SQL ``kind``."""
    view = "_f1sa_analysis_rc"
    rc.withColumn("msg", F.upper(F.coalesce(F.col("message"), F.lit("")))).createOrReplaceTempView(
        view
    )
    keys = ", ".join(f"'{k}'" for k in AS.KEY_RACE_CONTROL_KINDS)
    classified = spark.sql(
        f"""
        SELECT *, kind IN ({keys}) AS is_key
        FROM (SELECT *, {_KIND_SQL} AS kind,
                     date_format(time_utc, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") AS time_text
              FROM {view})
        """
    )
    spark.catalog.dropTempView(view)
    codes = drivers.select(*_RACE, "driver_id", F.col("code").alias("driver_code"))
    df = (
        classified.drop("time_utc")
        .withColumnRenamed("time_text", "time_utc")
        .join(codes, [*_RACE, "driver_id"], "left")
    )
    return conform(df, AS.ANALYSIS_RACE_CONTROL, AS.RACE_CONTROL)


def build_race(
    laps: DataFrame, pitstops: DataFrame, race_control: DataFrame, dropped: DataFrame
) -> DataFrame:
    """``analysis_race``: one coverage row per race."""
    sources = F.collect_set("neutralised_source")
    per = laps.groupBy(*_RACE).agg(
        F.countDistinct("driver_id").cast("int").alias("n_drivers"),
        F.max("lap").cast("int").alias("n_laps"),
        F.count(F.lit(1)).cast("int").alias("n_lap_rows"),
        F.max(F.when(F.col("compound_source") == "tracinginsights", 2)).alias("_ti"),
        F.max(F.when(F.col("compound_source") == "synthetic", 1)).alias("_syn"),
        F.max(F.col("sector2_s").isNotNull().cast("int")).alias("_sec"),
        F.max(F.col("speed_st_kph").isNotNull().cast("int")).alias("_spd"),
        F.max(F.col("is_deleted").isNotNull().cast("int")).alias("_del"),
        sources.alias("_ns"),
        F.sum(F.col("is_quick_lap").cast("int")).cast("int").alias("n_quick_laps"),
    )
    rc = race_control.groupBy(*_RACE).agg(F.count(F.lit(1)).cast("int").alias("n_race_control"))
    ps = pitstops.groupBy(*_RACE).agg(F.count(F.lit(1)).cast("int").alias("n_pitstops"))
    df = (
        per.join(rc, _RACE, "left")
        .join(ps, _RACE, "left")
        .join(dropped, _RACE, "left")
        .withColumns(
            {
                "tyre_source": F.when(F.col("_ti").isNotNull(), F.lit("tracinginsights"))
                .when(F.col("_syn").isNotNull(), F.lit("synthetic"))
                .otherwise(F.lit("none")),
                "is_synthetic": F.col("_ti").isNull() & F.col("_syn").isNotNull(),
                "has_sectors": F.col("_sec") == 1,
                "has_speed_traps": F.col("_spd") == 1,
                "deleted_known": F.col("_del") == 1,
                "neutralised_source": F.when(F.size("_ns") > 1, F.lit("mixed")).otherwise(
                    F.element_at("_ns", 1)
                ),
                "n_race_control": F.coalesce("n_race_control", F.lit(0)),
                "n_pitstops": F.coalesce("n_pitstops", F.lit(0)),
                "n_ti_only_laps_dropped": F.coalesce("n_ti_only_laps_dropped", F.lit(0)),
            }
        )
    )
    return conform(df, AS.ANALYSIS_RACE, AS.RACE)


def ti_only_per_race(ti_laps: DataFrame, drivers: DataFrame, laps: DataFrame) -> DataFrame:
    """(season, round, n_ti_only_laps_dropped): mapped TI laps with no Jolpica lap."""
    mapping = driver_map(ti_laps, drivers)
    ti = ti_laps.join(mapping, [*_RACE, "driver_code"], "inner").select(
        *_RACE, "driver_id", F.col("lap").cast("int").alias("lap")
    )
    return (
        ti.join(laps.select(*_DRIVER_LAP), _DRIVER_LAP, "left_anti")
        .groupBy(*_RACE)
        .agg(F.count(F.lit(1)).cast("int").alias("n_ti_only_laps_dropped"))
    )


@dataclass
class Built:
    tables: dict[str, DataFrame]
    counts: dict[str, int]


def build_analysis(spark: SparkSession, inp: Inputs) -> Built:
    """All five tables from the inputs (no I/O)."""
    laps, counts = build_laps(inp)
    laps = laps.cache()
    if laps.count() != inp.laps.count():
        raise CleanError("analysis_laps: the TI join changed the Jolpica lap count (fan-out)")
    stints = tyre_stints(inp.ti_stints, inp.stints).join(
        inp.laps.select(*_RACE).distinct(), _RACE, "left_semi"
    )
    tables = {
        AS.LAPS: laps,
        AS.STINTS: build_stints(spark, laps, stints),
        AS.PITSTOPS: build_pitstops(laps, inp.pitstops),
        AS.RACE_CONTROL: build_race_control(spark, inp.race_control, inp.drivers),
    }
    dropped = ti_only_per_race(inp.ti_laps, inp.drivers, inp.laps)
    tables[AS.RACE] = build_race(laps, tables[AS.PITSTOPS], tables[AS.RACE_CONTROL], dropped)
    return Built(tables=tables, counts=counts)


# ============================================================================== quality
_COVERAGE_FIELDS = (
    "lap_rows",
    "lap_time",
    "sector1",
    "sector2",
    "sector3",
    "speed_trap",
    "deleted_known",
    "deleted",
    "tyre_life",
    "compound",
    "quick",
    "neutralised_track_status",
    "neutralised_heuristic",
)


def coverage_by_season(laps: DataFrame) -> dict[str, dict[str, int]]:
    """Per-season counts of present fields, with the RDD API (``map`` -> ``reduceByKey``)."""

    def row_counts(r: Any) -> tuple[int, tuple[int, ...]]:
        vals = (
            1,
            int(r["lap_time_s"] is not None),
            int(r["sector1_s"] is not None),
            int(r["sector2_s"] is not None),
            int(r["sector3_s"] is not None),
            int(r["speed_st_kph"] is not None),
            int(r["is_deleted"] is not None),
            int(bool(r["is_deleted"])),
            int(r["tyre_life_laps"] is not None),
            int(r["compound"] is not None),
            int(bool(r["is_quick_lap"])),
            int(r["neutralised_source"] == "track_status"),
            int(r["neutralised_source"] == "heuristic"),
        )
        return int(r["season"]), vals

    cols = [
        "season",
        "lap_time_s",
        "sector1_s",
        "sector2_s",
        "sector3_s",
        "speed_st_kph",
        "is_deleted",
        "tyre_life_laps",
        "compound",
        "is_quick_lap",
        "neutralised_source",
    ]
    totals = (
        laps.select(*cols)
        .rdd.map(row_counts)
        .reduceByKey(lambda a, b: tuple(x + y for x, y in zip(a, b, strict=True)))
        .collect()
    )
    return {
        str(season): dict(zip(_COVERAGE_FIELDS, vals, strict=True))
        for season, vals in sorted(totals)
    }


def _count_by(df: DataFrame, col: str) -> dict[str, int]:
    rows = df.groupBy(col).count().collect()
    return {str(r[col]): int(r["count"]) for r in sorted(rows, key=lambda r: str(r[col]))}


def track_status_crosscheck(laps: DataFrame, periods: DataFrame) -> dict[str, int]:
    """Leader laps flagged SC/VSC by the per-lap codes vs by the track-status periods.

    Periods are ``race_control_track_status`` rows with SC, VSC or VSC-ending and known
    ``lap_from``/``lap_to`` (leader laps); only races with per-lap codes are compared."""
    leader = laps.where(
        (F.col("position") == 1) & (F.col("neutralised_source") == "track_status")
    ).select(*_RACE, "lap", F.col("is_neutralised_lap").alias("by_lap"))
    neutral = periods.where(
        (F.col("is_sc") | F.col("is_vsc") | F.col("is_vsc_ending"))
        & F.col("lap_from").isNotNull()
        & F.col("lap_to").isNotNull()
    )
    expanded = neutral.select(
        *_RACE, F.explode(F.sequence("lap_from", "lap_to")).alias("lap")
    ).distinct()
    j = leader.join(expanded.withColumn("by_period", F.lit(True)), [*_RACE, "lap"], "left")
    by_period = F.coalesce("by_period", F.lit(False))
    row = j.agg(
        F.sum((F.col("by_lap") & by_period).cast("int")).alias("both"),
        F.sum((F.col("by_lap") & ~by_period).cast("int")).alias("lap_codes_only"),
        F.sum((~F.col("by_lap") & by_period).cast("int")).alias("periods_only"),
        F.count(F.lit(1)).alias("leader_laps"),
    ).first()
    return {
        k: int(row[k] or 0) if row else 0
        for k in ("both", "lap_codes_only", "periods_only", "leader_laps")
    }


def build_report(
    stored: dict[str, DataFrame], counts: dict[str, int], periods: DataFrame
) -> dict[str, Any]:
    laps, race = stored[AS.LAPS], stored[AS.RACE]
    races = sorted((int(r["season"]), int(r["round"])) for r in race.select(*_RACE).collect())
    return {
        "races": len(races),
        "seasons": sorted({s for s, _ in races}),
        "coverage_by_season": coverage_by_season(laps),
        "quick_lap_exclusions": _count_by(
            laps.where(F.col("quick_lap_exclusion").isNotNull()), "quick_lap_exclusion"
        ),
        "races_by_tyre_source": _count_by(race, "tyre_source"),
        "races_by_neutralised_source": _count_by(race, "neutralised_source"),
        "stints_by_fit_status": _count_by(stored[AS.STINTS], "fit_status"),
        "race_control_by_kind": _count_by(stored[AS.RACE_CONTROL], "kind"),
        "track_status_crosscheck": track_status_crosscheck(laps, periods),
        "ti_rows_unmapped": counts["ti_rows_unmapped"],
        "ti_only_laps_dropped": counts["ti_only_laps_dropped"],
    }


# ============================================================================== job
@dataclass
class AnalysisResult:
    rows: dict[str, int] = field(default_factory=dict)
    checksums: dict[str, str] = field(default_factory=dict)
    races: int = 0
    report: dict[str, Any] = field(default_factory=dict)


def _duplicates(df: DataFrame, table: str) -> int:
    keys = list(AS.PRIMARY_KEYS[table])
    return df.groupBy(*keys).count().where(F.col("count") > 1).count()


def _select(
    df: DataFrame, seasons: Sequence[int] | None, races: set[tuple[int, int]] | None
) -> DataFrame:
    return select_races(df, seasons, races)


def load_inputs(
    spark: SparkSession,
    lake: str,
    seasons: Sequence[int] | None,
    races: set[tuple[int, int]] | None,
) -> Inputs:
    raw_root, clean_root = f"{lake}/raw", f"{lake}/clean"
    laps = _select(read_clean(spark, clean_root, "laps"), seasons, races)
    if laps.isEmpty():
        raise CleanError(f"no clean laps under {clean_root}; run the clean job first")

    def ti(table: str) -> DataFrame:
        return _select(read_ti_table(spark, clean_root, table), seasons, races)

    return Inputs(
        laps=laps,
        pitstops=_select(read_clean(spark, clean_root, "pitstops"), seasons, races),
        drivers=_select(read_clean(spark, clean_root, "drivers"), seasons, races),
        stints=_select(read_clean(spark, clean_root, "stints"), seasons, races),
        ti_laps=_select(read_ti_laps(spark, raw_root, seasons), seasons, races),
        ti_stints=ti("stints_tracinginsights"),
        race_control=ti("race_control"),
    )


def run_analysis(
    spark: SparkSession,
    settings: Settings,
    *,
    source: str,
    seasons: Sequence[int] | None = None,
) -> AnalysisResult:
    if source not in SOURCES:
        raise CleanError(f"unknown source {source!r}")
    lake = spark_uri(settings.data_lake_uri)
    clean_root = f"{lake}/clean"
    check_output_root(clean_root)
    races: set[tuple[int, int]] | None = None
    if source == "sample":
        if not lake.startswith("file://"):
            raise CleanError("--source sample needs a file:// lake (DATA_LAKE_URI)")
        races = set(sample_races(settings))
    inp = load_inputs(spark, lake, seasons, races)
    built = build_analysis(spark, inp)
    for table, df in built.tables.items():
        dups = _duplicates(df, table)
        if dups:
            raise CleanError(f"{table}: {dups} duplicate primary keys")
    race_keys = inp.laps.select(*_RACE).distinct().cache()
    for table in AS.TABLES:
        write_partitioned(built.tables[table], clean_root, table, AS.PRIMARY_KEYS[table])
    built.tables[AS.LAPS].unpersist()
    stored = {
        t: read_analysis(spark, clean_root, t).join(race_keys, _RACE, "left_semi").cache()
        for t in AS.TABLES
    }
    periods = _select(read_ti_table(spark, clean_root, "race_control_track_status"), seasons, races)
    result = AnalysisResult(
        rows={t: df.count() for t, df in stored.items()},
        checksums={t: table_checksum(df) for t, df in stored.items()},
        races=race_keys.count(),
        report=build_report(stored, built.counts, periods),
    )
    result.report.update({"source": source, "rows": result.rows, "checksums": result.checksums})
    write_text(
        spark,
        f"{clean_root}/_quality/{QUALITY_FILE}",
        json.dumps(result.report, indent=1, sort_keys=True) + "\n",
    )
    for df in (*stored.values(), race_keys):
        df.unpersist()
    return result


def main(argv: Iterable[str] | None = None) -> int:
    from f1sa.ingest.cli import parse_seasons

    parser = argparse.ArgumentParser(prog="python -m f1sa.etl.analysis")
    parser.add_argument("--source", choices=SOURCES, required=True)
    parser.add_argument("--seasons", type=parse_seasons, default=None)
    parser.add_argument("--master", default="local[2]")
    args = parser.parse_args(list(argv) if argv is not None else None)
    settings = get_settings()
    try:
        lake = spark_uri(settings.data_lake_uri)
    except CleanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    local_dir = None
    if lake.startswith("file://"):
        local_dir = Path(lake.removeprefix("file://")) / ".spark-tmp"
    spark = build_spark("f1sa-analysis", args.master, local_dir=local_dir)
    try:
        result = run_analysis(spark, settings, source=args.source, seasons=args.seasons)
    except CleanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        spark.stop()
    rep = result.report
    print(f"analysis: {result.races} races ({args.source})")
    for table in AS.TABLES:
        print(f"  {table:<22} {result.rows[table]:>7} rows  checksum {result.checksums[table]}")
    print(f"  tyre source: {rep['races_by_tyre_source']}")
    print(f"  neutralised source: {rep['races_by_neutralised_source']}")
    print(f"  quick-lap exclusions: {rep['quick_lap_exclusions']}")
    print(f"  stint fits: {rep['stints_by_fit_status']}")
    print(f"  track-status cross-check: {rep['track_status_crosscheck']}")
    print(
        f"  TI rows unmapped: {rep['ti_rows_unmapped']}, "
        f"TI-only laps dropped: {rep['ti_only_laps_dropped']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
