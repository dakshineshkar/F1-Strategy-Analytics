"""Display-only per-race entrants dimension (Feature 1): ``clean/entrants``.

    python -m f1sa.etl.entrants [--seasons 2021-2025]                       (make entrants-*)

One row per (season, round, driver_id): the driver's code, names and **car number in that race**
(``drivers.car_number``; ``permanent_number`` is today's season-table value and wrong for history),
grid slot, constructor, the season's team display name and badge code
(``entrants_reference.TEAM_NAMES``), the lineage id (``features.lineage.history_key``), the team
colour with its ``colour_source``, and the nationality as an F1-style code. It is keyed per race,
never per season, so mid-season seat changes (2024 Bearman: Ferrari R2, Haas R17 and R21) resolve
per race.

Inputs, all read-only: the clean ``drivers``, ``results`` and ``constructors`` tables, and the
as-received TracingInsights ``raw/tracinginsights/drivers/season=S/round=R/drivers.json`` (only
``driver``, ``team``, ``dn`` and ``tc``). Output: ``clean/entrants`` (partitioned by season and
round, dynamic overwrite) and ``clean/_quality/entrants.json``. Nothing else reads this table
except the API's ``GET /api/races/{s}/{r}/entrants``: no feature, model, rule, alert or stream.

Team colour, per race and constructor (``colour_source``):

1. ``ti_race``: the race's TracingInsights ``tc``. TI codes map to the race's clean
   ``drivers.code``, then the car number (``clean_tracinginsights.driver_map``). Teammates must
   agree, otherwise the job fails.
2. ``ti_neighbour_round_<n>``: the race has no ``tc`` for the team; the colour of round ``n``, the
   nearest round of the **same season** that has one (a tie goes to the earlier round).
3. ``project_palette``: no TracingInsights colour for the team in that season (sample mode, CI):
   ``entrants_reference.PROJECT_PALETTE``.

The job fails (exit 1) on a (season, constructor) missing from ``TEAM_NAMES``, a Jolpica
constructor name that differs from the committed one, an entrant whose constructor has no clean
``constructors`` row, an unmapped nationality demonym, a malformed ``tc``, teammates with different
colours, a team without any colour, or a duplicate key.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from itertools import chain
from pathlib import Path
from typing import Any

from pyspark.errors import AnalysisException
from pyspark.sql import DataFrame, SparkSession, Window
from pyspark.sql import functions as F

from f1sa.config import Settings, get_settings
from f1sa.etl import entrants_reference as R
from f1sa.etl.clean import (
    CleanError,
    check_output_root,
    conform,
    empty,
    read_clean,
    select_races,
    spark_uri,
    table_checksum,
    write_text,
)
from f1sa.etl.clean_tracinginsights import driver_map
from f1sa.etl.spark import build_spark
from f1sa.features.lineage import history_key_col
from f1sa.lake import schemas_entrants as ES

QUALITY_FILE = "entrants.json"
_RACE = ["season", "round"]
_TEAM_RACE = ["season", "round", "constructor_id"]
_HEX6 = r"^[0-9A-F]{6}$"


def _glob(seasons: Sequence[int] | None) -> str:
    return "*" if not seasons else "{" + ",".join(str(s) for s in sorted(seasons)) + "}"


# ============================================================================== inputs
def read_ti_drivers(
    spark: SparkSession, raw_root: str, seasons: Sequence[int] | None = None
) -> DataFrame:
    """One row per (race, TI driver) from the as-received ``drivers.json``; empty if none exist.

    ``tc`` is upper-cased and trimmed; ``"None"`` and ``""`` become null. ``dn`` becomes an int
    only when it is all digits (never a failing cast)."""
    pattern = f"{raw_root}/tracinginsights/drivers/season={_glob(seasons)}/round=*/drivers.json"
    try:
        pages = (
            spark.read.schema(ES.RAW_TI_DRIVERS_JSON)
            .option("multiLine", True)
            .option("mode", "FAILFAST")
            .json(pattern)
        )
    except AnalysisException as exc:
        if "PATH_NOT_FOUND" in str(exc) or "does not exist" in str(exc):
            return empty(spark, ES.TI_DRIVER_ROWS)
        raise
    path = F.col("_metadata.file_path")
    rows = pages.select(
        F.regexp_extract(path, r"/season=(\d+)/", 1).cast("int").alias("season"),
        F.regexp_extract(path, r"/round=(\d+)/", 1).cast("int").alias("round"),
        F.explode_outer("drivers").alias("d"),
    ).where(F.col("d").isNotNull())
    dn = F.trim(F.col("d.dn"))
    tc = F.upper(F.trim(F.col("d.tc")))
    out = rows.select(
        "season",
        "round",
        F.col("d.driver").alias("driver_code"),
        F.when(dn.rlike(r"^[0-9]{1,3}$"), dn.cast("int")).alias("driver_number"),
        F.col("d.team").alias("team"),
        F.when(tc.isNull() | tc.isin("", "NONE"), F.lit(None)).otherwise(tc).alias("tc"),
    )
    return conform(out, ES.TI_DRIVER_ROWS, "TI drivers.json")


def _reference_frames(spark: SparkSession) -> tuple[DataFrame, DataFrame]:
    names = spark.createDataFrame(
        [
            (s, cid, t.jolpica_name, t.team_name, t.team_code)
            for (s, cid), t in sorted(R.TEAM_NAMES.items())
        ],
        "season int, constructor_id string, jolpica_name string, team_name string, "
        "team_code string",
    )
    palette = spark.createDataFrame(
        [(s, cid, hex_) for (s, cid), hex_ in sorted(R.PROJECT_PALETTE.items())],
        "season int, constructor_id string, palette_hex string",
    )
    return names, palette


def _examples(rows: Iterable[Any], n: int = 5) -> str:
    items = [tuple(r) for r in rows]
    more = f" (+{len(items) - n} more)" if len(items) > n else ""
    return ", ".join(str(x) for x in items[:n]) + more


# ============================================================================== checks
def check_team_names(entries: DataFrame, constructors: DataFrame, names: DataFrame) -> None:
    """Fail on unmapped (season, constructor), a missing constructors row or a name mismatch."""
    team_races = entries.select(*_TEAM_RACE).distinct()
    unmapped = (
        team_races.select("season", "constructor_id")
        .distinct()
        .join(names, ["season", "constructor_id"], "left_anti")
        .orderBy("season", "constructor_id")
        .collect()
    )
    if unmapped:
        raise CleanError(
            "constructor ids not in entrants_reference.TEAM_NAMES (season, id): "
            + _examples(unmapped)
        )
    missing = team_races.join(constructors, _TEAM_RACE, "left_anti").orderBy(*_TEAM_RACE).collect()
    if missing:
        raise CleanError(
            "entrants whose constructor has no clean constructors row (season, round, id): "
            + _examples(missing)
        )
    wrong = (
        constructors.join(team_races, _TEAM_RACE, "left_semi")
        .join(names, ["season", "constructor_id"])
        .where(~F.col("name").eqNullSafe(F.col("jolpica_name")))
        .select("season", "round", "constructor_id", "name", "jolpica_name")
        .orderBy(*_TEAM_RACE)
        .collect()
    )
    if wrong:
        raise CleanError(
            "Jolpica constructor name differs from entrants_reference.TEAM_NAMES "
            "(season, round, id, data, expected): " + _examples(wrong)
        )


def check_nationalities(entries: DataFrame) -> None:
    demonyms = {
        r[0] for r in entries.select("nationality").distinct().collect() if r[0] is not None
    }
    unknown = sorted(demonyms - set(R.NATIONALITY_CODES))
    if unknown:
        raise CleanError(f"nationalities not in entrants_reference.NATIONALITY_CODES: {unknown}")


# ============================================================================== colours
def ti_team_colours(ti: DataFrame, drivers: DataFrame) -> DataFrame:
    """(season, round, constructor_id, ti_hex, ti_teams) from TI rows mapped to clean entrants.

    Raises on a malformed ``tc`` or on teammates whose colours differ."""
    bad = ti.where(F.col("tc").isNotNull() & ~F.col("tc").rlike(_HEX6))
    bad_rows = bad.select("season", "round", "driver_code", "tc").limit(6).collect()
    if bad_rows:
        raise CleanError(
            "malformed TracingInsights tc (season, round, code, tc): " + _examples(bad_rows)
        )
    mapping = driver_map(ti, drivers)
    mapped = (
        ti.join(mapping, [*_RACE, "driver_code"], "left")
        .join(drivers.select(*_RACE, "driver_id", "constructor_id"), [*_RACE, "driver_id"], "left")
        .where(F.col("constructor_id").isNotNull())
    )
    per_team = mapped.groupBy(*_TEAM_RACE).agg(
        F.countDistinct("tc").alias("n_colours"),
        F.min("tc").alias("tc"),
        F.array_sort(F.collect_set("team")).alias("ti_teams"),
    )
    clash = per_team.where(F.col("n_colours") > 1).orderBy(*_TEAM_RACE).collect()
    if clash:
        raise CleanError(
            "teammates have different TracingInsights colours (season, round, id): "
            + _examples((r["season"], r["round"], r["constructor_id"]) for r in clash)
        )
    return per_team.select(
        *_TEAM_RACE,
        F.when(F.col("tc").isNotNull(), F.concat(F.lit("#"), F.col("tc"))).alias("ti_hex"),
        "ti_teams",
    )


def resolve_colours(team_races: DataFrame, ti_colours: DataFrame, palette: DataFrame) -> DataFrame:
    """(season, round, constructor_id, team_colour_hex, colour_source, colour_round) per team race.

    Nearest round of the same season with a TI colour (distance 0 = the race itself; a tie goes
    to the earlier round), else the project palette; raises if a team has no colour at all."""
    known = ti_colours.where(F.col("ti_hex").isNotNull()).select(
        "season", "constructor_id", F.col("round").alias("colour_round"), "ti_hex"
    )
    cand = team_races.join(known, ["season", "constructor_id"]).withColumn(
        "_dist", F.abs(F.col("colour_round") - F.col("round"))
    )
    w = Window.partitionBy(*_TEAM_RACE).orderBy("_dist", "colour_round")
    nearest = (
        cand.withColumn("_rank", F.row_number().over(w))
        .where(F.col("_rank") == 1)
        .select(*_TEAM_RACE, "colour_round", "ti_hex")
    )
    out = (
        team_races.join(nearest, _TEAM_RACE, "left")
        .join(palette, ["season", "constructor_id"], "left")
        .select(
            *_TEAM_RACE,
            F.coalesce("ti_hex", "palette_hex").alias("team_colour_hex"),
            F.when(F.col("ti_hex").isNull(), F.lit(R.COLOUR_SOURCE_PALETTE))
            .when(F.col("colour_round") == F.col("round"), F.lit(R.COLOUR_SOURCE_TI_RACE))
            .otherwise(
                F.concat(
                    F.lit(R.COLOUR_SOURCE_NEIGHBOUR_PREFIX), F.col("colour_round").cast("string")
                )
            )
            .alias("colour_source"),
            F.when(F.col("ti_hex").isNotNull(), F.col("colour_round")).alias("colour_round"),
        )
    )
    none = out.where(F.col("team_colour_hex").isNull()).orderBy(*_TEAM_RACE).collect()
    if none:
        raise CleanError(
            "teams without any colour (no TracingInsights tc in the season and no "
            "PROJECT_PALETTE entry) (season, round, id): "
            + _examples((r["season"], r["round"], r["constructor_id"]) for r in none)
        )
    return out


# ============================================================================== build
def build_entrants(
    spark: SparkSession,
    drivers: DataFrame,
    results: DataFrame,
    constructors: DataFrame,
    ti: DataFrame,
) -> tuple[DataFrame, DataFrame]:
    """(entrants conformed to ``ES.ENTRANTS``, the per-team-race TI colours for the report)."""
    names, palette = _reference_frames(spark)
    check_team_names(drivers, constructors, names)
    check_nationalities(drivers)
    ti_races = ti.join(drivers.select(*_RACE).distinct(), _RACE, "left_semi")
    ti_colours = ti_team_colours(ti_races, drivers).cache()
    team_races = drivers.select(*_TEAM_RACE).distinct()
    colours = resolve_colours(team_races, ti_colours, palette)
    nat = F.create_map(
        *[F.lit(x) for x in chain.from_iterable(sorted(R.NATIONALITY_CODES.items()))]
    )
    df = (
        drivers.join(results.select(*_RACE, "driver_id", "grid"), [*_RACE, "driver_id"], "left")
        .join(names.drop("jolpica_name"), ["season", "constructor_id"], "left")
        .join(colours.drop("colour_round"), _TEAM_RACE, "left")
        .withColumn("team_lineage_id", history_key_col("constructor_id"))
        .withColumn("nationality_code", nat[F.col("nationality")])
    )
    return conform(df, ES.ENTRANTS, "entrants"), ti_colours


def write_entrants(df: DataFrame, clean_root: str) -> None:
    """Overwrite exactly the (season, round) partitions present in ``df``."""
    (
        df.repartition(*_RACE)
        .sortWithinPartitions(*ES.PRIMARY_KEY)
        .write.mode("overwrite")
        .partitionBy(*_RACE)
        .parquet(f"{clean_root}/{ES.TABLE}")
    )


def read_entrants(spark: SparkSession, clean_root: str) -> DataFrame:
    """The stored ``clean/entrants`` table (partition columns restored), or empty."""
    try:
        df = spark.read.schema(ES.ENTRANTS).parquet(f"{clean_root}/{ES.TABLE}")
    except AnalysisException as exc:
        if "PATH_NOT_FOUND" in str(exc) or "does not exist" in str(exc):
            return empty(spark, ES.ENTRANTS)
        raise
    return df.select(*ES.COLUMNS)


@dataclass
class EntrantsResult:
    rows: int = 0
    races: int = 0
    checksum: str = ""
    report: dict[str, Any] = field(default_factory=dict)


def build_report(stored: DataFrame, ti_colours: DataFrame, ti_unmapped: int) -> dict[str, Any]:
    """Counts only: per colour source, the neighbour-filled races, and TI team-name checks."""
    team_rows = (
        stored.select(*_TEAM_RACE, "team_name", "colour_source")
        .distinct()
        .orderBy(*_TEAM_RACE)
        .collect()
    )
    by_source = Counter(
        "ti_neighbour_round"
        if r["colour_source"].startswith(R.COLOUR_SOURCE_NEIGHBOUR_PREFIX)
        else r["colour_source"]
        for r in team_rows
    )
    neighbour: dict[tuple[int, int], dict[str, str]] = {}
    for r in team_rows:
        if r["colour_source"].startswith(R.COLOUR_SOURCE_NEIGHBOUR_PREFIX):
            neighbour.setdefault((r["season"], r["round"]), {})[r["constructor_id"]] = r[
                "colour_source"
            ]
    display = {(r["season"], r["round"], r["constructor_id"]): r["team_name"] for r in team_rows}
    mismatches = []
    for r in ti_colours.orderBy(*_TEAM_RACE).collect():
        expected = display.get((r["season"], r["round"], r["constructor_id"]))
        for team in r["ti_teams"] or []:
            if expected is not None and team != expected:
                mismatches.append(
                    {
                        "season": r["season"],
                        "round": r["round"],
                        "constructor_id": r["constructor_id"],
                        "tracinginsights_team": team,
                        "team_name": expected,
                    }
                )
    races = sorted({(r["season"], r["round"]) for r in team_rows})
    return {
        "races": len(races),
        "seasons": sorted({s for s, _ in races}),
        "team_races_by_colour_source": dict(sorted(by_source.items())),
        "neighbour_filled_races": [
            {"season": s, "round": rd, "constructors": dict(sorted(v.items()))}
            for (s, rd), v in sorted(neighbour.items())
        ],
        "palette_races": sorted(
            {
                f"{r['season']}_{r['round']}"
                for r in team_rows
                if r["colour_source"] == R.COLOUR_SOURCE_PALETTE
            }
        ),
        "tracinginsights_rows_unmapped": ti_unmapped,
        "tracinginsights_team_name_mismatches": mismatches,
    }


def run_entrants(
    spark: SparkSession, settings: Settings, seasons: Sequence[int] | None = None
) -> EntrantsResult:
    lake = spark_uri(settings.data_lake_uri)
    raw_root, clean_root = f"{lake}/raw", f"{lake}/clean"
    check_output_root(clean_root)
    drivers = select_races(read_clean(spark, clean_root, "drivers"), seasons, None).cache()
    if drivers.isEmpty():
        raise CleanError(f"no clean drivers under {clean_root}; run the clean job first")
    results = select_races(read_clean(spark, clean_root, "results"), seasons, None)
    constructors = select_races(read_clean(spark, clean_root, "constructors"), seasons, None)
    ti = read_ti_drivers(spark, raw_root, seasons).cache()
    df, ti_colours = build_entrants(spark, drivers, results, constructors, ti)
    dups = df.groupBy(*ES.PRIMARY_KEY).count().where(F.col("count") > 1).count()
    if dups:
        raise CleanError(f"entrants: {dups} duplicate primary keys")
    write_entrants(df, clean_root)
    races = drivers.select(*_RACE).distinct()
    stored = read_entrants(spark, clean_root).join(races, _RACE, "left_semi").cache()
    mapping = driver_map(ti.join(races, _RACE, "left_semi"), drivers)
    unmapped = mapping.where(F.col("driver_id").isNull()).count()
    result = EntrantsResult(
        rows=stored.count(),
        races=races.count(),
        checksum=table_checksum(stored),
        report=build_report(stored, ti_colours, unmapped),
    )
    result.report.update({"rows": result.rows, "checksum": result.checksum})
    write_text(
        spark,
        f"{clean_root}/_quality/{QUALITY_FILE}",
        json.dumps(result.report, indent=1, sort_keys=True) + "\n",
    )
    for frame in (drivers, ti, ti_colours, stored):
        frame.unpersist()
    return result


def main(argv: Iterable[str] | None = None) -> int:
    from f1sa.ingest.cli import parse_seasons

    parser = argparse.ArgumentParser(prog="python -m f1sa.etl.entrants")
    parser.add_argument("--seasons", type=parse_seasons, default=None)
    parser.add_argument("--master", default="local[2]")
    args = parser.parse_args(list(argv) if argv is not None else None)
    settings = get_settings()
    lake = spark_uri(settings.data_lake_uri)
    local_dir = None
    if lake.startswith("file://"):
        local_dir = Path(lake.removeprefix("file://")) / ".spark-tmp"
    spark = build_spark("f1sa-entrants", args.master, local_dir=local_dir)
    try:
        result = run_entrants(spark, settings, args.seasons)
    except CleanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        spark.stop()
    rep = result.report
    print(f"entrants: {result.rows} rows, {result.races} races, checksum {result.checksum}")
    print(f"  team races by colour source: {rep['team_races_by_colour_source']}")
    for n in rep["neighbour_filled_races"]:
        sources = sorted(set(n["constructors"].values()))
        print(f"  {n['season']} R{n['round']}: neighbour colours {sources}")
    print(f"  TracingInsights rows unmapped: {rep['tracinginsights_rows_unmapped']}")
    mismatches = rep["tracinginsights_team_name_mismatches"]
    print(f"  TracingInsights team-name mismatches: {len(mismatches)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
