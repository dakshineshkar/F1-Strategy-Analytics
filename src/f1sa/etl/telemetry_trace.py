"""Display-only telemetry traces for 2024 (Feature 6): ``clean/telemetry_trace``.

    python -m f1sa.etl.telemetry_trace --source lake [--rounds 1-24]   (make telemetry-trace-full)
    python -m f1sa.etl.telemetry_trace --source sample                 (make telemetry-trace-sample)

Inputs, both read-only:

* ``--source lake``: the raw samples the lake keeps for 2024 only (Step 4C),
  ``raw/tracinginsights/telemetry/season=2024/round=R/driver=CODE/telemetry.parquet`` (the columns
  of ``schemas_telemetry_trace.RAW_TELEMETRY``). ``--source sample``: the SYNTHETIC fixture that
  ``ingest.synthetic_telemetry`` writes in the same layout under ``{lake}/fixtures/telemetry_raw``
  (file lake only; tests and the Playwright smoke only, never ``make demo``).
* ``clean/analysis_laps`` (Feature 2): the race's ``driver_id`` per code and the lap's time, pit,
  deleted, neutralised, compound and tyre-life columns; and the v1 clean ``drivers`` (code ->
  ``driver_id``) for a driver with no completed lap (a lap-1 retirement), whose lap info is null.

Every (season, round, driver_code, lap) group is resampled onto the distance grid by
``etl.telemetry_resample.resample_group`` (``groupBy(...).applyInPandas``). A lap is ``partial``
when two samples are more than ``telemetry_agg_ti.MAX_GAP_S`` apart or the trace covers less than
``MIN_SPAN_SHARE`` of the lap time, otherwise ``full``.

Output: **only** ``clean/telemetry_trace`` (``partitionBy(season, round, driver_code)``, dynamic
overwrite, zstd) and its report ``clean/telemetry_trace/_quality.json``. The write path is checked
before anything runs: it must be exactly ``{lake}/clean/telemetry_trace`` (never ``raw``), and file
mode keeps the usual ``./data/lake`` guard. Only 2024 is ever read. No feature, model, rule, alert,
stream, what-if or archive reads the table; only the API's ``/api/races/2024/{r}/telemetry/*``.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pyspark.sql import Column, DataFrame, SparkSession
from pyspark.sql import functions as F

from f1sa.config import Settings, get_settings
from f1sa.etl.analysis import read_analysis
from f1sa.etl.clean import (
    CleanError,
    check_output_root,
    conform,
    read_clean,
    read_parquet_table,
    spark_uri,
    table_checksum,
    write_text,
)
from f1sa.etl.spark import build_spark
from f1sa.etl.telemetry_resample import resample_group
from f1sa.features.telemetry_agg_ti import MAX_GAP_S, MIN_SPAN_SHARE
from f1sa.lake import schemas_analysis as AS
from f1sa.lake import schemas_telemetry_trace as TT

SOURCES = ("lake", "sample")
FIXTURE_DIR = "fixtures/telemetry_raw"
"""Where ``ingest.synthetic_telemetry`` writes the sample fixture (under a ``file://`` lake)."""
_RACE = ["season", "round"]
_DRIVER = ["season", "round", "driver_code"]
_KEY = list(TT.PRIMARY_KEY)


def parse_rounds(value: str) -> list[int]:
    """``1-24`` or ``5,7`` -> sorted unique rounds in 1..30."""
    rounds: set[int] = set()
    try:
        for part in (p.strip() for p in value.split(",")):
            if not part:
                raise ValueError("empty item")
            if "-" in part:
                lo, hi = (int(x) for x in part.split("-", 1))
                if lo > hi:
                    raise ValueError(f"descending range {part}")
                rounds.update(range(lo, hi + 1))
            else:
                rounds.add(int(part))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"--rounds must look like 1-24 or 5,7 ({exc})") from exc
    bad = sorted(r for r in rounds if not 1 <= r <= 30)
    if bad:
        raise argparse.ArgumentTypeError(f"--rounds out of range 1..30: {bad}")
    return sorted(rounds)


def parse_season(value: str) -> int:
    """Only ``2024``: the lake keeps raw telemetry samples for 2024 only."""
    if value.strip() != str(TT.SEASON):
        raise argparse.ArgumentTypeError(
            f"telemetry traces are available for {TT.SEASON} only (got {value!r})"
        )
    return TT.SEASON


def output_path(lake: str) -> str:
    """``{lake}/clean/telemetry_trace``; ``CleanError`` for anything that is not exactly that."""
    scheme, sep, rest = lake.partition("://")
    if not sep or not rest:
        raise CleanError(f"not a lake URI: {lake!r}")
    root = posixpath.normpath(rest)
    out = posixpath.normpath(f"{root}/clean/{TT.TABLE}")
    if out != f"{root}/clean/{TT.TABLE}" or "/raw/" in f"{out}/" or "/../" in f"{out}/":
        raise CleanError(f"refusing to write {out!r}: only clean/{TT.TABLE} is written")
    return f"{scheme}://{out}"


def raw_root(lake: str, source: str) -> str:
    if source == "lake":
        return f"{lake}/raw"
    if source == "sample":
        if not lake.startswith("file://"):
            raise CleanError("--source sample needs a file:// lake (DATA_LAKE_URI)")
        return f"{lake}/{FIXTURE_DIR}"
    raise CleanError(f"unknown source {source!r}")


def _round_glob(rounds: Sequence[int] | None) -> str:
    return "*" if not rounds else "{" + ",".join(str(r) for r in sorted(rounds)) + "}"


def read_raw_telemetry(
    spark: SparkSession, root: str, rounds: Sequence[int] | None = None
) -> DataFrame:
    """The kept 2024 raw samples (only ``RAW_TELEMETRY``'s columns); empty if there are none."""
    pattern = (
        f"{root}/tracinginsights/telemetry/season={TT.SEASON}/round={_round_glob(rounds)}"
        "/driver=*/telemetry.parquet"
    )
    df = read_parquet_table(spark, pattern, TT.RAW_TELEMETRY, "raw telemetry")
    return df.where(F.col("season") == TT.SEASON)


def lap_info(
    analysis_laps: DataFrame, race_drivers: DataFrame | None = None
) -> tuple[DataFrame, DataFrame]:
    """(driver map ``season, round, driver_code -> driver_id``, the per-lap columns).

    The map comes from ``analysis_laps``, plus the race's clean ``drivers.code`` for a code
    without a completed lap (a lap-1 retirement: TracingInsights has its lap file, Jolpica no
    lap). The two sources must agree; a code mapped to two ids fails the job."""
    laps = analysis_laps.where(F.col("driver_code").isNotNull())
    sources = [laps.select(*_DRIVER, "driver_id")]
    if race_drivers is not None:
        sources.append(
            race_drivers.where(F.col("code").isNotNull()).select(
                *_RACE, F.col("code").alias("driver_code"), "driver_id"
            )
        )
    candidates = sources[0]
    for extra in sources[1:]:
        candidates = candidates.unionByName(extra)
    drivers = candidates.distinct()
    clash = drivers.groupBy(*_DRIVER).count().where(F.col("count") > 1).count()
    if clash:
        raise CleanError(f"{clash} driver codes map to more than one driver_id")
    info = laps.select(*_KEY, *TT.LAP_INFO_COLUMNS)
    return drivers, info


def coverage(lap_time: str = "lap_time_s") -> Column:
    short = F.col(lap_time).isNotNull() & (
        F.col("trace_time_s") < F.lit(MIN_SPAN_SHARE) * F.col(lap_time)
    )
    return F.when((F.col("max_gap_s") > F.lit(MAX_GAP_S)) | short, F.lit("partial")).otherwise(
        F.lit("full")
    )


def build_traces(
    raw: DataFrame,
    analysis_laps: DataFrame,
    *,
    synthetic: bool,
    race_drivers: DataFrame | None = None,
) -> DataFrame:
    """Resampled laps joined to their driver and lap info (rows of unmapped codes are dropped)."""
    resampled = raw.groupBy(*_KEY).applyInPandas(resample_group, schema=TT.RESAMPLED)
    drivers, info = lap_info(analysis_laps, race_drivers)
    joined = (
        resampled.join(drivers, _DRIVER, "inner")
        .join(info, _KEY, "left")
        .withColumn("coverage", coverage())
        .withColumn("is_synthetic", F.lit(synthetic))
        .withColumn("source", F.lit("synthetic" if synthetic else "tracinginsights"))
        .withColumn("grid_step_m", F.lit(TT.GRID_STEP_M))
    )
    return conform(joined, TT.TELEMETRY_TRACE, TT.TABLE)


def read_traces(spark: SparkSession, out: str) -> DataFrame:
    """The stored table (partition columns restored from the paths)."""
    return (
        spark.read.schema(TT.TELEMETRY_TRACE).parquet(out).select(TT.TELEMETRY_TRACE.fieldNames())
    )


def path_bytes(spark: SparkSession, uri: str) -> int:
    """Total bytes under ``uri`` (Hadoop ``getContentSummary``; file:// or hdfs://)."""
    jvm = spark.sparkContext._jvm
    if jvm is None:
        raise CleanError("Spark JVM gateway unavailable")
    path = jvm.org.apache.hadoop.fs.Path(uri)
    fs = path.getFileSystem(spark.sparkContext._jsc.hadoopConfiguration())
    return int(fs.getContentSummary(path).getLength())


@dataclass
class TraceResult:
    rows: int
    races: int
    report: dict[str, Any] = field(default_factory=dict)


def _by(df: DataFrame, *cols: str) -> dict[str, int]:
    return {
        ":".join(str(r[c]) for c in cols): int(r["count"])
        for r in df.groupBy(*cols).count().orderBy(*cols).collect()
    }


def run_traces(
    spark: SparkSession,
    settings: Settings,
    *,
    source: str,
    rounds: Sequence[int] | None = None,
) -> TraceResult:
    if source not in SOURCES:
        raise CleanError(f"unknown source {source!r}")
    lake = spark_uri(settings.data_lake_uri)
    clean_root = f"{lake}/clean"
    check_output_root(clean_root)
    out = output_path(lake)
    root = raw_root(lake, source)
    raw = read_raw_telemetry(spark, root, rounds)
    if raw.isEmpty():
        hint = "make telemetry-trace-sample" if source == "sample" else "make ingest-ti-full"
        raise CleanError(f"no {TT.SEASON} raw telemetry under {root} (run {hint})")
    races = sorted(
        (int(r["season"]), int(r["round"])) for r in raw.select(*_RACE).distinct().collect()
    )
    laps = read_analysis(spark, clean_root, AS.LAPS).where(F.col("season") == TT.SEASON)
    laps = laps.join(spark.createDataFrame(races, _RACE), _RACE, "left_semi")
    if laps.isEmpty():
        raise CleanError(
            f"no clean/analysis_laps for the {TT.SEASON} races; run the analysis job first"
        )

    groups = raw.select(*_KEY).distinct()
    race_drivers = read_clean(spark, clean_root, "drivers").where(F.col("season") == TT.SEASON)
    race_drivers = race_drivers.join(spark.createDataFrame(races, _RACE), _RACE, "left_semi")
    drivers, _ = lap_info(laps, race_drivers)
    unmapped = groups.join(drivers, _DRIVER, "left_anti").cache()
    n_groups, n_unmapped = groups.count(), unmapped.count()
    unmapped_codes = sorted(
        {
            f"R{r['round']}:{r['driver_code']}"
            for r in unmapped.select(*_RACE, "driver_code").distinct().collect()
        }
    )
    unmapped.unpersist()

    traces = build_traces(raw, laps, synthetic=source == "sample", race_drivers=race_drivers)
    (
        traces.repartition(*TT.PARTITION_COLUMNS)
        .sortWithinPartitions(*_KEY)
        .write.mode("overwrite")
        .option("compression", "zstd")
        .partitionBy(*TT.PARTITION_COLUMNS)
        .parquet(out)
    )
    stored = read_traces(spark, out).join(spark.createDataFrame(races, _RACE), _RACE, "left_semi")
    stored = stored.cache()
    dups = stored.groupBy(*_KEY).count().where(F.col("count") > 1).count()
    if dups:
        raise CleanError(f"{TT.TABLE}: {dups} duplicate primary keys")
    rows = stored.count()
    no_info = stored.where(F.col("lap_time_s").isNull()).count()
    totals = stored.agg(
        F.sum("n_samples").alias("samples"),
        F.sum("n_corrected").alias("corrected"),
        F.sum(F.size("distance_m")).alias("grid_points"),
        F.sum(F.when(F.col("n_corrected") > 0, 1).otherwise(0)).alias("laps_corrected"),
    ).first()
    report: dict[str, Any] = {
        "source": source,
        "season": TT.SEASON,
        "is_synthetic": source == "sample",
        "grid_step_m": TT.GRID_STEP_M,
        "races": len(races),
        "lap_groups_in": n_groups,
        "rows": rows,
        "laps_without_trace": n_groups - n_unmapped - rows,
        "rows_unmapped_driver": n_unmapped,
        "unmapped_drivers": unmapped_codes,
        "rows_without_lap_info": no_info,
        "samples": int(totals["samples"] or 0) if totals else 0,
        "samples_corrected": int(totals["corrected"] or 0) if totals else 0,
        "laps_with_corrected_samples": int(totals["laps_corrected"] or 0) if totals else 0,
        "grid_points": int(totals["grid_points"] or 0) if totals else 0,
        "coverage": _by(stored, "coverage"),
        "rows_per_round": _by(stored, "round"),
        "drivers_per_round": {
            str(r["round"]): int(r["n"])
            for r in stored.groupBy("round")
            .agg(F.countDistinct("driver_code").alias("n"))
            .orderBy("round")
            .collect()
        },
        "checksum": table_checksum(stored),
        "table_bytes": path_bytes(spark, out),
    }
    stored.unpersist()
    write_text(
        spark, f"{out}/{TT.QUALITY_FILE}", json.dumps(report, indent=1, sort_keys=True) + "\n"
    )
    return TraceResult(rows=rows, races=len(races), report=report)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m f1sa.etl.telemetry_trace")
    parser.add_argument("--source", choices=SOURCES, required=True)
    parser.add_argument("--seasons", type=parse_season, default=TT.SEASON, help="2024 only")
    parser.add_argument("--rounds", type=parse_rounds, default=None)
    parser.add_argument("--master", default="local[2]")
    parser.add_argument("--shuffle-partitions", type=int, default=4)
    args = parser.parse_args(list(argv) if argv is not None else None)
    settings = get_settings()
    try:
        lake = spark_uri(settings.data_lake_uri)
        output_path(lake)
    except CleanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    local_dir = None
    if lake.startswith("file://"):
        local_dir = Path(lake.removeprefix("file://")) / ".spark-tmp"
    spark = build_spark(
        "f1sa-telemetry-trace",
        args.master,
        local_dir=local_dir,
        shuffle_partitions=max(1, args.shuffle_partitions),
    )
    try:
        result = run_traces(spark, settings, source=args.source, rounds=args.rounds)
    except CleanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        spark.stop()
    rep = result.report
    print(f"telemetry_trace: {result.races} races, {result.rows} laps ({args.source})")
    print(
        f"  lap groups in {rep['lap_groups_in']}, without a trace {rep['laps_without_trace']}, "
        f"unmapped {rep['rows_unmapped_driver']} {rep['unmapped_drivers']}"
    )
    print(f"  rows without analysis_laps info: {rep['rows_without_lap_info']}")
    print(f"  coverage: {rep['coverage']}")
    print(
        f"  samples {rep['samples']}, corrected {rep['samples_corrected']} "
        f"(in {rep['laps_with_corrected_samples']} laps), grid points {rep['grid_points']}"
    )
    print(f"  drivers per round: {rep['drivers_per_round']}")
    print(f"  table bytes: {rep['table_bytes']}  checksum {rep['checksum']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
