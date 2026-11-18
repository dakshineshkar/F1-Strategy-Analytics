"""Proof that a stored post-race bundle is what a live replay produces (Feature 4).

    python -m f1sa.archive.equivalence --season 2024 --round 5 --laps 5,22,45 [--model-dir D]

Three checks on the **stored** bundle (the bytes the API serves; sha256 checked against the
manifest):

1. **Rebuild.** The same race through ``archive.replay.replay_race`` again gives exactly the
   bundle's snapshots, messages and decisions (the bundle is reproducible from this code and lake).
2. **Stream parity.** An independent run of the parity harness (``streaming.parity``: the
   producer's events with random ids in micro-batches of 50 with partition 0 lagging, into a
   ``NullStore``) publishes the same alerts (reason, trigger, pair, decision lap, gap, P, the 21
   inputs) and scores the same decisions; ``parity.check_alerts`` and ``parity.compare_race``
   pass against the batch tables (Spark ``PipelineModel`` + ``Calibrator``). Counts by trigger
   are printed (sample 2024 R5 with the deployed model: 113 / 19 / 9).
3. **Controlled live replay** (skipped with ``--skip-live``). The real stream job
   (``streaming.stream_job``: Spark Structured Streaming on the Kafka topic, ``RedisSink`` into the
   real Redis) runs as a subprocess. The producer's events are sent through Kafka
   (``producer.KafkaSender``) up to the end of each lap given by ``--laps``. Once the Pub/Sub
   subscriber has received every lap / pit message sent so far (the sink writes a batch's hashes
   and order before its PUBLISH, in one pipeline), Redis is read with the API's
   ``read_race_state``. Every driver hash (9 fields), tyre hash and the order must equal the
   bundle's snapshot of that lap. ``updated_at`` is excluded because it is wall clock. After
   ``session_end`` the final state and every published message (lap, pit, alerts, without ids and
   timing fields) must equal the bundle's.

The live check refuses while ``GET /api/replays`` lists a running replay (it would share the
topic and the race keys), and when that answer cannot be read. Existing ``race:{s}:{r}:*`` keys of
a finished replay are reported, never deleted: the first lap rewrites every car's keys, and the
check fails if a key the bundle does not have remains. It writes only
``data/checkpoints/demo_<S>_<R>_<unix>[.ready]``, ``data/demo/<run_id>/`` (``make demo-clean``
removes both) and the race's Redis keys (safety TTL, then the ``session_end`` EXPIRE).

Exit 0: every check passed; 1: a mismatch or a failure; 2: refused.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from f1sa.api.models import RaceStateOut
from f1sa.archive.replay import (
    N_PARTITIONS,
    ArchiveError,
    lap_batches,
    replay_race,
)
from f1sa.archive.schema import (
    BUNDLE_NAME,
    MANIFEST_NAME,
    TABLE,
    ArchiveBundle,
    ArchiveFormatError,
    SnapshotOut,
    decode_bundle,
    parse_manifest,
)
from f1sa.config import Settings, get_settings
from f1sa.features.undercut_rule import RuleParams
from f1sa.model.lr_scorer import LRScorer
from f1sa.serving import keys as K
from f1sa.streaming.live_features import RacePriors
from f1sa.streaming.processor import SEALED_SEASON, StreamProcessor
from f1sa.streaming.producer import Outgoing, RaceInputs, build_events

VOLATILE_PAYLOAD = frozenset(
    {
        "event_id",
        "produced_at_ms",
        "batch_received_at_ms",
        "redis_written_at_ms",
        "trigger_event_id",
    }
)
"""Transport ids and wall-clock timing fields of a published payload (not compared)."""
VOLATILE_MESSAGE = frozenset({"published_at", "event_ts", "event_id", "sse_sent_at_ms"})
COUNTED_TYPES = ("lap", "pit_in", "pit_out")
"""Message types published once per event sent (the live check counts them)."""


class EquivalenceError(RuntimeError):
    pass


class Refused(RuntimeError):
    pass


# ============================================================================== comparisons
def comparable_message(message: Mapping[str, Any]) -> str:
    """A message without ids and timing fields, as canonical JSON."""
    payload = message.get("payload")
    body = {k: v for k, v in message.items() if k not in VOLATILE_MESSAGE}
    if isinstance(payload, Mapping):
        body["payload"] = {k: v for k, v in payload.items() if k not in VOLATILE_PAYLOAD}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False)


def alert_payloads(bundle: ArchiveBundle) -> list[dict[str, Any]]:
    return [m.message["payload"] for m in bundle.messages if m.message["type"] == "undercut_alert"]


def alert_key(a: Mapping[str, Any]) -> str:
    keep = (
        "reason",
        "trigger",
        "season",
        "round",
        "attacker_id",
        "defender_id",
        "decision_lap",
        "gap_s",
        "undercut_prob",
        "threshold",
        "inputs",
    )
    return json.dumps({k: a.get(k) for k in keep}, sort_keys=True, allow_nan=False)


def trigger_counts(alerts: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    c = Counter(str(a["trigger"]) for a in alerts)
    return {t: c.get(t, 0) for t in ("new_candidate", "probability_crossed", "pit_in")}


def decision_keys(rows: Iterable[Any]) -> Counter[tuple[int, str, str, float, float]]:
    return Counter(
        (int(d.decision_lap), d.attacker_id, d.defender_id, float(d.gap_s), float(d.probability))
        for d in rows
    )


def comparable_state(state: SnapshotOut | RaceStateOut) -> dict[str, Any]:
    """Drivers (9 fields), tyres and order without ``updated_at`` (wall clock when live)."""
    return {
        "drivers": {
            d: s.model_dump(mode="json", exclude={"updated_at"})
            for d, s in sorted(state.drivers.items())
        },
        "tyres": {
            d: t.model_dump(mode="json", exclude={"updated_at"})
            for d, t in sorted(state.tyres.items())
        },
        "order": [o.model_dump(mode="json") for o in state.order],
    }


def state_diff(expected: SnapshotOut | RaceStateOut, got: SnapshotOut | RaceStateOut) -> list[str]:
    """Field-level differences (empty when equal)."""
    e, g = comparable_state(expected), comparable_state(got)
    out: list[str] = []
    for part in ("drivers", "tyres"):
        for d in sorted(set(e[part]) | set(g[part])):
            if d not in g[part]:
                out.append(f"{part}.{d}: missing")
            elif d not in e[part]:
                out.append(f"{part}.{d}: unexpected")
            else:
                for f in sorted(set(e[part][d]) | set(g[part][d])):
                    if e[part][d].get(f) != g[part][d].get(f):
                        out.append(
                            f"{part}.{d}.{f}: {e[part][d].get(f)!r} != {g[part][d].get(f)!r}"
                        )
    if e["order"] != g["order"]:
        out.append(f"order: {e['order'][:3]}... != {g['order'][:3]}...")
    return out


# ============================================================================== 1 + 2
def stored_bundle(settings: Settings, season: int, round_: int, *, allow: bool) -> ArchiveBundle:
    from f1sa.api.catalog import archive_reader

    reader = archive_reader(settings, allow_test_season=allow)
    m_raw = reader.read_file(TABLE, season, round_, MANIFEST_NAME)
    gz = reader.read_file(TABLE, season, round_, BUNDLE_NAME)
    if m_raw is None or gz is None:
        raise Refused(
            f"no stored bundle for {season} R{round_}: run make archive-sample / archive-full"
        )
    manifest = parse_manifest(m_raw)
    if hashlib.sha256(gz).hexdigest() != manifest.sha256:
        raise EquivalenceError("the stored bundle does not match its manifest sha256")
    return decode_bundle(gz)


def start_ms_from_meta(bundle: ArchiveBundle) -> int:
    from f1sa.archive.build import start_ms_of

    m = bundle.meta
    start = datetime.fromisoformat(m.race_start_utc) if m.race_start_utc else None
    day = datetime.fromisoformat(m.race_date).date() if m.race_date else None
    return start_ms_of(start, day)


def rebuild_problems(
    bundle: ArchiveBundle,
    inputs: RaceInputs,
    priors: RacePriors,
    scorer: LRScorer,
    params: RuleParams,
    settings: Settings,
    allow: bool,
) -> list[str]:
    rep = replay_race(
        inputs,
        priors,
        scorer,
        params,
        start_ms=start_ms_from_meta(bundle),
        settings=settings,
        n_partitions=bundle.meta.n_partitions,
        allow_test_season=allow,
    )
    out = []
    if rep.snapshots != bundle.snapshots:
        out.append("rebuild: snapshots differ")
    if rep.messages != bundle.messages:
        out.append("rebuild: messages differ")
    if rep.decisions != bundle.decisions:
        out.append("rebuild: decisions differ")
    return out


def parity_processor(
    inputs: RaceInputs,
    priors: RacePriors,
    scorer: LRScorer,
    params: RuleParams,
    *,
    batch_size: int = 50,
    lag_partition: int | None = 0,
    n_partitions: int = N_PARTITIONS,
    allow: bool = False,
) -> StreamProcessor:
    """The parity harness's replay of one race (random ids, ``NullStore``)."""
    from f1sa.streaming import parity as PT
    from f1sa.streaming.redis_sink import RedisSink

    proc = StreamProcessor(
        scorer=scorer,
        params=params,
        sink=RedisSink(PT.NullStore()),
        priors_loader=lambda _s, _r: priors,
        n_partitions=n_partitions,
        allow_test_season=allow,
        keep_decisions=True,
    )
    events = build_events(inputs, n_partitions)
    PT.replay_into(
        proc, PT.kafka_batches(events, n_partitions, batch_size, lag_partition=lag_partition)
    )
    if not proc.ended(inputs.season, inputs.round):
        raise EquivalenceError("the parity replay did not reach session_end")
    return proc


def parity_problems(bundle: ArchiveBundle, proc: StreamProcessor) -> list[str]:
    out = []
    mine = Counter(alert_key(a) for a in alert_payloads(bundle))
    theirs = Counter(alert_key(a.to_dict()) for a in proc.alerts)
    if mine != theirs:
        out.append(
            f"alerts differ: {sum((mine - theirs).values())} only in the bundle, "
            f"{sum((theirs - mine).values())} only in the parity run"
        )
    if decision_keys(bundle.decisions) != decision_keys(proc.decisions):
        out.append("decisions differ from the parity run")
    return out


def batch_problems(
    spark: Any,
    settings: Settings,
    model_dir: Path,
    params: RuleParams,
    proc: StreamProcessor,
    season: int,
    round_: int,
) -> tuple[list[str], dict[str, int]]:
    """``parity.check_alerts`` and ``parity.compare_race`` against the batch tables."""
    from pyspark.ml import PipelineModel
    from pyspark.sql import functions as F

    from f1sa.etl.clean import spark_uri
    from f1sa.model.calibrate import Calibrator
    from f1sa.model.dataset import read_feature_seasons, with_derived_inputs
    from f1sa.streaming import parity as PT

    meta = json.loads((model_dir / "lr" / "metadata.json").read_text(encoding="utf-8"))
    g, k = float(meta["g"]), int(meta["k"])
    features = f"{spark_uri(settings.data_lake_uri)}/features"
    ft = {
        t: read_feature_seasons(spark, features, t, (season,)).where(
            (F.col("season") == season) & (F.col("round") == round_)
        )
        for t in (
            "laps_enriched",
            "pit_loss",
            "undercut_attempts",
            "stints",
            "telemetry_lap_features",
        )
    }
    attempts = with_derived_inputs(
        ft["undercut_attempts"], ft["stints"], ft["telemetry_lap_features"]
    ).cache()
    labelled = PT.labelled_rows(attempts, g, k)
    sel = attempts.where(
        (F.col("gap_threshold_s") == F.lit(g))
        & (F.col("response_window_laps") == F.lit(k))
        & F.col("outcome_category").isin("success", "fail")
    )
    lr = model_dir / "lr"
    cal = Calibrator.from_json(json.loads((lr / "calibrator.json").read_text(encoding="utf-8")))
    probs = PT.batch_probabilities(PipelineModel.load(str(lr / "pipeline")), cal, sel)
    race = PT.batch_race_data(ft["laps_enriched"], ft["pit_loss"])[(season, round_)]
    pairs = PT.batch_eligible(race, params)
    flagged = PT.eligible_attempts(ft["undercut_attempts"], g).get((season, round_), set())
    check = PT.check_alerts(
        (season, round_),
        proc.alerts,
        proc.decisions,
        pairs,
        flagged,
        labelled,
        proc.alert_threshold,
    )
    rep = PT.compare_race((season, round_), pairs, proc.decisions, labelled, probs)
    attempts.unpersist()
    out = [f"check_alerts: {p}" for p in check.problems]
    if not rep.ok:
        out.append(f"compare_race: {json.dumps(rep.summary())}")
    return out, {
        "batch_eligible_pairs": rep.batch_pairs,
        "stream_eligible_pairs": rep.stream_pairs,
        "labelled_attempts": rep.labelled,
    }


# ============================================================================== 3: live
class Collector:
    """Every message on the race channel, from a dedicated Redis connection (own thread)."""

    def __init__(self, redis_url: str, season: int, round_: int) -> None:
        import redis

        self._client = redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=10)
        self._pubsub = self._client.pubsub()  # type: ignore[no-untyped-call]
        self._pubsub.subscribe(K.events_channel(season, round_))
        self.messages: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            msg = self._pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
            if msg is None or msg.get("type") != "message":
                continue
            with self._lock:
                self.messages.append(json.loads(msg["data"]))

    def count(self, types: Sequence[str]) -> int:
        with self._lock:
            return sum(1 for m in self.messages if m.get("type") in types)

    def has(self, types: Sequence[str], n: int) -> Callable[[], bool]:
        """A condition: at least ``n`` messages of ``types`` received."""
        return lambda: self.count(types) >= n

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.messages)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        self._pubsub.close()
        self._client.close()


def wait_until(
    cond: Callable[[], bool], timeout_s: float, what: str, *, poll_s: float = 0.2
) -> None:
    deadline = time.monotonic() + timeout_s
    while not cond():
        if time.monotonic() > deadline:
            raise EquivalenceError(f"timed out after {timeout_s:.0f} s waiting for {what}")
        time.sleep(poll_s)


async def _read_live(redis_url: str, season: int, round_: int) -> RaceStateOut:
    import redis.asyncio as aioredis

    from f1sa.api.state import driver_ids_from_keys, read_race_state, scan_race_keys

    client = aioredis.Redis.from_url(redis_url, decode_responses=True)
    try:
        ids = driver_ids_from_keys(await scan_race_keys(client, season, round_), season, round_)
        return await read_race_state(client, season, round_, ids)
    finally:
        await client.aclose()


def read_live_state(redis_url: str, season: int, round_: int) -> RaceStateOut:
    """Redis now, read exactly as ``GET /state`` reads it."""
    return asyncio.run(_read_live(redis_url, season, round_))


def check_no_running_replay(api_url: str, out: Callable[[str], None]) -> None:
    from f1sa.replay_guard import Unreachable, Unverified, http_get, parse_running

    try:
        running = parse_running(http_get(api_url.rstrip("/") + "/api/replays", 3.0))
    except Unreachable:
        out(f"replay check: no api at {api_url}; no API replay can be running")
        return
    except Unverified as exc:
        raise Refused(f"cannot tell whether a replay is running ({exc})") from exc
    if running:
        names = ", ".join(r.describe() for r in running)
        raise Refused(f"a replay is running ({names}); wait until GET /api/replays shows none")
    out("replay check: no replay running")


def lap_groups(events: Sequence[Outgoing], n_partitions: int) -> list[tuple[int, list[Outgoing]]]:
    """The live run's events cut at the same leader-lap boundaries as the bundle's micro-batches."""
    return [(b.lap, list(b.events)) for b in lap_batches(events, n_partitions)]


def _kill_group(job: subprocess.Popen[str]) -> None:
    from f1sa.streaming.demo import stop_job

    stop_job(job, timeout_s=60)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(job.pid, signal.SIGKILL)


def _verdict(diff: Sequence[str]) -> str:
    return "==" if not diff else f"!= ({len(diff)} differences)"


@dataclass
class LiveReport:
    checks: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    existing_keys: int = 0
    messages: dict[str, int] = field(default_factory=dict)


def live_check(
    settings: Settings,
    bundle: ArchiveBundle,
    inputs: RaceInputs,
    *,
    model_dir: Path,
    laps: Sequence[int],
    allow: bool,
    timeout_s: float = 600.0,
    out: Callable[[str], None] = print,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ivy_dir: Path | None = None,
) -> LiveReport:
    from confluent_kafka import Producer

    from f1sa.demo_runs import run_id
    from f1sa.serving.redis_store import RaceStore
    from f1sa.streaming.demo import check_services, job_command, wait_ready
    from f1sa.streaming.producer import KafkaProducerLike, KafkaSender, producer_config
    from f1sa.streaming.redis_sink import now_ms

    s, r = bundle.meta.season, bundle.meta.round
    report = LiveReport()
    n = check_services(settings)
    report.existing_keys = len(RaceStore.from_settings(settings, socket_timeout=5).race_keys(s, r))
    if report.existing_keys:
        out(f"note: {report.existing_keys} race:{s}:{r}:* keys of an earlier replay exist (kept)")
    snaps = {x.lap: x for x in bundle.snapshots}
    groups = lap_groups(build_events(inputs, n), n)
    if [g[0] for g in groups] != [x.lap for x in bundle.snapshots]:
        raise EquivalenceError("the live run's leader laps differ from the bundle's snapshots")
    name = f"demo_{s}_{r}_{int(time.time())}"
    checkpoint = Path("data/checkpoints") / name
    ready = Path("data/checkpoints") / f"{name}.ready"
    results = settings.demo_dir / run_id(s, r, now())
    results.mkdir(parents=True, exist_ok=True)
    cmd = [
        *job_command(s, r, checkpoint, ready, results, timeout_s),
        "--model-dir",
        str(model_dir),
        *(["--allow-test-season"] if allow else []),
        *(["--ivy-dir", str(ivy_dir)] if ivy_dir is not None else []),
    ]
    collector = Collector(settings.redis_url, s, r)
    log_path = results / "stream_job.log"
    with log_path.open("w", encoding="utf-8") as log_fh:
        job = subprocess.Popen(
            cmd, stdout=log_fh, stderr=subprocess.STDOUT, text=True, start_new_session=True
        )
        try:
            wait_ready(job, ready, 300)
            out(f"stream job ready (checkpoint {checkpoint}, log {log_path})")
            producer: KafkaProducerLike = Producer(  # type: ignore[assignment]
                producer_config(settings.kafka_bootstrap)
            )
            sender = KafkaSender(producer, settings.kafka_topic_events)
            sent = 0
            for lap, events in groups:
                for o in events:
                    sender(Outgoing(o.event.stamped(now_ms()), o.partition))
                    sent += o.event.type in COUNTED_TYPES
                if lap in laps and lap != groups[-1][0]:
                    sender.producer.flush(30)
                    wait_until(collector.has(COUNTED_TYPES, sent), timeout_s, f"lap {lap}")
                    diff = state_diff(snaps[lap], read_live_state(settings.redis_url, s, r))
                    report.checks.append({"lap": lap, "ok": not diff, "diff": diff[:20]})
                    out(f"lap {lap}: Redis {_verdict(diff)} bundle snapshot")
            sender.close()
            wait_until(collector.has(("session_end",), 1), timeout_s, "session_end")
            rc = job.wait(timeout=timeout_s)
            if rc != 0:
                report.problems.append(f"the stream job exited with {rc} (log {log_path})")
        finally:
            _kill_group(job)
            collector.close()
    last = bundle.snapshots[-1]
    diff = state_diff(last, read_live_state(settings.redis_url, s, r))
    report.checks.append({"lap": last.lap, "final": True, "ok": not diff, "diff": diff[:20]})
    out(f"final (lap {last.lap}, after session_end): Redis {_verdict(diff)} bundle")
    live = Counter(comparable_message(m) for m in collector.snapshot())
    mine = Counter(comparable_message(m.message) for m in bundle.messages)
    report.messages = dict(Counter(str(m.get("type")) for m in collector.snapshot()))
    if live != mine:
        report.problems.append(
            f"published messages differ: {sum((mine - live).values())} only in the bundle, "
            f"{sum((live - mine).values())} only live"
        )
    report.problems += [f"lap {c['lap']}: {c['diff'][:3]}" for c in report.checks if not c["ok"]]
    return report


# ============================================================================== CLI
def parse_laps(text: str) -> tuple[int, ...]:
    laps = tuple(sorted({int(x) for x in text.split(",") if x.strip()}))
    if not laps or laps[0] < 1:
        raise argparse.ArgumentTypeError(f"--laps needs lap numbers >= 1, got {text!r}")
    return laps


def parse_args(argv: Iterable[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="f1sa-archive-equivalence", description=__doc__.split("\n")[0])
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--laps", type=parse_laps, required=True, help="e.g. 5,22,45 (at least 3)")
    p.add_argument("--model-dir", type=Path, default=None, help="default: API_MODEL_DIR")
    p.add_argument("--api", default=os.environ.get("API_GUARD_URL", "http://127.0.0.1:8000"))
    p.add_argument("--skip-live", action="store_true", help="only checks 1 and 2")
    p.add_argument("--allow-test-season", action="store_true")
    p.add_argument("--timeout-s", type=float, default=600.0)
    p.add_argument("--master", default="local[2]")
    return p.parse_args(list(argv) if argv is not None else None)


def run(
    args: argparse.Namespace,
    settings: Settings,
    *,
    spark_factory: Callable[[str], Any] | None = None,
    out: Callable[[str], None] = print,
    ivy_dir: Path | None = None,
) -> dict[str, Any]:
    from f1sa.streaming.priors import load_priors
    from f1sa.streaming.producer import load_race_inputs
    from f1sa.streaming.stream_job import JobError, load_model

    s, r, allow = args.season, args.round, args.allow_test_season
    if s == SEALED_SEASON and not allow:
        raise Refused(f"season {s} is the sealed test season; pass --allow-test-season")
    if len(args.laps) < 3:
        raise Refused("--laps needs at least 3 laps")
    model_dir: Path = args.model_dir or settings.api_model_dir
    try:
        scorer, params, _ = load_model(model_dir)
    except JobError as exc:
        raise Refused(str(exc)) from exc
    bundle = stored_bundle(settings, s, r, allow=allow)
    sha = hashlib.sha256((model_dir / "lr" / "scorer.json").read_bytes()).hexdigest()
    if sha != bundle.meta.model.scorer_sha256:
        raise Refused(
            f"the bundle was built with scorer {bundle.meta.model.scorer_sha256[:12]}..., "
            f"{model_dir} has {sha[:12]}...; pass the bundle's --model-dir"
        )
    bad_laps = [lap for lap in args.laps if lap not in {x.lap for x in bundle.snapshots}]
    if bad_laps:
        raise Refused(
            f"laps {bad_laps} are not snapshot laps of the bundle (1..{bundle.meta.laps})"
        )
    if spark_factory is not None:
        spark = spark_factory(args.master)
    else:
        from f1sa.etl.spark import build_spark

        spark = build_spark("f1sa-archive-equivalence", args.master)
    inputs = load_race_inputs(spark, settings.data_lake_uri, s, r)
    priors = load_priors(spark, settings.data_lake_uri, s, r, allow_test_season=allow)
    report: dict[str, Any] = {"season": s, "round": r, "model": bundle.meta.model.version}
    problems = rebuild_problems(bundle, inputs, priors, scorer, params, settings, allow)
    out(f"1. rebuild: {problems or 'identical'}")
    proc = parity_processor(inputs, priors, scorer, params, allow=allow)
    p2 = parity_problems(bundle, proc)
    batch, counts = batch_problems(spark, settings, model_dir, params, proc, s, r)
    by_trigger = trigger_counts(alert_payloads(bundle))
    report.update(
        alerts=sum(by_trigger.values()),
        alerts_by_trigger=by_trigger,
        decisions=len(bundle.decisions),
        **counts,
    )
    verdict = p2 + batch or "equal to the parity run; check_alerts and compare_race OK"
    out(
        f"2. stream parity: bundle alerts {by_trigger} ({sum(by_trigger.values())}), "
        f"{len(bundle.decisions)} decisions, "
        f"batch eligible pairs {counts['batch_eligible_pairs']}, "
        f"labelled {counts['labelled_attempts']}: {verdict}"
    )
    problems += p2 + batch
    if spark_factory is None:
        spark.stop()  # free the JVM before the stream job starts its own
    if not args.skip_live:
        check_no_running_replay(args.api, out)
        live = live_check(
            settings,
            bundle,
            inputs,
            model_dir=model_dir,
            laps=args.laps,
            allow=allow,
            timeout_s=args.timeout_s,
            out=out,
            ivy_dir=ivy_dir,
        )
        report.update(
            live_checks=live.checks, live_messages=live.messages, existing_keys=live.existing_keys
        )
        problems += live.problems
        ok = "every checked lap, the final state and every message equal"
        out(f"3. live replay: {live.problems or ok}")
    report["problems"] = problems
    report["ok"] = not problems
    return report


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    settings = get_settings()
    try:
        report = run(args, settings)
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    except (EquivalenceError, ArchiveError, ArchiveFormatError) as exc:
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({k: v for k, v in report.items() if k != "live_checks"}, sort_keys=True))
    print("EQUIVALENT" if report["ok"] else "NOT EQUIVALENT")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
