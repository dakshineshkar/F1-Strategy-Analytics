"""Build the post-race archive bundles (Feature 4, display only).

    DATA_LAKE_URI=file://$PWD/data/lake python -m f1sa.archive.build --source sample
    python -m f1sa.archive.build --source lake [--season S [--round R]] [--model-dir D]

Per race: the producer's events (``streaming.producer.load_race_inputs``), the earlier-race
priors (``streaming.priors.load_priors``) and the deployed scorer (``stream_job.load_model``) go
through ``archive.replay.replay_race`` (the frozen stream path, one micro-batch per leader lap).
The entrants and the race-control / track-status rows come through the API's own read-only
readers and response builders (``api.entrants.to_entrants``, ``api.analysis.to_view``).

Writes **only** ``{lake}/archive/race_bundle/season=S/round=R/{bundle.json.gz,_manifest.json}``
(``FileSink`` or ``HdfsSink``; file mode only under ``./data/lake``); never ``raw``, never a clean
or feature table, never ``results/``. 2025 only with ``--allow-test-season``. The bundle is
validated (schema v1, decoded back) before it is written, and a rebuild is byte-identical.

Exit codes: 0 built, 1 a race failed (missing prerequisite tables, invalid bundle), 2 refused
(bad arguments, the sealed test season, ``--source sample`` on a non-file lake).
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from pyspark.sql import SparkSession

from f1sa.api import analysis as AN
from f1sa.api import entrants as EN
from f1sa.api.catalog import CatalogError, zone_reader
from f1sa.api.health import ModelStatus
from f1sa.api.models import AnalysisLapsOut, AnalysisRaceControlsOut
from f1sa.archive.replay import N_PARTITIONS, ArchiveError, replay_race
from f1sa.archive.schema import (
    BUNDLE_NAME,
    ArchiveBundle,
    BuilderInfo,
    BundleMeta,
    ModelInfo,
    TrackLapOut,
    decode_bundle,
    encode_bundle,
    manifest_for,
)
from f1sa.config import Settings, get_settings
from f1sa.etl.clean import spark_uri
from f1sa.ingest.sinks import FileSink, HdfsSink
from f1sa.lake import schemas as S
from f1sa.lake.paths import (
    ARCHIVE_TABLE,
    ARCHIVE_ZONE,
    archive_partition_uri,
    is_within,
    local_path,
)
from f1sa.streaming.priors import PriorsError, load_priors, read_race_partition
from f1sa.streaming.processor import SEALED_SEASON
from f1sa.streaming.producer import ProducerError, load_race_inputs

log = logging.getLogger(__name__)
FILE_LAKE_ROOT = Path("data/lake")


class RefusedError(RuntimeError):
    """A request the builder refuses (exit 2)."""


@dataclass(frozen=True)
class BuiltRace:
    season: int
    round: int
    laps: int
    n_messages: int
    n_alerts: int
    n_decisions: int
    raw_bytes: int
    size_bytes: int
    sha256: str
    uri: str


# ============================================================================== guards
def check_archive_uri(uri: str, settings: Settings) -> str:
    """``uri`` if it is an archive partition of the configured lake (never ``raw``); in file mode
    it must also lie under ./data/lake."""
    base = f"{settings.data_lake_uri.rstrip('/')}/{ARCHIVE_ZONE}/{ARCHIVE_TABLE}/"
    parts = uri.split("/")
    if not uri.startswith(base) or "raw" in parts or ".." in parts:
        raise RefusedError(f"refusing to write outside {base}: {uri}")
    if uri.startswith("file://") and not is_within(local_path(uri), FILE_LAKE_ROOT):
        raise RefusedError(f"refusing to write outside ./{FILE_LAKE_ROOT}: {uri}")
    return uri


def check_source(settings: Settings, source: str) -> None:
    if source not in ("sample", "lake"):
        raise RefusedError(f"unknown source {source!r}")
    if source == "sample" and not settings.data_lake_uri.startswith("file://"):
        raise RefusedError("--source sample needs a file:// DATA_LAKE_URI (the sample lake)")


def check_test_season(season: int, allow_test_season: bool) -> None:
    if season == SEALED_SEASON and not allow_test_season:
        raise RefusedError(
            f"season {season} is the sealed test season; pass --allow-test-season to archive it"
        )


# ============================================================================== inputs
def list_races(
    settings: Settings,
    *,
    allow_test_season: bool,
    season: int | None = None,
    round_: int | None = None,
) -> list[tuple[int, int]]:
    """Every race of the clean ``laps`` (2025 never listed unless allowed), filtered."""
    reader = zone_reader(settings, "clean", ("laps",), allow_test_season=allow_test_season)
    races = reader.partitions("laps")
    if season is not None:
        races = [r for r in races if r[0] == season]
    if round_ is not None:
        races = [r for r in races if r[1] == round_]
    return races


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        v = value if value.tzinfo else value.replace(tzinfo=UTC)
        return v.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def start_ms_of(race_start_utc: Any, race_date: Any) -> int:
    """The simulated clock's origin: the scheduled start, else the race date at 00:00 UTC."""
    if isinstance(race_start_utc, datetime):
        v = race_start_utc if race_start_utc.tzinfo else race_start_utc.replace(tzinfo=UTC)
        return int(v.timestamp() * 1000)
    if isinstance(race_date, date):
        return int(
            datetime(race_date.year, race_date.month, race_date.day, tzinfo=UTC).timestamp() * 1000
        )
    return 0


def race_info(spark: SparkSession, lake: str, season: int, round_: int) -> dict[str, Any]:
    df = read_race_partition(
        spark, f"{lake}/clean", "races", S.CLEAN_SCHEMAS["races"], season, round_
    )
    rows = df.select("race_name", "circuit_name", "race_date", "race_start_utc").collect()
    if len(rows) != 1:
        raise ArchiveError(f"{season} R{round_}: {len(rows)} clean races rows, expected 1")
    return rows[0].asDict()


def track_laps(laps: AnalysisLapsOut) -> list[TrackLapOut]:
    """Per lap, the track status of that lap's leader (lowest position; ties by driver id)."""
    best: dict[int, Any] = {}
    for row in laps.rows:
        if row.position is None:
            continue
        cur = best.get(row.lap)
        if cur is None or (row.position, row.driver_id) < (cur.position, cur.driver_id):
            best[row.lap] = row
    return [
        TrackLapOut(
            lap=lap,
            is_sc_lap=row.is_sc_lap,
            is_vsc_lap=row.is_vsc_lap,
            is_red_flag_lap=row.is_red_flag_lap,
            is_neutralised_lap=row.is_neutralised_lap,
            neutralised_source=row.neutralised_source,
            track_status=row.track_status,
        )
        for lap, row in sorted(best.items())
    ]


@dataclass(frozen=True)
class DisplayRows:
    entrants: list[Any]
    track: list[TrackLapOut]
    race_control: list[Any]
    synthetic: bool


def display_rows(
    settings: Settings, season: int, round_: int, *, allow_test_season: bool, source: str
) -> DisplayRows:
    """Entrants, track status and race control through the API's read-only readers."""
    hint = (
        "make entrants-sample analysis-sample"
        if source == "sample"
        else ("make entrants-full analysis-full")
    )
    ent_reader = zone_reader(settings, "clean", EN.TABLES, allow_test_season=allow_test_season)
    ana_reader = zone_reader(settings, "clean", AN.TABLES, allow_test_season=allow_test_season)
    try:
        ent_rows = ent_reader.read_rows(EN.TABLE, season, round_, EN.COLUMNS)
        race = ana_reader.read_rows(AN.RACE_TABLE, season, round_, AN.COVERAGE_COLUMNS)
    except CatalogError as exc:
        raise ArchiveError(f"{season} R{round_}: {exc}; run {hint} first") from exc
    if not ent_rows:
        raise ArchiveError(f"{season} R{round_}: no clean/entrants rows; run {hint} first")
    if not race:
        raise ArchiveError(f"{season} R{round_}: no clean/analysis_race row; run {hint} first")
    try:
        entrants = EN.to_entrants(season, round_, ent_rows).entrants
        coverage = AN.to_coverage(season, round_, race)
        laps = AN.to_view(
            "laps",
            season,
            round_,
            coverage,
            ana_reader.read_rows(
                AN.LAPS_TABLE, season, round_, tuple(AN.ROW_MODELS["laps"].model_fields)
            ),
        )
        rc = AN.to_view(
            "race_control",
            season,
            round_,
            coverage,
            ana_reader.read_rows(
                AN.RACE_CONTROL_TABLE,
                season,
                round_,
                tuple(AN.ROW_MODELS["race_control"].model_fields),
            ),
        )
    except (EN.EntrantsDataError, AN.AnalysisDataError) as exc:
        raise ArchiveError(f"{season} R{round_}: {exc}") from exc
    if not isinstance(laps, AnalysisLapsOut) or not isinstance(rc, AnalysisRaceControlsOut):
        raise ArchiveError(f"{season} R{round_}: unexpected analysis models")
    return DisplayRows(entrants, track_laps(laps), list(rc.rows), coverage.is_synthetic)


def model_info(model_dir: Path) -> ModelInfo:
    status = ModelStatus.load(model_dir)
    if not status.ok or status.scorer_sha256 is None or status.g is None or status.k is None:
        raise RefusedError(f"deployment model not usable: {status.error}")
    return ModelInfo(
        version=status.model_version,
        scorer_sha256=status.scorer_sha256,
        feature_set=status.feature_set,
        g=status.g,
        k=status.k,
        git_sha=status.git_sha,
        git_dirty=status.git_dirty,
        created_utc=status.created_utc,
    )


def builder_info() -> BuilderInfo:
    """The repo's git sha (``F1SA_GIT_SHA`` in the container, else ``git``); null if unknown."""
    from f1sa.model.deploy import DeployError, git_info

    try:
        git = git_info()
    except DeployError:
        return BuilderInfo(git_sha=None, git_dirty=None)
    return BuilderInfo(git_sha=git.sha, git_dirty=git.dirty)


# ============================================================================== one race
def build_bundle(
    spark: SparkSession,
    settings: Settings,
    season: int,
    round_: int,
    *,
    model_dir: Path,
    source: str,
    allow_test_season: bool = False,
    model: ModelInfo | None = None,
    builder: BuilderInfo | None = None,
) -> ArchiveBundle:
    """The validated bundle of one race (nothing is written)."""
    from f1sa.streaming.stream_job import JobError, load_model

    check_test_season(season, allow_test_season)
    lake = spark_uri(settings.data_lake_uri)
    try:
        scorer, params, _meta = load_model(model_dir)
    except JobError as exc:
        raise RefusedError(str(exc)) from exc
    hint = "make features-sample" if source == "sample" else "make pipeline-full"
    try:
        inputs = load_race_inputs(spark, settings.data_lake_uri, season, round_)
        priors = load_priors(
            spark, settings.data_lake_uri, season, round_, allow_test_season=allow_test_season
        )
    except (ProducerError, PriorsError) as exc:
        raise ArchiveError(f"{season} R{round_}: {exc}; run {hint} first") from exc
    info = race_info(spark, lake, season, round_)
    shown = display_rows(
        settings, season, round_, allow_test_season=allow_test_season, source=source
    )
    rep = replay_race(
        inputs,
        priors,
        scorer,
        params,
        start_ms=start_ms_of(info["race_start_utc"], info["race_date"]),
        settings=settings,
        n_partitions=N_PARTITIONS,
        allow_test_season=allow_test_season,
    )
    bundle = ArchiveBundle(
        schema_version=1,
        meta=BundleMeta(
            season=season,
            round=round_,
            race_name=info["race_name"],
            circuit_name=info["circuit_name"],
            race_date=_iso(info["race_date"]),
            race_start_utc=_iso(info["race_start_utc"]),
            laps=rep.snapshots[-1].lap,
            synthetic=shown.synthetic,
            source="sample" if source == "sample" else "lake",
            n_partitions=N_PARTITIONS,
            model=model or model_info(model_dir),
            builder=builder or builder_info(),
        ),
        entrants=shown.entrants,
        snapshots=rep.snapshots,
        messages=rep.messages,
        decisions=rep.decisions,
        track=shown.track,
        race_control=shown.race_control,
    )
    return bundle


def write_bundle(settings: Settings, bundle: ArchiveBundle) -> BuiltRace:
    """Encode, check by decoding back, then write bundle + manifest atomically."""
    s, r = bundle.meta.season, bundle.meta.round
    raw, gz = encode_bundle(bundle)
    if decode_bundle(gz) != bundle:
        raise ArchiveError(f"{s} R{r}: the encoded bundle does not decode to itself")
    sha = hashlib.sha256(gz).hexdigest()
    uri = check_archive_uri(archive_partition_uri(settings, s, r), settings)
    sink: FileSink | HdfsSink = (
        FileSink(uri) if uri.startswith("file://") else HdfsSink(uri, settings)
    )
    sink.cleanup_temp()
    sink.write_bytes(BUNDLE_NAME, gz)
    manifest = manifest_for(bundle, raw, gz, sha)
    sink.write_manifest(manifest.model_dump(mode="json"))
    return BuiltRace(
        season=s,
        round=r,
        laps=bundle.meta.laps,
        n_messages=manifest.n_messages,
        n_alerts=manifest.n_alerts,
        n_decisions=manifest.n_decisions,
        raw_bytes=len(raw),
        size_bytes=len(gz),
        sha256=sha,
        uri=uri,
    )


# ============================================================================== all races
def run_build(
    spark: SparkSession,
    settings: Settings,
    *,
    source: str,
    model_dir: Path,
    allow_test_season: bool = False,
    season: int | None = None,
    round_: int | None = None,
    out: Callable[[str], None] = print,
) -> tuple[list[BuiltRace], list[str]]:
    """Build every selected race; returns the built races and the failures (race: reason)."""
    check_source(settings, source)
    if season is not None:
        check_test_season(season, allow_test_season)
    races = list_races(settings, allow_test_season=allow_test_season, season=season, round_=round_)
    if not races:
        raise RefusedError("no race in the clean laps matches the selection")
    model, builder = model_info(model_dir), builder_info()
    built: list[BuiltRace] = []
    failed: list[str] = []
    for s, r in races:
        try:
            bundle = build_bundle(
                spark,
                settings,
                s,
                r,
                model_dir=model_dir,
                source=source,
                allow_test_season=allow_test_season,
                model=model,
                builder=builder,
            )
            b = write_bundle(settings, bundle)
        except ArchiveError as exc:
            failed.append(f"{s} R{r}: {exc}")
            out(f"FAILED {s} R{r}: {exc}")
            continue
        built.append(b)
        out(
            f"{s} R{r}: {b.laps} laps, {b.n_messages} messages ({b.n_alerts} alerts), "
            f"{b.n_decisions} decisions; {b.raw_bytes:,} B JSON -> {b.size_bytes:,} B gzip "
            f"(sha256 {b.sha256[:12]}...)"
        )
    if built:
        raw = sum(b.raw_bytes for b in built)
        gz = sum(b.size_bytes for b in built)
        sizes = sorted(b.size_bytes for b in built)
        out(
            f"{len(built)} bundles, model {model.version} (scorer {model.scorer_sha256[:12]}...): "
            f"{raw:,} B JSON -> {gz:,} B gzip; per race min {sizes[0]:,} / "
            f"median {sizes[len(sizes) // 2]:,} / max {sizes[-1]:,} B"
        )
    return built, failed


def parse_args(argv: Iterable[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="f1sa-archive-build", description=__doc__.split("\n")[0])
    p.add_argument("--source", choices=("sample", "lake"), required=True)
    p.add_argument("--season", type=int, default=None)
    p.add_argument("--round", type=int, default=None)
    p.add_argument("--model-dir", type=Path, default=None, help="default: API_MODEL_DIR")
    p.add_argument("--allow-test-season", action="store_true")
    p.add_argument("--master", default="local[2]")
    return p.parse_args(list(argv) if argv is not None else None)


def main(
    argv: Sequence[str] | None = None,
    *,
    spark_factory: Callable[[str], SparkSession] | None = None,
) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if args.round is not None and args.season is None:
        print("--round needs --season", file=sys.stderr)
        return 2
    model_dir: Path = args.model_dir or settings.api_model_dir
    try:
        check_source(settings, args.source)
        if args.season is not None:
            check_test_season(args.season, args.allow_test_season)
        if spark_factory is not None:
            spark = spark_factory(args.master)
        else:
            from f1sa.etl.spark import build_spark

            spark = build_spark("f1sa-archive-build", args.master)
        built, failed = run_build(
            spark,
            settings,
            source=args.source,
            model_dir=model_dir,
            allow_test_season=args.allow_test_season,
            season=args.season,
            round_=args.round,
        )
    except RefusedError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    except (ArchiveError, CatalogError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    if failed:
        print(f"{len(failed)} race(s) failed", file=sys.stderr)
        return 1
    print(f"wrote {len(built)} bundle(s) under {ARCHIVE_ZONE}/{ARCHIVE_TABLE}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
