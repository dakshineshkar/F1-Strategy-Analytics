"""One race through the frozen stream code path, captured lap by lap (Feature 4, display only).

The events are the producer's (``streaming.producer.build_events``). They become Kafka source rows
with the parity harness's own builder (``streaming.parity.kafka_batches``, one row per event, the
simulated key partitioner), regrouped into **one micro-batch per leader lap**: from the leader's
first lap-N ``lap`` event up to, not including, the leader's first lap-(N+1) event; the last
batch also carries the ``session_end`` events. Each batch goes to ``StreamProcessor.process_rows``
(the ``foreachBatch`` function), whose ``RedisSink`` writes through the **real**
``serving.redis_store.RaceStore`` into ``MemoryRedis``. After each batch the state is read back
with the API's ``api.state.read_race_state``: the lap-N snapshot is what ``GET /state`` returns
for the Redis the stream leaves at the end of lap N. Alerts, decisions and probabilities are the
processor's own; nothing is re-derived.

Only transport details differ from a live replay, for byte-identical rebuilds:

* event ids are derived instead of random: the digest of ``uuid5(ARCHIVE_NAMESPACE,
  "s:r:index:type:driver:lap")`` with the uuid4 version bits (the event schema accepts only
  canonical uuid4 strings);
* one simulated clock (race start + 180 s + race time of the batch's last event, the
  ``df_jobs`` lap-timestamp convention) stamps ``produced_at_ms`` and feeds the processor's,
  sink's and store's clocks (so ``updated_at`` / ``published_at`` / ``*_ms`` follow it).

The rule, the live features, the scorer and the alert policy read neither, so the decisions and
alerts do not change (micro-batching invariance is tested by the parity suite).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, cast

from f1sa.api.sse import event_id_for
from f1sa.api.state import driver_ids_from_keys, read_race_state, scan_race_keys
from f1sa.archive.memory_redis import MemoryRedis
from f1sa.archive.schema import DecisionOut, MessageOut, SnapshotOut
from f1sa.config import Settings
from f1sa.features.undercut_rule import RuleParams
from f1sa.model.lr_scorer import LRScorer
from f1sa.serving import keys as K
from f1sa.serving.redis_store import RaceStore
from f1sa.streaming.events import UndercutAlert
from f1sa.streaming.live_features import RacePriors
from f1sa.streaming.parity import kafka_batches
from f1sa.streaming.processor import StreamProcessor
from f1sa.streaming.producer import Outgoing, RaceInputs, build_events
from f1sa.streaming.redis_sink import RedisSink

ARCHIVE_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "f1sa:archive-events")
N_PARTITIONS = 3
"""The topic's partition count (``kafka-init``), as in the parity harness."""
START_OFFSET_MS = 180_000
"""``etl.df_jobs.START_OFFSET_S`` (scheduled start to lights out), in ms."""


class ArchiveError(RuntimeError):
    pass


@dataclass
class SimClock:
    """The one simulated clock of a race's archive replay (milliseconds since the epoch)."""

    ms: int = 0

    def read(self) -> int:
        return self.ms

    def now(self) -> datetime:
        return datetime.fromtimestamp(self.ms / 1000, tz=UTC)


def sim_ms(start_ms: int, race_time_s: float) -> int:
    return start_ms + START_OFFSET_MS + round(race_time_s * 1000)


def derived_event_id(name: str) -> str:
    """A canonical uuid4-format id derived from ``name`` (same name, same id)."""
    return str(uuid.UUID(bytes=uuid.uuid5(ARCHIVE_NAMESPACE, name).bytes, version=4))


def deterministic_events(events: Sequence[Outgoing], start_ms: int) -> list[Outgoing]:
    """The events with derived ids and simulated ``produced_at_ms`` (partition kept)."""
    out: list[Outgoing] = []
    for i, o in enumerate(events):
        e = o.event
        name = f"{e.season}:{e.round}:{i}:{e.type}:{e.driver_id or ''}:{e.lap or ''}"
        ev = replace(e, event_id=derived_event_id(name))
        out.append(Outgoing(ev.stamped(sim_ms(start_ms, e.race_time_s)), o.partition))
    return out


@dataclass(frozen=True)
class LapBatch:
    """One micro-batch: the events of leader lap ``lap`` and their Kafka source rows."""

    lap: int
    events: tuple[Outgoing, ...]
    rows: tuple[dict[str, Any], ...]


def lap_batches(events: Sequence[Outgoing], n_partitions: int) -> list[LapBatch]:
    """``events`` (send order) cut at each leader-lap start. Events before the first lap
    crossing (a lap-1 ``pit_in``) join lap 1; ``session_end`` joins the last lap."""
    rows = [b[0] for b in kafka_batches(events, n_partitions, 1)]
    out: list[LapBatch] = []
    cur_lap = 0
    cur_ev: list[Outgoing] = []
    cur_rows: list[dict[str, Any]] = []
    for o, row in zip(events, rows, strict=True):
        e = o.event
        if e.type == "lap" and e.lap is not None and e.lap > cur_lap:
            if cur_lap >= 1:
                out.append(LapBatch(cur_lap, tuple(cur_ev), tuple(cur_rows)))
                cur_ev, cur_rows = [], []
            cur_lap = e.lap
        cur_ev.append(o)
        cur_rows.append(row)
    if cur_ev:
        if cur_lap < 1:
            raise ArchiveError("the race has no lap events")
        out.append(LapBatch(cur_lap, tuple(cur_ev), tuple(cur_rows)))
    return out


def run_inline[T](coro: Coroutine[Any, Any, T]) -> T:
    """Run a coroutine that never suspends (``MemoryRedis`` does no I/O) to completion, inside or
    outside a running event loop."""
    try:
        coro.send(None)
    except StopIteration as stop:
        return cast(T, stop.value)
    coro.close()
    raise ArchiveError("the snapshot read suspended; MemoryRedis must not do I/O")


async def read_snapshot(memory: MemoryRedis, season: int, round_: int, lap: int) -> SnapshotOut:
    """``api.state.read_race_state`` over the stand-in (drivers found by SCAN, as the API does)."""
    view = cast(Any, memory.async_view())
    ids = driver_ids_from_keys(await scan_race_keys(view, season, round_), season, round_)
    state = await read_race_state(view, season, round_, ids)
    return SnapshotOut(
        lap=lap, drivers=state.drivers, order=state.order, tyres=state.tyres, timing=state.timing
    )


@dataclass
class RaceReplay:
    season: int
    round: int
    snapshots: list[SnapshotOut] = field(default_factory=list)
    messages: list[MessageOut] = field(default_factory=list)
    decisions: list[DecisionOut] = field(default_factory=list)
    alerts: list[UndercutAlert] = field(default_factory=list)
    batches: list[LapBatch] = field(default_factory=list)
    memory: MemoryRedis = field(default_factory=MemoryRedis)


def replay_race(
    inputs: RaceInputs,
    priors: RacePriors,
    scorer: LRScorer,
    params: RuleParams,
    *,
    start_ms: int,
    settings: Settings,
    n_partitions: int = N_PARTITIONS,
    allow_test_season: bool = False,
    on_batch: Callable[[LapBatch, SnapshotOut], None] | None = None,
) -> RaceReplay:
    """Replay one race through ``StreamProcessor`` and capture every lap's state."""
    s, r = inputs.season, inputs.round
    clock = SimClock()
    out = RaceReplay(s, r)
    store = RaceStore(cast(Any, out.memory), settings, now=clock.now)
    proc = StreamProcessor(
        scorer=scorer,
        params=params,
        sink=RedisSink(store, clock_ms=clock.read),
        priors_loader=lambda _s, _r: priors,
        n_partitions=n_partitions,
        allow_test_season=allow_test_season,
        keep_decisions=True,
        clock_ms=clock.read,
    )
    events = deterministic_events(build_events(inputs, n_partitions), start_ms)
    out.batches = lap_batches(events, n_partitions)
    channel = K.events_channel(s, r)
    for batch_id, batch in enumerate(out.batches):
        clock.ms = max(o.event.produced_at_ms or 0 for o in batch.events)
        n_pub, n_dec = len(out.memory.published), len(proc.decisions)
        proc.process_rows(list(batch.rows), batch_id)
        for ch, raw in out.memory.published[n_pub:]:
            if ch != channel:
                raise ArchiveError(f"published on {ch!r}, expected {channel!r}")
            msg = json.loads(raw)
            out.messages.append(
                MessageOut(lap=batch.lap, event_id=event_id_for(raw, msg), message=msg)
            )
        out.decisions.extend(
            DecisionOut(
                evaluated_lap=batch.lap,
                decision_lap=d.decision_lap,
                attacker_id=d.attacker_id,
                defender_id=d.defender_id,
                gap_s=d.gap_s,
                probability=d.probability,
            )
            for d in proc.decisions[n_dec:]
        )
        snap = run_inline(read_snapshot(out.memory, s, r, batch.lap))
        out.snapshots.append(snap)
        if on_batch is not None:
            on_batch(batch, snap)
    if not proc.ended(s, r):
        raise ArchiveError(f"{s} R{r}: the stream did not reach session_end")
    if proc.counters.malformed or proc.counters.refused_test_season or proc.counters.after_end:
        raise ArchiveError(f"{s} R{r}: processor counters {proc.counters.to_json()}")
    out.alerts = list(proc.alerts)
    return out
