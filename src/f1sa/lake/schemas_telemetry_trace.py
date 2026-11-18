"""Schema of the display-only telemetry-trace table (``clean/telemetry_trace``, Feature 6).

Kept apart from ``lake/schemas.py``, ``schemas_tracinginsights.py`` and ``schemas_analysis.py`` on
purpose (as the other display tables): ``etl.clean.CLEAN_TABLES``, the TracingInsights clean job and
the analysis job iterate those modules, so this table can never change one of their outputs. No
feature, model, rule, alert, stream or what-if reads it; only the API's
``/api/races/{s}/{r}/telemetry/*`` routes do.

One row per (season, round, driver_code, lap). The arrays are the lap's channels resampled onto a
distance grid every ``GRID_STEP_M`` metres from the lap's start line, plus the lap's final distance
(``etl.telemetry_resample``). The table is partitioned by ``season``, ``round`` and ``driver_code``,
so the API reads one driver's partition (about 1 MB) per request.
"""

from __future__ import annotations

from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    ByteType,
    DataType,
    DoubleType,
    FloatType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
)

INT, LONG, DBL, STR, BOOL = IntegerType(), LongType(), DoubleType(), StringType(), BooleanType()
FLOATS, BYTES = ArrayType(FloatType(), True), ArrayType(ByteType(), True)

TABLE = "telemetry_trace"
QUALITY_FILE = "_quality.json"
"""The job's report, inside the table directory (the ``_`` prefix: Spark and the API skip it)."""
SEASON = 2024
"""The only season whose raw telemetry samples the lake keeps (Step 4C)."""
GRID_STEP_M = 5.0
PARTITION_COLUMNS: tuple[str, ...] = ("season", "round", "driver_code")
PRIMARY_KEY: tuple[str, ...] = ("season", "round", "driver_code", "lap")
COVERAGE_VALUES = ("full", "partial")
SOURCES = ("tracinginsights", "synthetic")


def _s(*fields: tuple[str, DataType]) -> StructType:
    return StructType([StructField(name, dtype, True) for name, dtype in fields])


RAW_TELEMETRY = _s(
    ("season", INT),
    ("round", INT),
    ("driver_code", STR),
    ("lap", LONG),
    ("time_in_lap_s", DBL),
    ("speed_kph", DBL),
    ("rpm", DBL),
    ("n_gear", LONG),
    ("throttle_pct", DBL),
    ("brake", BOOL),
    ("drs", LONG),
    ("distance_m", DBL),
)
"""The columns of the kept ``raw/tracinginsights/telemetry/.../telemetry.parquet`` the job reads
(read-only; position, acceleration and car-ahead columns are never read)."""

RESAMPLED = _s(
    ("season", INT),
    ("round", INT),
    ("driver_code", STR),
    ("lap", INT),
    ("n_samples", INT),
    ("n_corrected", INT),
    ("lap_length_m", DBL),
    ("trace_time_s", DBL),
    ("max_gap_s", DBL),
    ("distance_m", FLOATS),
    ("elapsed_s", FLOATS),
    ("speed_kph", FLOATS),
    ("throttle_pct", FLOATS),
    ("rpm", FLOATS),
    ("brake", BYTES),
    ("n_gear", BYTES),
    ("drs", BYTES),
    ("top_speed_kph", DBL),
    ("top_speed_at_m", DBL),
    ("min_corner_speed_kph", DBL),
    ("min_corner_at_m", DBL),
    ("full_throttle_share", DBL),
    ("brake_share", DBL),
    ("drs_share", DBL),
    ("n_braking_zones", INT),
    ("braking_start_m", FLOATS),
    ("braking_end_m", FLOATS),
    ("braking_apex_kph", FLOATS),
)
"""What ``etl.telemetry_resample.resample_group`` returns per (driver, lap) (``applyInPandas``)."""

LAP_INFO_COLUMNS: tuple[str, ...] = (
    "lap_time_s",
    "is_pit_in_lap",
    "is_pit_out_lap",
    "is_deleted",
    "is_neutralised_lap",
    "is_red_flag_lap",
    "compound",
    "tyre_life_laps",
)
"""Columns taken from ``clean/analysis_laps`` (read-only) by (season, round, driver_code, lap)."""

TELEMETRY_TRACE = _s(
    ("season", INT),
    ("round", INT),
    ("driver_code", STR),
    ("driver_id", STR),
    ("lap", INT),
    ("lap_time_s", DBL),
    ("is_pit_in_lap", BOOL),
    ("is_pit_out_lap", BOOL),
    ("is_deleted", BOOL),
    ("is_neutralised_lap", BOOL),
    ("is_red_flag_lap", BOOL),
    ("compound", STR),
    ("tyre_life_laps", INT),
    ("coverage", STR),
    ("is_synthetic", BOOL),
    ("source", STR),
    ("grid_step_m", DBL),
    *[(f.name, f.dataType) for f in RESAMPLED.fields if f.name not in PRIMARY_KEY],
)
"""The stored table (partition columns are restored from the directory names on read)."""

ARRAY_COLUMNS: tuple[str, ...] = tuple(
    f.name for f in TELEMETRY_TRACE.fields if isinstance(f.dataType, ArrayType)
)
