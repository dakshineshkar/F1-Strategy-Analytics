"""Schema of the display-only per-race entrants dimension (``clean/entrants``, Feature 1).

Kept apart from ``lake/schemas.py`` on purpose (as ``schemas_tracinginsights``):
``etl.clean.CLEAN_TABLES`` and everything built on it are derived from that module, so this table
can never change a v1 output. No feature, model, rule or streaming code reads it.
"""

from __future__ import annotations

from pyspark.sql.types import (
    ArrayType,
    DataType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

INT, STR = IntegerType(), StringType()


def _s(*fields: tuple[str, DataType]) -> StructType:
    return StructType([StructField(name, dtype, True) for name, dtype in fields])


TABLE = "entrants"
PRIMARY_KEY: tuple[str, ...] = ("season", "round", "driver_id")

ENTRANTS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_id", STR),
    ("code", STR),
    ("given_name", STR),
    ("family_name", STR),
    ("car_number", INT),
    ("grid", INT),
    ("constructor_id", STR),
    ("team_name", STR),
    ("team_code", STR),
    ("team_lineage_id", STR),
    ("team_colour_hex", STR),
    ("colour_source", STR),
    ("nationality", STR),
    ("nationality_code", STR),
)
COLUMNS: tuple[str, ...] = tuple(ENTRANTS.fieldNames())

# The as-received TracingInsights ``drivers.json`` (only the fields read here; ``fn``, ``ln`` and
# ``url`` are never read: the dashboard draws no driver image).
RAW_TI_DRIVERS_JSON = StructType(
    [
        StructField(
            "drivers",
            ArrayType(_s(("driver", STR), ("team", STR), ("dn", STR), ("tc", STR))),
            True,
        )
    ]
)

# The rows ``etl.entrants.read_ti_drivers`` makes from it (season and round from the file path).
TI_DRIVER_ROWS = _s(
    ("season", INT),
    ("round", INT),
    ("driver_code", STR),
    ("driver_number", INT),
    ("team", STR),
    ("tc", STR),
)
