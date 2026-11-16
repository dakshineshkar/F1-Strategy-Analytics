"""Schemas of the display-only race-analysis tables (``clean/analysis_*``, Feature 2).

Kept apart from ``lake/schemas.py`` and ``schemas_tracinginsights.py`` on purpose (as
``schemas_entrants``): ``etl.clean.CLEAN_TABLES`` and the TracingInsights clean job iterate those
modules, so these tables can never change a v1 output. No feature, model, rule, alert or stream
reads them; only the API's ``/api/races/{s}/{r}/analysis/*`` routes do.
"""

from __future__ import annotations

from pyspark.sql.types import (
    BooleanType,
    DataType,
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
)

INT, LONG, DBL, STR, BOOL = IntegerType(), LongType(), DoubleType(), StringType(), BooleanType()


def _s(*fields: tuple[str, DataType]) -> StructType:
    return StructType([StructField(name, dtype, True) for name, dtype in fields])


# ------------------------------------------------------------------ raw input (subset read)
RAW_TI_LAPS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_code", STR),
    ("driver_number", STR),
    ("lap", LONG),
    ("lap_time_s", DBL),
    ("sector1_s", DBL),
    ("sector2_s", DBL),
    ("sector3_s", DBL),
    ("speed_i1_kph", DBL),
    ("speed_i2_kph", DBL),
    ("speed_fl_kph", DBL),
    ("speed_st_kph", DBL),
    ("tyre_life", LONG),
    ("track_status", STR),
    ("deleted", BOOL),
    ("deleted_reason", STR),
)
"""The columns of the as-received ``raw/tracinginsights/laps/.../laps.parquet`` that the analysis
job reads (read-only; the other 25 columns are never read)."""

# ------------------------------------------------------------------ tables
RACE = "analysis_race"
LAPS = "analysis_laps"
STINTS = "analysis_stints"
PITSTOPS = "analysis_pitstops"
RACE_CONTROL = "analysis_race_control"

ANALYSIS_RACE = _s(
    ("season", INT),
    ("round", INT),
    ("n_drivers", INT),
    ("n_laps", INT),
    ("n_lap_rows", INT),
    ("tyre_source", STR),
    ("is_synthetic", BOOL),
    ("has_sectors", BOOL),
    ("has_speed_traps", BOOL),
    ("deleted_known", BOOL),
    ("neutralised_source", STR),
    ("n_race_control", INT),
    ("n_pitstops", INT),
    ("n_quick_laps", INT),
    ("n_ti_only_laps_dropped", INT),
)
ANALYSIS_LAPS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_id", STR),
    ("driver_code", STR),
    ("lap", INT),
    ("position", INT),
    ("lap_time_s", DBL),
    ("cumulative_time_s", DBL),
    ("gap_to_leader_s", DBL),
    ("sector1_s", DBL),
    ("sector2_s", DBL),
    ("sector3_s", DBL),
    ("speed_i1_kph", DBL),
    ("speed_i2_kph", DBL),
    ("speed_fl_kph", DBL),
    ("speed_st_kph", DBL),
    ("stint", INT),
    ("compound", STR),
    ("tyre_life_laps", INT),
    ("compound_source", STR),
    ("is_synthetic", BOOL),
    ("is_pit_in_lap", BOOL),
    ("is_pit_out_lap", BOOL),
    ("is_deleted", BOOL),
    ("deleted_reason", STR),
    ("track_status", STR),
    ("is_sc_lap", BOOL),
    ("is_vsc_lap", BOOL),
    ("is_red_flag_lap", BOOL),
    ("is_neutralised_lap", BOOL),
    ("neutralised_source", STR),
    ("is_quick_lap", BOOL),
    ("quick_lap_exclusion", STR),
)
ANALYSIS_STINTS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_id", STR),
    ("driver_code", STR),
    ("stint", INT),
    ("compound", STR),
    ("start_lap", INT),
    ("end_lap", INT),
    ("laps", INT),
    ("tyre_life_start", INT),
    ("tyre_life_end", INT),
    ("used_set", BOOL),
    ("ends_in_pit", BOOL),
    ("n_quick_laps", INT),
    ("deg_slope_s_per_lap", DBL),
    ("deg_intercept_s", DBL),
    ("median_quick_lap_s", DBL),
    ("fit_status", STR),
    ("compound_source", STR),
    ("is_synthetic", BOOL),
)
ANALYSIS_PITSTOPS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_id", STR),
    ("driver_code", STR),
    ("stop", INT),
    ("lap", INT),
    ("time_of_day", STR),
    ("duration_s", DBL),
    ("is_long_stop", BOOL),
    ("under_neutralisation", BOOL),
    ("compound_before", STR),
    ("compound_after", STR),
    ("tyre_life_before", INT),
    ("position_before", INT),
    ("position_after", INT),
)
ANALYSIS_RACE_CONTROL = _s(
    ("season", INT),
    ("round", INT),
    ("seq", INT),
    ("lap", INT),
    ("time_utc", STR),
    ("category", STR),
    ("message", STR),
    ("status", STR),
    ("flag", STR),
    ("scope", STR),
    ("driver_id", STR),
    ("driver_code", STR),
    ("kind", STR),
    ("is_key", BOOL),
)

SCHEMAS: dict[str, StructType] = {
    RACE: ANALYSIS_RACE,
    LAPS: ANALYSIS_LAPS,
    STINTS: ANALYSIS_STINTS,
    PITSTOPS: ANALYSIS_PITSTOPS,
    RACE_CONTROL: ANALYSIS_RACE_CONTROL,
}
PRIMARY_KEYS: dict[str, tuple[str, ...]] = {
    RACE: ("season", "round"),
    LAPS: ("season", "round", "driver_id", "lap"),
    STINTS: ("season", "round", "driver_id", "stint"),
    PITSTOPS: ("season", "round", "driver_id", "stop"),
    RACE_CONTROL: ("season", "round", "seq"),
}
TABLES: tuple[str, ...] = tuple(SCHEMAS)

# ------------------------------------------------------------------ value sets
TYRE_SOURCES = ("tracinginsights", "synthetic", "none")
NEUTRALISED_SOURCES = ("track_status", "heuristic")
RACE_NEUTRALISED_SOURCES = (*NEUTRALISED_SOURCES, "mixed")
QUICK_LAP_EXCLUSIONS = (
    "no_time",
    "lap_1",
    "pit_in",
    "pit_out",
    "neutralised",
    "deleted",
    "slow_107",
)
"""Why a lap is not a quick lap, in priority order (the first that applies is stored)."""
FIT_STATUSES = ("ok", "too_few_laps", "no_tyre_life")
RACE_CONTROL_KINDS = (
    "sc_deployed",
    "sc_ending",
    "vsc_deployed",
    "vsc_ending",
    "red_flag",
    "penalty",
    "investigation",
    "track_limits",
    "chequered",
    "other",
)
KEY_RACE_CONTROL_KINDS = (
    "sc_deployed",
    "sc_ending",
    "vsc_deployed",
    "vsc_ending",
    "red_flag",
    "penalty",
)
QUICK_LAP_FACTOR = 1.07
MIN_FIT_LAPS = 5
