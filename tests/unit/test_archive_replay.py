"""``archive.replay``: one race through the frozen stream path (no Spark; hand-built scenarios).

* micro-batches cut at the leader's lap starts, nothing lost or reordered;
* derived ids and the simulated clock are deterministic, and nothing else changes: the alerts
  and decisions equal plain processor runs at other micro-batchings (sizes 1 and 7 with a
  lagging partition, random ids, wall clock);
* every lap snapshot equals what an independent batch-size-1 replay through the real
  ``RaceStore`` on fakeredis leaves in Redis at the end of that lap (read by the API's reader).
"""

from __future__ import annotations

import json
import uuid
from collections import Counter
from datetime import UTC, datetime

import pytest
from _archive_fixtures import (
    SCENARIO,
    SCENARIO_LAPPED,
    START_MS,
    live_like_states,
    priors_for,
    scenario_replay,
)
from _stream_fixtures import scenario_inputs, scorer

from f1sa.api.sse import event_id_for
from f1sa.archive.equivalence import comparable_state, state_diff
from f1sa.archive.replay import (
    ArchiveError,
    SimClock,
    derived_event_id,
    deterministic_events,
    lap_batches,
    sim_ms,
)
from f1sa.features.undercut_rule import RuleParams
from f1sa.streaming import parity as PT
from f1sa.streaming.events import RaceEvent
from f1sa.streaming.processor import StreamProcessor
from f1sa.streaming.producer import Outgoing, build_events
from f1sa.streaming.redis_sink import RedisSink


def _ev(t: float, kind: str, driver: str | None, lap: int | None) -> Outgoing:
    return Outgoing(
        RaceEvent(str(uuid.uuid4()), kind, 2023, 1, t, driver_id=driver, lap=lap),
        0 if kind == "session_end" else None,
    )


# ------------------------------------------------------------------ micro-batches
def test_batches_start_at_each_leader_lap_and_keep_every_event_in_order() -> None:
    events = build_events(scenario_inputs(SCENARIO), 3)
    batches = lap_batches(events, 3)
    flat = [o for b in batches for o in b.events]
    assert flat == events
    assert [b.lap for b in batches] == sorted({b.lap for b in batches})
    seen = 0
    for b in batches:
        laps = [o.event.lap for o in b.events if o.event.type == "lap"]
        assert laps and laps[0] == b.lap == max(laps) and b.lap > seen  # opens with the leader
        seen = b.lap
        assert len(b.rows) == len(b.events)
    assert all(o.event.type == "session_end" for o in batches[-1].events[-3:])
    assert not any(o.event.type == "session_end" for b in batches[:-1] for o in b.events)


def test_a_pit_in_before_the_first_crossing_joins_lap_1_and_no_laps_is_an_error() -> None:
    events = [
        _ev(90.0, "pit_in", "a", 1),
        _ev(90.0, "lap", "a", 1),
        _ev(91.0, "lap", "b", 1),
        _ev(180.0, "lap", "b", 2),
        _ev(181.0, "session_end", None, 2),
    ]
    batches = lap_batches(events, 1)
    assert [(b.lap, [o.event.type for o in b.events]) for b in batches] == [
        (1, ["pit_in", "lap", "lap"]),
        (2, ["lap", "session_end"]),
    ]
    with pytest.raises(ArchiveError, match="no lap events"):
        lap_batches([_ev(1.0, "session_end", None, None)], 1)


# ------------------------------------------------------------------ determinism
def test_derived_ids_are_uuid4_shaped_unique_and_stable() -> None:
    events = build_events(scenario_inputs(SCENARIO), 3)
    a, b = deterministic_events(events, START_MS), deterministic_events(events, START_MS)
    ids = [o.event.event_id for o in a]
    assert ids == [o.event.event_id for o in b] and len(set(ids)) == len(ids)
    assert all(uuid.UUID(i).version == 4 and str(uuid.UUID(i)) == i for i in ids)
    assert derived_event_id("x") == derived_event_id("x") != derived_event_id("y")
    assert [o.partition for o in a] == [o.partition for o in events]
    for o, src in zip(a, events, strict=True):
        assert o.event.produced_at_ms == START_MS + 180_000 + round(src.event.race_time_s * 1000)
        assert o.event == src.event.stamped(o.event.produced_at_ms).__class__(
            **{**src.event.to_dict(), "event_id": o.event.event_id,
               "produced_at_ms": o.event.produced_at_ms}
        )  # fmt: skip


def test_the_clock_is_simulated_and_a_rebuild_is_identical() -> None:
    _inputs, _priors, one = scenario_replay()
    _inputs, _priors, two = scenario_replay()
    assert one.snapshots == two.snapshots and one.messages == two.messages
    assert one.decisions == two.decisions
    for batch, snap in zip(one.batches, one.snapshots, strict=True):
        ms = max(o.event.produced_at_ms or 0 for o in batch.events)
        stamp = SimClock(ms).now().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        assert stamp in {d.updated_at for d in snap.drivers.values()}
    assert sim_ms(START_MS, 0.0) == START_MS + 180_000
    assert SimClock(START_MS).now() == datetime(2024, 5, 5, 20, 0, tzinfo=UTC)


def test_messages_carry_the_sse_id_and_the_lap_of_their_micro_batch() -> None:
    _inputs, _priors, rep = scenario_replay()
    raw = [m for _, m in rep.memory.published]
    assert len(raw) == len(rep.messages)
    for text, m in zip(raw, rep.messages, strict=True):
        assert json.loads(text) == m.message and m.event_id == event_id_for(text, m.message)
    assert [m.message["type"] for m in rep.messages].count("session_end") == 1
    assert rep.messages[-1].lap == rep.snapshots[-1].lap
    assert [s.lap for s in rep.snapshots] == [b.lap for b in rep.batches]


# ------------------------------------------------------------------ nothing re-derived
@pytest.mark.parametrize("sc", [SCENARIO, SCENARIO_LAPPED], ids=["success", "stayed_out_sc"])
@pytest.mark.parametrize(("size", "lag"), [(1, None), (7, 0), (50, 1)])
def test_alerts_and_decisions_equal_other_micro_batchings(
    sc: object, size: int, lag: int | None
) -> None:
    inputs, priors, rep = scenario_replay(sc)  # type: ignore[arg-type]
    proc = StreamProcessor(
        scorer=scorer(),
        params=RuleParams(),
        sink=RedisSink(PT.NullStore()),
        priors_loader=lambda _s, _r: priors,
        n_partitions=3,
        keep_decisions=True,
    )
    PT.replay_into(proc, PT.kafka_batches(build_events(inputs, 3), 3, size, lag_partition=lag))
    key = lambda a: json.dumps(a.to_dict(), sort_keys=True)  # noqa: E731
    assert Counter(map(key, rep.alerts)) == Counter(map(key, proc.alerts))
    mine = {(d.decision_lap, d.attacker_id, d.defender_id, d.probability) for d in rep.decisions}
    theirs = {(d.decision_lap, d.attacker_id, d.defender_id, d.probability) for d in proc.decisions}
    assert mine == theirs and mine
    published = [
        m.message["payload"] for m in rep.messages if m.message["type"] == "undercut_alert"
    ]
    assert Counter(
        json.dumps({k: v for k, v in p.items() if k in rep.alerts[0].to_dict()}, sort_keys=True)
        for p in published
    ) == Counter(map(key, rep.alerts))


# ------------------------------------------------------------------ the lap-N state
@pytest.mark.parametrize("sc", [SCENARIO, SCENARIO_LAPPED], ids=["success", "stayed_out_sc"])
def test_every_lap_snapshot_equals_a_live_like_replay_into_redis(sc: object) -> None:
    inputs, priors, rep = scenario_replay(sc)  # type: ignore[arg-type]
    live = live_like_states(inputs, priors, scorer(), RuleParams())
    assert sorted(live) == [s.lap for s in rep.snapshots]
    for snap in rep.snapshots:
        assert state_diff(snap, live[snap.lap]) == [], snap.lap
    flagged = [s for s in rep.snapshots if any(d.undercut_flag for d in s.drivers.values())]
    assert flagged or sc is not SCENARIO, "the success scenario must exercise the undercut flag"
    assert rep.decisions


def test_state_diff_names_each_difference() -> None:
    inputs, _priors, rep = scenario_replay()
    snap = rep.snapshots[5]
    other = rep.snapshots[6]
    diff = state_diff(snap, other)
    assert diff and all(d.startswith(("drivers.", "tyres.", "order")) for d in diff)
    assert comparable_state(snap) == comparable_state(snap.model_copy())
    assert "updated_at" not in json.dumps(comparable_state(snap))
    assert state_diff(snap, snap.model_copy(update={"drivers": {}})) == [
        f"drivers.{d}: missing" for d in sorted(snap.drivers)
    ]
    assert priors_for(inputs).pit_loss_prior_s == 20.0
