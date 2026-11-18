"""Redis sink: one pipeline per micro-batch, 9 fields, alerts, session end, no late writes."""

from __future__ import annotations

import json
from typing import Any

import pytest
from _stream_fixtures import CountingStore

from f1sa.serving import keys as K
from f1sa.serving.keys import DRIVER_FIELDS
from f1sa.streaming import redis_sink as RS
from f1sa.streaming.events import RaceEvent, UndercutAlert, new_event_id
from f1sa.streaming.live_features import RacePriors
from f1sa.streaming.live_state import RaceState

S, R = 2024, 5


def lap_ev(
    driver: str, lap: int, pos: int, t: float, lap_time: float = 90.0, **kw: Any
) -> RaceEvent:
    return RaceEvent(
        new_event_id(),
        "lap",
        S,
        R,
        t,
        driver_id=driver,
        lap=lap,
        lap_time_s=lap_time,
        position=pos,
        produced_at_ms=1_000 + lap,
        **kw,
    )


def race(*events: RaceEvent) -> RaceState:
    st = RaceState(S, R, 1, RacePriors(S, R))
    for e in events:
        st.apply(e, 0)
    return st


def an_alert() -> UndercutAlert:
    return UndercutAlert(
        "opportunity", "new_candidate", S, R, "b", "a", 10, 1.25, 0.42, 0.5,
        {"gap_s": 1.25, "pit_loss_source": None},
    )  # fmt: skip


def test_driver_states_follow_the_contract() -> None:
    st = race(
        lap_ev("a", 1, 1, 90.0, compound="SOFT", tyre_age=3),
        lap_ev("b", 1, 2, 91.5, lap_time=91.5),
    )
    st.set_flag("b", 1, True, 0.3)
    states = RS.driver_states(st)
    assert states["a"].position == 1 and states["a"].gap_leader_s == 0.0
    assert states["a"].gap_ahead_s is None and states["a"].tyre_compound == "SOFT"
    assert states["b"].gap_ahead_s == 1.5 and states["b"].tyre_compound == "UNKNOWN"
    assert (states["b"].undercut_flag, states["b"].undercut_prob) == (True, 0.3)
    assert (states["a"].undercut_flag, states["a"].undercut_prob) == (False, None)


@pytest.mark.parametrize(
    "value, out", [(None, None), (-0.2, None), (float("nan"), None), (1.5, 1.5)]
)
def test_contract_gap(value: float | None, out: float | None) -> None:
    assert RS.contract_gap(value) == out


def test_one_write_batch_with_states_order_events_and_alerts() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    evs = [lap_ev("a", 1, 1, 90.0), lap_ev("b", 1, 2, 91.5, lap_time=91.5)]
    st = race(*evs)
    pubsub = store.client.pubsub()
    pubsub.subscribe(K.events_channel(S, R))
    pubsub.get_message(timeout=0.1)  # subscribe confirmation
    rec = sink.write(st, evs, [an_alert()], received_ms=4_000)
    assert rec is not None and len(store.batches) == 1
    assert (rec.n_states, rec.n_events, rec.n_alerts, rec.redis_written_at_ms) == (2, 2, 1, 5_000)
    h = store.client.hgetall(K.driver_key(S, R, "b"))
    assert tuple(h) == DRIVER_FIELDS and h["gap_ahead_s"] == "1.5"
    assert store.get_order(S, R) == [("a", 1), ("b", 2)]
    msgs = []
    while (m := pubsub.get_message(timeout=0.1)) is not None:
        msgs.append(json.loads(m["data"]))
    assert [m["type"] for m in msgs] == ["lap", "lap", "undercut_alert"]
    lap_payload = msgs[0]["payload"]
    assert lap_payload["event_id"] == evs[0].event_id
    assert (lap_payload["produced_at_ms"], lap_payload["batch_received_at_ms"]) == (1_001, 4_000)
    assert lap_payload["redis_written_at_ms"] == 5_000 and lap_payload["position"] == 1
    alert = msgs[2]["payload"]
    assert (alert["attacker_id"], alert["defender_id"], alert["attempt_lap"]) == ("b", "a", 11)
    assert alert["undercut_prob"] == 0.42 and alert["inputs"]["gap_s"] == 1.25
    assert (alert["reason"], alert["trigger"]) == ("opportunity", "new_candidate")
    assert alert["trigger_event_id"] in {e.event_id for e in evs}
    assert store.client.ttl(K.driver_key(S, R, "a")) > 0


@pytest.mark.parametrize("compound", ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", None])
def test_lap_event_compound_reaches_the_hash_and_the_channel(compound: str | None) -> None:
    """The producer's compound (TracingInsights or v1, already normalised) is written as is;
    null becomes ``UNKNOWN`` in the hash and stays null on the race channel."""
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    evs = [lap_ev("a", 1, 1, 90.0, compound=compound, tyre_age=4)]
    pubsub = store.client.pubsub()
    pubsub.subscribe(K.events_channel(S, R))
    pubsub.get_message(timeout=0.1)
    sink.write(race(*evs), evs, [], received_ms=4_000)
    h = store.client.hgetall(K.driver_key(S, R, "a"))
    assert tuple(h) == DRIVER_FIELDS
    assert h["tyre_compound"] == (compound or "UNKNOWN") and h["tyre_age_laps"] == "4"
    msg = pubsub.get_message(timeout=0.1)
    assert msg is not None and json.loads(msg["data"])["payload"]["compound"] == compound


def test_tyre_hash_follows_the_latest_lap_event_in_the_same_batch() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    a1 = lap_ev("a", 1, 1, 90.0, tyre_life_laps=4, tyre_life_at_start_laps=3)
    b1 = lap_ev("b", 1, 2, 91.5, lap_time=91.5)  # no TI value: written as unknown
    st = race(a1, b1)
    pubsub = store.client.pubsub()
    pubsub.subscribe(K.events_channel(S, R))
    pubsub.get_message(timeout=0.1)
    rec = sink.write(st, [a1, b1], [], received_ms=4_000)
    assert rec is not None and rec.n_tyres == 2 and len(store.batches) == 1  # one write_batch
    ta = store.client.hgetall(K.tyre_key(S, R, "a"))
    assert tuple(ta) == K.TYRE_FIELDS
    assert (ta["tyre_life_laps"], ta["tyre_life_at_start_laps"], ta["lap"]) == ("4", "3", "1")
    tb = store.client.hgetall(K.tyre_key(S, R, "b"))
    assert (tb["tyre_life_laps"], tb["tyre_life_at_start_laps"]) == ("", "")
    assert store.client.ttl(K.tyre_key(S, R, "a")) > 0
    payload = json.loads(pubsub.get_message(timeout=0.1)["data"])["payload"]
    assert (payload["tyre_life_laps"], payload["tyre_life_at_start_laps"]) == (4, 3)
    # the driver hash keeps the 9 contract fields with the inferred age
    h = store.client.hgetall(K.driver_key(S, R, "a"))
    assert tuple(h) == DRIVER_FIELDS and h["tyre_age_laps"] == ""

    # next batch: a new stint with an unknown starting life clears the old value
    a2 = lap_ev("a", 2, 1, 180.0, tyre_life_laps=None)
    st.apply(a2, 0)
    sink.write(st, [a2], [], received_ms=4_100)
    ta = store.client.hgetall(K.tyre_key(S, R, "a"))
    assert (ta["tyre_life_laps"], ta["lap"]) == ("", "2")


def test_an_older_lap_event_never_overwrites_the_tyre_hash() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    new = lap_ev("a", 5, 1, 450.0, tyre_life_laps=9, tyre_life_at_start_laps=0)
    old = lap_ev("a", 4, 1, 360.0, tyre_life_laps=8, tyre_life_at_start_laps=0)
    st = race(new, old)  # lap 5 arrived first
    rec = sink.write(st, [new, old], [], received_ms=4_000)
    assert rec is not None and rec.n_tyres == 1
    assert store.client.hget(K.tyre_key(S, R, "a"), "tyre_life_laps") == "9"
    assert RS.tyre_lives(st, [old]) == {}
    assert RS.tyre_lives(st, [new])["a"].lap == 5


def test_nothing_to_write_returns_none() -> None:
    store = CountingStore()
    assert RS.RedisSink(store).write(race(), [], [], received_ms=0) is None
    assert store.batches == []


def test_session_end_expires_the_race_and_blocks_later_writes() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store)
    evs = [lap_ev("a", 1, 1, 90.0)]
    st = race(*evs)
    end = RaceEvent(new_event_id(), "session_end", S, R, 100.0, produced_at_ms=9_000)
    rec = sink.write(st, [*evs, end], [], received_ms=1, session_end=True)
    assert rec is not None and rec.session_end and st.ended
    assert store.ends == [(S, R)]
    ttl = store.client.ttl(K.driver_key(S, R, "a"))
    assert 0 < ttl <= store.settings.redis_ttl_after_session_s
    with pytest.raises(RuntimeError, match="has ended"):
        sink.write(st, evs, [], received_ms=2)
    assert len(store.batches) == 2  # the race batch and end_session's own session_end publish


def test_session_end_with_nothing_else_still_ends() -> None:
    store = CountingStore()
    st = race()
    rec = RS.RedisSink(store).write(st, [], [], received_ms=1, session_end=True)
    assert rec is not None and st.ended and store.ends == [(S, R)]


def test_time_helpers() -> None:
    assert RS.ms_to_datetime(None) is None
    assert RS.ms_to_datetime(0).isoformat() == "1970-01-01T00:00:00+00:00"  # type: ignore[union-attr]
    assert RS.now_ms() > 1_700_000_000_000


# ------------------------------------------------------- additive timing hash (Feature 5)
TOWER_A = {
    "sector1_s": 28.5,
    "sector2_s": 31.25,
    "sector3_s": 24.0,
    "speed_trap_kph": 321.4,
    "pb_sector1_s": 28.5,
    "pb_sector2_s": 31.25,
    "pb_sector3_s": 24.0,
    "pb_speed_trap_kph": 321.4,
    "pit_stops": 0,
}


def test_timing_hash_follows_the_latest_lap_event_in_the_same_pipeline() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    a1 = lap_ev("a", 1, 1, 90.0, **TOWER_A)
    b1 = lap_ev("b", 1, 2, 91.5, lap_time=91.5, pit_stops=0)  # the sample: no sectors
    st = race(a1, b1)
    pubsub = store.client.pubsub()
    pubsub.subscribe(K.events_channel(S, R))
    pubsub.get_message(timeout=0.1)
    rec = sink.write(st, [a1, b1], [], received_ms=4_000)
    assert rec is not None and len(store.batches) == 1  # one write_batch for everything
    assert set(store.batches[0][2].timings) == {"a", "b"}
    ta = store.client.hgetall(K.timing_key(S, R, "a"))
    assert tuple(ta) == K.TIMING_FIELDS
    assert (ta["lap"], ta["sector2_s"], ta["pb_speed_trap_kph"], ta["pit_stops"]) == (
        "1",
        "31.25",
        "321.4",
        "0",
    )
    tb = store.client.hgetall(K.timing_key(S, R, "b"))
    assert (tb["sector1_s"], tb["speed_trap_kph"], tb["pit_stops"]) == ("", "", "0")
    assert store.client.ttl(K.timing_key(S, R, "a")) > 0
    payload = json.loads(pubsub.get_message(timeout=0.1)["data"])["payload"]
    assert {f: payload[f] for f in TOWER_A} == TOWER_A
    # the driver hash keeps exactly the 9 contract fields
    assert tuple(store.client.hgetall(K.driver_key(S, R, "a"))) == DRIVER_FIELDS

    # next batch: a slower lap keeps the best so far from the event; null values are written
    a2 = lap_ev("a", 2, 1, 180.0, sector1_s=29.0, pb_sector1_s=28.5, pit_stops=1)
    st.apply(a2, 0)
    sink.write(st, [a2], [], received_ms=4_100)
    ta = store.client.hgetall(K.timing_key(S, R, "a"))
    assert (ta["lap"], ta["sector1_s"], ta["pb_sector1_s"], ta["sector2_s"]) == (
        "2",
        "29.0",
        "28.5",
        "",
    )
    assert ta["pit_stops"] == "1"


def test_an_older_lap_event_never_overwrites_the_timing_hash() -> None:
    store = CountingStore()
    sink = RS.RedisSink(store, clock_ms=lambda: 5_000)
    new = lap_ev("a", 5, 1, 450.0, sector1_s=28.0, pit_stops=1)
    old = lap_ev("a", 4, 1, 360.0, sector1_s=29.0, pit_stops=1)
    st = race(new, old)  # lap 5 arrived first
    sink.write(st, [new, old], [], received_ms=4_000)
    assert store.client.hget(K.timing_key(S, R, "a"), "lap") == "5"
    assert RS.timing_rows(st, [old]) == {}
    assert RS.timing_rows(st, [new])["a"].sector1_s == 28.0


def test_pit_events_publish_no_tower_fields_and_write_no_timing() -> None:
    a1 = lap_ev("a", 1, 1, 90.0, **TOWER_A)
    st = race(a1)
    pit = RaceEvent(new_event_id(), "pit_in", S, R, 170.0, driver_id="a", lap=2)
    st.apply(pit, 0)
    assert RS.timing_rows(st, [pit]) == {}
    assert "pit_stops" not in RS.event_payload(pit, 1, 2)
