"""Race replay producer: inputs equal the batch tables, event order, pacing, Kafka delivery, CLI."""

from __future__ import annotations

import itertools
from dataclasses import replace
from typing import Any

import pytest
from _stream_fixtures import full_mode_frames
from _undercut_fixtures import Scenario, clean_tables, standard_cars
from pyspark.sql import SparkSession

from f1sa.features import undercut as U
from f1sa.features.build import compute_features
from f1sa.sim.whatif import STINT_START_COLUMNS, StintStart, stint_starts
from f1sa.streaming import producer as PR
from f1sa.streaming.events import SESSION_END_KEY, RaceEvent, from_json

SC = Scenario(2023, 11, standard_cars(), neutral_laps={9}, red_flag_laps={3})


def lap(driver: str, n: int, pos: int, t: float | None) -> PR.LapRecord:
    return PR.LapRecord(driver, n, pos, t, "SOFT", n, False, False)


def tiny() -> PR.RaceInputs:
    return PR.RaceInputs(
        2024,
        5,
        laps=(
            lap("a", 1, 1, 90.0),
            lap("b", 1, 2, 91.0),
            lap("a", 2, 1, 90.0),
            lap("b", 2, 2, None),
            lap("a", 3, 1, 90.0),
            lap("b", 3, 2, 92.0),
        ),
        stops=(PR.StopRecord("a", 2, 22.5), PR.StopRecord("b", 1, 200.0)),
        race_laps=3,
    )


# ------------------------------------------------------------------ build_events
def test_build_events_order_and_placement() -> None:
    out = PR.build_events(tiny(), 3)
    kinds = [(o.event.type, o.event.driver_id, o.event.lap) for o in out]
    # pit_in of a's lap 2 directly before a's lap-2 event, both at a's crossing (180.0)
    i = kinds.index(("pit_in", "a", 2))
    assert kinds[i + 1] == ("lap", "a", 2)
    assert out[i].event.race_time_s == out[i + 1].event.race_time_s == 180.0
    # pit_out at the crossing + stop time ...
    pit_out_a = next(o.event for o in out if (o.event.type, o.event.driver_id) == ("pit_out", "a"))
    assert pit_out_a.lap == 3 and pit_out_a.race_time_s == 202.5
    # ... but never after the next crossing (b's 200 s stop is clipped to its lap-2 time)
    pit_out_b = next(o.event for o in out if (o.event.type, o.event.driver_id) == ("pit_out", "b"))
    b_lap2 = next(
        o.event for o in out if (o.event.type, o.event.driver_id, o.event.lap) == ("lap", "b", 2)
    )
    assert pit_out_b.race_time_s == b_lap2.race_time_s
    # b's unknown lap 2: placed at max(b's previous crossing, the leader's) = 180.0
    assert b_lap2.race_time_s == 180.0 and b_lap2.lap_time_s is None
    times = [o.event.race_time_s for o in out]
    assert times == sorted(times)
    ends = out[-3:]
    assert [o.event.type for o in ends] == ["session_end"] * 3
    assert [o.partition for o in ends] == [0, 1, 2] and {o.key for o in ends} == {SESSION_END_KEY}
    assert all(o.partition is None for o in out[:-3])
    assert len({o.event.event_id for o in out}) == len(out)
    assert all(o.event.produced_at_ms is None for o in out)
    assert all(o.event.race_laps == 3 for o in out if o.event.type == "lap")


def test_build_events_rejects_no_partitions() -> None:
    with pytest.raises(ValueError, match="n_partitions"):
        PR.build_events(tiny(), 0)


def test_stop_on_a_lap_never_completed_uses_the_last_crossing() -> None:
    inputs = PR.RaceInputs(2024, 5, (lap("a", 1, 1, 90.0),), (PR.StopRecord("a", 2, None),), 2)
    out = PR.build_events(inputs, 1)
    pit_in = next(o.event for o in out if o.event.type == "pit_in")
    assert pit_in.race_time_s == 90.0


def test_sim_partition_is_stable_and_in_range() -> None:
    assert PR.sim_partition("max_verstappen", 3) == PR.sim_partition("max_verstappen", 3)
    assert {PR.sim_partition(f"d{i}", 3) for i in range(50)} == {0, 1, 2}


# ------------------------------------------------------------------ inputs equal the batch tables
@pytest.fixture(scope="module")
def scenario(spark: SparkSession) -> dict[str, Any]:
    clean = clean_tables(spark, [SC])
    tables = compute_features(spark, clean, {(SC.season, SC.round)})
    return {"clean": clean, "tables": tables, "inputs": PR.race_inputs(clean, SC.season, SC.round)}


def test_race_inputs_equal_laps_enriched(scenario: dict[str, Any]) -> None:
    inputs: PR.RaceInputs = scenario["inputs"]
    rows = {
        (r["driver_id"], r["lap"]): r
        for r in U.race_lap_rows(
            scenario["tables"]["laps_enriched"], scenario["tables"]["pit_loss"]
        )
        .join(
            scenario["tables"]["laps_enriched"].select("driver_id", "lap", "tyre_age_laps"),
            ["driver_id", "lap"],
        )
        .collect()
    }
    assert {(r.driver_id, r.lap) for r in inputs.laps} == set(rows)
    for r in inputs.laps:
        b = rows[(r.driver_id, r.lap)]
        assert (r.position, r.lap_time_s, r.compound, r.tyre_age) == (
            b["position"],
            b["lap_time_s"],
            b["compound"],
            b["tyre_age_laps"],
        )
        assert (r.track_neutral, r.track_red_flag) == (b["track_neutral"], b["track_red_flag"])
        assert inputs.race_laps == b["race_laps"]
    assert any(r.track_neutral for r in inputs.laps) and any(r.track_red_flag for r in inputs.laps)
    assert {(s.driver_id, s.lap) for s in inputs.stops} == {
        ("a", 6),
        ("d", 7),
        ("lead", 9),
        ("back", 10),
    }


def test_lap_race_times_equal_the_batch_cumulative_time(scenario: dict[str, Any]) -> None:
    out = PR.build_events(scenario["inputs"], 3)
    cum = {
        (r["driver_id"], r["lap"]): r["cumulative_time_s"]
        for r in scenario["tables"]["laps_enriched"].collect()
    }
    for o in out:
        if o.event.type == "lap":
            assert o.event.race_time_s == cum[(o.event.driver_id, o.event.lap)]


def test_race_inputs_fail_without_laps(scenario: dict[str, Any]) -> None:
    with pytest.raises(PR.ProducerError, match="no laps"):
        PR.race_inputs(scenario["clean"], 2023, 30)


def test_compound_normalisation() -> None:
    for name in ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"):
        assert PR.normalise_compound(name) == name
        assert PR.normalise_compound(f"  {name.lower()} ") == name
    assert PR.normalise_compound("Intermediate") == "INTERMEDIATE"
    for bad in (None, "", "  ", "UNKNOWN", "TEST_UNKNOWN", "None", "nan", "SUPERSOFT", 3):
        assert PR.normalise_compound(bad) is None


# ------------------------------------------------------------------ compound lookup (display only)
def ti(driver: str, start: int, compound: str | None) -> StintStart:
    return StintStart(driver_id=driver, start_lap=start, compound=compound, tyre_age_at_start=0)


TI = (ti("a", 1, "MEDIUM"), ti("a", 7, "HARD"), ti("b", 1, "SOFT"), ti("b", 20, "WET"))
"""``a`` pits at the end of lap 6 (in-lap 6, out-lap 7); ``b`` changes on lap 20."""


def test_ti_compound_at_pit_boundary() -> None:
    assert [PR.ti_compound_at(TI, "a", n) for n in (1, 5, 6, 7, 8)] == [
        "MEDIUM",
        "MEDIUM",
        "MEDIUM",  # the in-lap keeps the old tyre
        "HARD",  # the out-lap has the new one
        "HARD",
    ]
    assert PR.ti_compound_at(TI, "b", 19) == "SOFT" and PR.ti_compound_at(TI, "b", 20) == "WET"


def test_ti_compound_at_never_uses_later_stints() -> None:
    later = (*TI, ti("a", 9, "SOFT"), ti("a", 30, "WET"))
    for n in range(1, 9):
        assert PR.ti_compound_at(later, "a", n) == PR.ti_compound_at(TI, "a", n)
    # relabelling every stint that starts after lap n never changes lap n
    for n in range(1, 25):
        future = tuple(
            replace(s, compound="WET") if s.start_lap > n else s for s in (*TI, ti("a", 15, None))
        )
        assert PR.ti_compound_at(future, "a", n) == PR.ti_compound_at(
            (*TI, ti("a", 15, None)), "a", n
        )


def test_ti_compound_at_unknowns() -> None:
    assert PR.ti_compound_at(TI, "zzz", 5) is None  # driver without TI stints
    assert PR.ti_compound_at((ti("a", 3, "SOFT"),), "a", 2) is None  # no stint started yet
    assert PR.ti_compound_at((ti("a", 1, None),), "a", 2) is None  # conflict / missing label
    assert PR.ti_compound_at((ti("a", 1, "UNKNOWN"),), "a", 2) is None
    assert PR.ti_compound_at((ti("a", 1, " soft"),), "a", 2) == "SOFT"
    assert PR.ti_compound_at((), "a", 2) is None


def test_stint_starts_drop_conflicting_compounds_and_never_read_the_end() -> None:
    rows = [
        {"driver_id": "a", "start_lap": 1, "compound": "SOFT", "tyre_age_at_start": 0,
         "compound_conflict": False},
        {"driver_id": "a", "start_lap": 9, "compound": "HARD", "tyre_age_at_start": 0,
         "compound_conflict": True},
    ]  # fmt: skip
    st = stint_starts(rows)
    assert PR.ti_compound_at(st, "a", 8) == "SOFT" and PR.ti_compound_at(st, "a", 9) is None
    assert "end_lap" not in STINT_START_COLUMNS and "laps" not in STINT_START_COLUMNS


def test_resolve_compound_precedence() -> None:
    assert PR.resolve_compound(TI, "a", 7, "SOFT") == ("HARD", "tracinginsights")
    assert PR.resolve_compound(TI, "a", 7, None) == ("HARD", "tracinginsights")
    # TI has no compound for the lap: the v1 stint's, else unknown
    assert PR.resolve_compound(TI, "zzz", 7, "medium") == ("MEDIUM", "v1_stints")
    assert PR.resolve_compound((ti("a", 1, None),), "a", 7, "HARD") == ("HARD", "v1_stints")
    assert PR.resolve_compound((ti("a", 1, None),), "a", 7, None) == (None, "none")
    assert PR.resolve_compound(TI, "zzz", 7, "UNKNOWN") == (None, "none")
    # no TI source at all (sample lake)
    assert PR.resolve_compound(None, "a", 7, "SOFT") == ("SOFT", "v1_stints")
    assert PR.resolve_compound(None, "a", 7, None) == (None, "none")


# ------------------------------------------------------------------ real tyre life (display only)
def tl(driver: str, start: int, age0: int | None) -> StintStart:
    return StintStart(driver_id=driver, start_lap=start, compound="SOFT", tyre_age_at_start=age0)


LIFE = (tl("a", 1, 3), tl("a", 7, 0), tl("a", 20, 4), tl("b", 1, 0), tl("b", 10, None))
"""``a``: a used set from qualifying (3 laps), then a new set from lap 7, a used one from 20."""


def test_ti_tyre_life_at_pit_boundaries_and_used_sets() -> None:
    assert [PR.ti_tyre_life_at(LIFE, "a", n) for n in (1, 2, 6, 7, 8, 19, 20, 21)] == [
        (4, 3),  # lap 1 on a set with 3 earlier laps (TyreLife counts the lap itself)
        (5, 3),
        (9, 3),  # the in-lap is still the old set
        (1, 0),  # the out-lap starts the new set
        (2, 0),
        (13, 0),
        (5, 4),  # out-lap on a used set: 4 earlier laps + this one
        (6, 4),
    ]


def test_ti_tyre_life_at_never_uses_later_stints_or_the_stint_end() -> None:
    for n in range(1, 25):
        future = tuple(
            replace(s, tyre_age_at_start=99, compound="WET") if s.start_lap > n else s
            for s in (*LIFE, tl("a", 30, 7))
        )
        assert PR.ti_tyre_life_at(future, "a", n) == PR.ti_tyre_life_at(LIFE, "a", n)


def test_ti_tyre_life_at_unknowns() -> None:
    assert PR.ti_tyre_life_at(None, "a", 5) == (None, None)  # no TI source (sample lake)
    assert PR.ti_tyre_life_at(LIFE, "zzz", 5) == (None, None)  # driver without TI stints
    assert PR.ti_tyre_life_at((tl("a", 3, 0),), "a", 2) == (None, None)  # no stint started
    assert PR.ti_tyre_life_at(LIFE, "b", 9) == (9, 0)
    assert PR.ti_tyre_life_at(LIFE, "b", 10) == (None, None)  # unknown start life: never new
    assert PR.ti_tyre_life_at((tl("a", 1, -1),), "a", 2) == (None, None)
    # a conflicting compound does not hide the tyre life
    conflict = stint_starts(
        [{"driver_id": "a", "start_lap": 1, "compound": "HARD", "tyre_age_at_start": 2,
          "compound_conflict": True}]
    )  # fmt: skip
    assert PR.ti_tyre_life_at(conflict, "a", 3) == (5, 2)


def test_compound_coverage_counts_every_source() -> None:
    laps = [
        replace(lap("a", 1, 1, 90.0), compound_source="tracinginsights"),
        replace(lap("a", 2, 1, 90.0), compound_source="tracinginsights"),
        replace(lap("b", 1, 2, 91.0), compound_source="v1_stints"),
    ]
    assert PR.compound_coverage(laps) == {"tracinginsights": 2, "v1_stints": 1, "none": 0}
    assert PR.compound_coverage([]) == dict.fromkeys(PR.COMPOUND_SOURCES, 0)


def test_race_inputs_take_the_compound_from_tracinginsights(
    spark: SparkSession, scenario: dict[str, Any]
) -> None:
    v1_only, with_ti = full_mode_frames(spark, scenario["clean"])
    base = PR.race_inputs(v1_only, SC.season, SC.round)
    got = PR.race_inputs(with_ti, SC.season, SC.round)
    assert {r.compound for r in base.laps} == {None}
    assert {r.compound_source for r in base.laps} == {"none"}
    stops = {(s.driver_id, s.lap) for s in got.stops}
    for b, r in zip(base.laps, got.laps, strict=True):
        # tyre age and every other field come from the v1 path, unchanged (TI age 5 is never used)
        assert (
            replace(
                r,
                compound=None,
                compound_source="none",
                tyre_life_laps=None,
                tyre_life_at_start_laps=None,
            )
            == b
        )
        pitted = any(d == r.driver_id and p < r.lap for d, p in stops)
        if r.driver_id == "d" and pitted:  # conflicting TI stint, v1 has no compound
            assert (r.compound, r.compound_source) == (None, "none")
        else:
            assert r.compound == ("MEDIUM" if pitted else "SOFT")
            assert r.compound_source == "tracinginsights"
    # the in-lap keeps the old tyre, the out-lap gets the new one (a pits at the end of lap 6)
    by_key = {(r.driver_id, r.lap): r.compound for r in got.laps}
    assert (by_key[("a", 6)], by_key[("a", 7)]) == ("SOFT", "MEDIUM")
    # real tyre life: the fixture's TI sets start with 5 laps on them; tyre_age stays the v1 value
    life = {(r.driver_id, r.lap): (r.tyre_life_laps, r.tyre_life_at_start_laps) for r in got.laps}
    assert life[("a", 1)] == (6, 5) and life[("a", 6)] == (11, 5) and life[("a", 7)] == (6, 5)
    assert {(r.tyre_life_laps, r.tyre_life_at_start_laps) for r in base.laps} == {(None, None)}
    assert all(r.tyre_life_laps != r.tyre_age for r in got.laps if r.tyre_life_laps is not None)
    assert (got.stops, got.race_laps) == (base.stops, base.race_laps)


def test_race_inputs_ignore_tracinginsights_for_synthetic_stints(
    spark: SparkSession, scenario: dict[str, Any]
) -> None:
    _v1_only, with_ti = full_mode_frames(spark, scenario["clean"])
    synthetic = {**with_ti, "stints": scenario["clean"]["stints"]}  # sample-mode v1 stints
    got = PR.race_inputs(synthetic, SC.season, SC.round)
    assert got == scenario["inputs"]
    assert {r.compound_source for r in got.laps} == {"v1_stints"}
    assert {r.compound for r in got.laps} == {"MEDIUM", "HARD"}
    assert {(r.tyre_life_laps, r.tyre_life_at_start_laps) for r in got.laps} == {(None, None)}


def test_check_season_refuses_the_test_season() -> None:
    with pytest.raises(PR.RefusedError, match="sealed"):
        PR.check_season(2025, False)
    PR.check_season(2025, True)
    PR.check_season(2024, False)


# ------------------------------------------------------------------ pacing
class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


@pytest.mark.parametrize("speed", [1.0, 10.0, 60.0])
def test_replay_paces_by_race_time(speed: float) -> None:
    out = PR.build_events(tiny(), 1)
    clock, sent = FakeClock(), []
    n = PR.replay(out, sent.append, speed, clock=clock.clock, sleep=clock.sleep, wall_ms=lambda: 7)
    span = out[-1].event.race_time_s - out[0].event.race_time_s
    assert n == len(out) == len(sent)
    assert sum(clock.sleeps) == pytest.approx(span / speed)
    assert all(o.event.produced_at_ms == 7 for o in sent)
    assert [o.partition for o in sent] == [o.partition for o in out]


@pytest.mark.parametrize("speed", [0.0, -1.0, float("inf"), float("nan")])
def test_replay_refuses_bad_speeds(speed: float) -> None:
    with pytest.raises(ValueError, match="speed"):
        PR.replay(PR.build_events(tiny(), 1), lambda o: None, speed)


def test_replay_of_nothing_sends_nothing() -> None:
    assert PR.replay([], lambda o: None, 10.0) == 0


# ------------------------------------------------------------------ replay controls (Feature 7)
def _ids(outs: list[PR.Outgoing]) -> list[str]:
    return [o.event.event_id for o in outs]


def _timed_send(clock: FakeClock, log: list[tuple[float, PR.Outgoing]]) -> PR.Send:
    return lambda o: log.append((clock.t, o))


def test_controlled_replay_without_changes_keeps_the_schedule() -> None:
    out = PR.build_events(tiny(), 2)
    clock, log = FakeClock(), []
    start = clock.t
    n = PR.replay_controlled(
        out,
        _timed_send(clock, log),
        lambda: PR.ReplayControl(10.0),
        clock=clock.clock,
        sleep=clock.sleep,
        wall_ms=lambda: 7,
    )
    assert n == len(out) and _ids([o for _, o in log]) == _ids(out)
    base = out[0].event.race_time_s
    for t, o in log:  # every event at start + (t - t_first) / speed, as replay() sends it
        assert t - start == pytest.approx((o.event.race_time_s - base) / 10.0)
    assert all(o.event.produced_at_ms == 7 for _, o in log)
    assert [o.partition for _, o in log] == [o.partition for o in out]
    assert max(clock.sleeps) <= 0.1 + 1e-9  # sliced sleeps: a change is seen within poll_s


def test_a_speed_change_re_anchors_and_never_skips_or_repeats() -> None:
    out = PR.build_events(tiny(), 1)
    base, span = out[0].event.race_time_s, out[-1].event.race_time_s - out[0].event.race_time_s
    clock, log = FakeClock(), []
    start, switch = clock.t, 100.0  # 100 wall-s at 1x, then 60x

    def control() -> PR.ReplayControl:
        fast = clock.t - start >= switch
        return PR.ReplayControl(60.0 if fast else 1.0, False, 1 if fast else 0)

    PR.replay_controlled(
        out, _timed_send(clock, log), control, clock=clock.clock, sleep=clock.sleep
    )
    assert _ids([o for _, o in log]) == _ids(out)  # each event once, in order
    for t, o in log:
        rt = o.event.race_time_s - base
        if rt < switch:  # before the switch: 1 race-s per wall-s
            assert t - start == pytest.approx(rt)
        else:  # after it: the race clock went on from where it stood, 60x faster
            assert t - start == pytest.approx(switch + (rt - switch) / 60.0, abs=0.11)
    assert clock.t - start == pytest.approx(switch + (span - switch) / 60.0, abs=0.11)


def test_a_pause_sends_nothing_until_resume_then_shifts_the_rest() -> None:
    out = PR.build_events(tiny(), 1)
    base = out[0].event.race_time_s
    clock, log = FakeClock(), []
    start, p0, length = clock.t, 2.0, 30.0

    def control() -> PR.ReplayControl:
        paused = p0 <= clock.t - start < p0 + length
        return PR.ReplayControl(60.0, paused, 1 if paused else (2 if clock.t - start >= p0 else 0))

    PR.replay_controlled(
        out, _timed_send(clock, log), control, clock=clock.clock, sleep=clock.sleep
    )
    assert _ids([o for _, o in log]) == _ids(out)
    assert not [t for t, _ in log if p0 + 0.11 < t - start < p0 + length]  # nothing while paused
    for t, o in log:
        due = (o.event.race_time_s - base) / 60.0
        if due < p0:
            assert t - start == pytest.approx(due)
        else:
            assert t - start == pytest.approx(due + length, abs=0.11)


def test_a_paused_replay_stays_put_and_reports_it() -> None:
    out = PR.build_events(tiny(), 1)
    clock, log, seen = FakeClock(), [], []
    reads = iter(
        [PR.ReplayControl(60.0, True, 1)] * 50 + [PR.ReplayControl(60.0, False, 2)] * 10**6
    )
    PR.replay_controlled(
        out,
        _timed_send(clock, log),
        lambda: next(reads),
        clock=clock.clock,
        sleep=clock.sleep,
        on_progress=seen.append,
    )
    assert seen[0].paused is True and seen[0].events_sent == 0 and seen[0].lap is None
    assert any(not p.paused and p.version == 2 for p in seen)
    assert log[0][0] - 1000.0 >= 49 * 0.1 - 1e-9  # the first event waited out the pause


def test_progress_reports_laps_and_the_final_count() -> None:
    out = PR.build_events(tiny(), 1)
    clock, seen = FakeClock(), []
    PR.replay_controlled(
        out,
        lambda o: None,
        lambda: PR.ReplayControl(1e6),
        clock=clock.clock,
        sleep=clock.sleep,
        on_progress=seen.append,
    )
    laps = [p.lap for p in seen if p.lap is not None]
    assert laps == sorted(laps) and laps[-1] == 3
    assert seen[-1].events_sent == len(out)
    assert seen[-1].race_time_s == out[-1].event.race_time_s


@pytest.mark.parametrize("k", [0, 1, 5])
def test_a_stop_at_any_point_sends_exactly_what_was_sent(k: int) -> None:
    out = PR.build_events(tiny(), 1)
    sent: list[PR.Outgoing] = []

    def send(o: PR.Outgoing) -> None:
        if len(sent) == k:
            raise KeyboardInterrupt  # what SIGTERM's default action stands for here
        sent.append(o)

    clock = FakeClock()
    with pytest.raises(KeyboardInterrupt):
        PR.replay_controlled(
            out, send, lambda: PR.ReplayControl(60.0), clock=clock.clock, sleep=clock.sleep
        )
    assert _ids(sent) == _ids(out)[:k]


def test_an_orphaned_replay_stops_before_the_next_event() -> None:
    out = PR.build_events(tiny(), 1)
    sent: list[PR.Outgoing] = []
    alive = iter([True] * 3 + [False] * 10**6)
    clock = FakeClock()
    with pytest.raises(PR.OrphanedError):
        PR.replay_controlled(
            out,
            sent.append,
            lambda: PR.ReplayControl(1e6, True),  # paused: it would wait forever
            clock=clock.clock,
            sleep=clock.sleep,
            alive=lambda: next(alive),
        )
    assert sent == []


def test_controlled_replay_edge_cases() -> None:
    assert PR.replay_controlled([], lambda o: None, lambda: PR.ReplayControl(1.0)) == 0
    with pytest.raises(ValueError, match="poll_s"):
        PR.replay_controlled([], lambda o: None, lambda: PR.ReplayControl(1.0), poll_s=0)


@pytest.mark.parametrize("speed", [0.0, -1.0, float("inf"), float("nan"), True])
def test_control_refuses_bad_speeds(speed: float) -> None:
    with pytest.raises(ValueError, match="speed"):
        PR.ReplayControl(speed)
    with pytest.raises(ValueError, match="version"):
        PR.ReplayControl(1.0, False, -1)


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        '{"speed": "60", "paused": false, "version": 1}',
        '{"speed": 60, "paused": "no", "version": 1}',
        '{"speed": 60, "paused": false, "version": 1.5}',
        '{"speed": 0, "paused": false, "version": 1}',
        '{"speed": true, "paused": false, "version": 1}',
        '{"paused": false, "version": 1}',
    ],
)
def test_parse_control_refuses_anything_else(text: str) -> None:
    with pytest.raises(ValueError):
        PR.parse_control(text)


def test_control_file_round_trip_and_last_good_value(
    tmp_path: Any, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "replay_control.json"
    reader = PR.ControlFile(path, PR.ReplayControl(60.0))
    with caplog.at_level("WARNING", logger="f1sa.streaming.producer"):
        assert reader() == PR.ReplayControl(60.0)  # missing: the initial value
        assert reader() == PR.ReplayControl(60.0)
        PR.write_control(path, PR.ReplayControl(10.0, True, 3))
        assert reader() == PR.ReplayControl(10.0, True, 3)
        path.write_text("{torn", encoding="utf-8")
        assert reader() == PR.ReplayControl(10.0, True, 3)  # garbled: keeps the last good one
        assert reader() == PR.ReplayControl(10.0, True, 3)
    problems = [r.getMessage() for r in caplog.records]
    assert len(problems) == 2  # once per distinct problem
    assert "missing" in problems[0] and "unreadable" in problems[1]
    assert not list(tmp_path.glob(".*.tmp"))


def test_progress_round_trip_and_bad_files(tmp_path: Any) -> None:
    path = tmp_path / "replay_progress.json"
    assert PR.read_progress(path) is None
    progress = PR.ReplayProgress(12, 240, 1100.5, True, 10.0, 4)
    PR.write_json_atomic(path, progress.to_json())
    assert PR.read_progress(path) == progress
    for bad in ("x", "[]", '{"lap": -1, "events_sent": 0, "race_time_s": null, '
                '"paused": false, "speed": 1, "version": 0}'):  # fmt: skip
        path.write_text(bad, encoding="utf-8")
        assert PR.read_progress(path) is None
    with pytest.raises(ValueError, match="events_sent"):
        PR.parse_progress(
            '{"lap": null, "events_sent": -2, "race_time_s": null, "paused": false, '
            '"speed": 1, "version": 0}'
        )


def test_parse_args_takes_the_control_files() -> None:
    args = PR.parse_args(
        ["--season", "2024", "--round", "5", "--control-file", "c.json", "--progress-file", "p"]
    )
    assert (str(args.control_file), str(args.progress_file)) == ("c.json", "p")
    plain = PR.parse_args(["--season", "2024", "--round", "5"])
    assert plain.control_file is None and plain.progress_file is None


# ------------------------------------------------------------------ Kafka sending
class FakeProducer:
    def __init__(self, *, fail: bool = False, full_once: bool = False, left: int = 0) -> None:
        self.calls: list[dict[str, Any]] = []
        self.callbacks: list[Any] = []
        self.fail, self.full_once, self.left = fail, full_once, left

    def produce(self, topic: str, **kwargs: Any) -> None:
        if self.full_once:
            self.full_once = False
            raise BufferError("queue full")
        self.calls.append({"topic": topic, **kwargs})
        self.callbacks.append(kwargs["on_delivery"])

    def poll(self, timeout: float) -> int:
        for cb in self.callbacks:
            cb("broker down" if self.fail else None, object())
        self.callbacks.clear()
        return 0

    def flush(self, timeout: float) -> int:
        self.poll(0)
        return self.left


def test_producer_config_is_idempotent_with_acks_all() -> None:
    conf = PR.producer_config("k:9092")
    assert conf["acks"] == "all" and conf["enable.idempotence"] is True
    assert conf["bootstrap.servers"] == "k:9092"


def test_sender_keys_by_driver_and_pins_session_end() -> None:
    fake = FakeProducer(full_once=True)
    sender = PR.KafkaSender(fake, "topic")
    out = PR.build_events(tiny(), 2)
    for o in out:
        sender(o)
    sender.close()
    assert len(fake.calls) == len(out) and sender.delivered == len(out)
    first = fake.calls[0]
    assert first["topic"] == "topic" and "partition" not in first
    assert from_json(first["value"]) == out[0].event
    assert first["key"] == out[0].event.driver_id.encode()  # type: ignore[union-attr]
    assert [c.get("partition") for c in fake.calls[-2:]] == [0, 1]
    assert {c["key"] for c in fake.calls[-2:]} == {b"session_end"}


@pytest.mark.parametrize(
    "fake", [FakeProducer(fail=True), FakeProducer(left=3)], ids=["error", "left"]
)
def test_sender_close_fails_on_delivery_problems(fake: FakeProducer) -> None:
    sender = PR.KafkaSender(fake, "topic")
    sender(PR.build_events(tiny(), 1)[0])
    with pytest.raises(RuntimeError, match="delivery failed"):
        sender.close()


# ------------------------------------------------------------------ CLI
def test_main_refuses_2025_before_reading_anything() -> None:
    def no_spark() -> Any:
        raise AssertionError("spark must not be started")

    assert PR.main(["--season", "2025", "--round", "1"], spark_factory=no_spark) == 2
    assert (
        PR.main(["--season", "2024", "--round", "1", "--speed", "0"], spark_factory=no_spark) == 2
    )


def test_main_missing_race_exits_3(
    spark: SparkSession, sample_clean_lake: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_LAKE_URI", f"file://{sample_clean_lake.base}/nowhere")
    assert (
        PR.main(["--season", "2024", "--round", "5", "--dry-run"], spark_factory=lambda: spark) == 3
    )


def test_main_replays_the_sample_race(
    spark: SparkSession,
    sample_clean_lake: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("DATA_LAKE_URI", sample_clean_lake.settings().data_lake_uri)
    fakes: list[FakeProducer] = []

    def make(conf: dict[str, Any]) -> FakeProducer:
        assert conf["acks"] == "all"
        fakes.append(FakeProducer())
        return fakes[-1]

    args = ["--season", "2024", "--round", "5", "--speed", "1e9"]
    rc = PR.main(args, make_producer=make, partitions=lambda b, t: 3, spark_factory=lambda: spark)
    assert rc == 0
    sent = [from_json(c["value"]) for c in fakes[0].calls]
    assert isinstance(sent[0], RaceEvent) and sent[0].produced_at_ms is not None
    assert [e.type for e in sent[-3:]] == ["session_end"] * 3
    assert sum(e.type == "lap" for e in sent) > 1000
    # the sample lake has no stints_tracinginsights: the synthetic v1 compounds stay
    laps = [e for e in sent if e.type == "lap"]
    assert {e.compound for e in laps} <= {"SOFT", "MEDIUM", "HARD"}
    assert all(e.compound is not None for e in laps)
    out = capsys.readouterr().out
    assert f"compound: 0 tracinginsights, {len(laps)} v1_stints, 0 unknown" in out
    assert "(100.0% known)" in out
    assert f"tyre life: 0 of {len(laps)} laps known (0.0%), 0 on a used set" in out
    assert all(e.tyre_life_laps is None and e.tyre_life_at_start_laps is None for e in laps)
    # Feature 5: the sample has no TracingInsights sectors; the stop count is real (Jolpica)
    assert f"timing: sectors 0 of {len(laps)} laps, speed trap 0 of {len(laps)}" in out
    assert all(e.sector1_s is None and e.pb_speed_trap_kph is None for e in laps)
    assert all(e.pit_stops is not None and e.pit_stops >= 0 for e in laps)
    n_pit_in = sum(e.type == "pit_in" for e in sent)
    last = {e.driver_id: e.pit_stops for e in laps}  # laps are in race order
    assert 0 < sum(v or 0 for v in last.values()) <= n_pit_in
    assert PR.main([*args, "--dry-run"], spark_factory=lambda: spark) == 0


# ------------------------------------------------------------------ timing tower (Feature 5)
def tlap(driver: str, n: int, s1: float | None, trap: float | None = None) -> PR.LapRecord:
    """A lap with sector 1 = ``s1``, sectors 2/3 = 30 + n / 20 + n and speed trap ``trap``."""
    return replace(
        lap(driver, n, 1 if driver == "a" else 2, 90.0),
        sector1_s=s1,
        sector2_s=30.0 + n,
        sector3_s=20.0 + n,
        speed_trap_kph=trap,
    )


def tower_race() -> PR.RaceInputs:
    laps = (
        tlap("a", 1, None, 300.0),  # lap 1: no S1 (as in TracingInsights)
        tlap("b", 1, None, None),
        tlap("a", 2, 28.4, 310.0),
        tlap("b", 2, 28.9, 305.0),
        tlap("a", 3, 28.6, 308.0),
        tlap("b", 3, 28.2, 312.0),
        tlap("a", 4, 28.1, 315.0),
        tlap("b", 4, 29.5, None),
    )
    stops = (PR.StopRecord("a", 2, 22.5), PR.StopRecord("b", 3, 23.0))
    return PR.RaceInputs(2024, 5, laps, stops, race_laps=4)


def test_running_timing_bests_and_stop_counts() -> None:
    got = PR.running_timing(tower_race().laps, tower_race().stops)
    a = [got[("a", n)] for n in range(1, 5)]
    b = [got[("b", n)] for n in range(1, 5)]
    assert [x.sector1_s for x in a] == [None, 28.4, 28.6, 28.1]
    assert [x.pb_sector1_s for x in a] == [None, 28.4, 28.4, 28.1]  # the minimum so far
    assert [x.pb_sector2_s for x in a] == [31.0] * 4  # 30 + n: lap 1 stays the best
    assert [x.pb_speed_trap_kph for x in a] == [300.0, 310.0, 310.0, 315.0]  # the maximum
    assert [x.pb_speed_trap_kph for x in b] == [None, 305.0, 312.0, 312.0]
    assert [x.speed_trap_kph for x in b] == [None, 305.0, 312.0, None]
    # stops with in-lap <= lap: a pits on lap 2 (the pit_in is sent before lap 2), b on lap 3
    assert [x.pit_stops for x in a] == [0, 1, 1, 1]
    assert [x.pit_stops for x in b] == [0, 0, 1, 1]
    # every best is monotone and never better than a value that has not happened yet
    for rows in (a, b):
        for prev, cur in itertools.pairwise(rows):
            for f in ("pb_sector1_s", "pb_sector2_s", "pb_sector3_s"):
                p, c = getattr(prev, f), getattr(cur, f)
                assert p is None or (c is not None and c <= p)
            assert (prev.pb_speed_trap_kph or 0) <= (cur.pb_speed_trap_kph or 0)


@pytest.mark.parametrize("n", [1, 2, 3])
def test_running_timing_is_causal(n: int) -> None:
    """The values of laps <= N do not change when later laps exist, whatever they hold."""
    race = tower_race()
    full = PR.running_timing(race.laps, race.stops)
    cut = PR.running_timing(
        [r for r in race.laps if r.lap <= n], [s for s in race.stops if s.lap <= n]
    )

    def scaled(r: PR.LapRecord) -> PR.LapRecord:
        if r.lap <= n:
            return r
        return replace(
            r,
            sector1_s=None if r.sector1_s is None else r.sector1_s / 100,  # a much faster future
            sector2_s=(r.sector2_s or 1.0) * 100,
            sector3_s=(r.sector3_s or 1.0) / 100,
            speed_trap_kph=(r.speed_trap_kph or 1.0) * 100,
        )

    future = PR.running_timing(
        [scaled(r) for r in race.laps], [*race.stops, PR.StopRecord("a", n + 1, 30.0)]
    )
    for key, value in cut.items():
        assert full[key] == value == future[key], key
    assert {k for k in full if k[1] <= n} == set(cut)


def test_timing_value_accepts_only_positive_finite_numbers() -> None:
    assert PR.timing_value(28.5) == 28.5 and PR.timing_value(29) == 29.0
    for bad in (None, 0, 0.0, -1.0, float("nan"), float("inf"), True, "28.5"):
        assert PR.timing_value(bad) is None


def test_build_events_carry_the_tower_values() -> None:
    out = PR.build_events(tower_race(), 1)
    timing = PR.running_timing(tower_race().laps, tower_race().stops)
    seen_pit_in: dict[str, int] = {}
    for o in out:
        e = o.event
        if e.type == "pit_in":
            assert e.driver_id is not None
            seen_pit_in[e.driver_id] = seen_pit_in.get(e.driver_id, 0) + 1
            assert e.pit_stops is None and e.sector1_s is None
        if e.type != "lap":
            continue
        assert e.driver_id is not None and e.lap is not None
        t = timing[(e.driver_id, e.lap)]
        assert (e.sector1_s, e.pb_sector1_s, e.speed_trap_kph, e.pb_speed_trap_kph) == (
            t.sector1_s,
            t.pb_sector1_s,
            t.speed_trap_kph,
            t.pb_speed_trap_kph,
        )
        # the count equals the pit_in events already sent for the car
        assert e.pit_stops == seen_pit_in.get(e.driver_id, 0)
    # inputs without sectors (the sample) give null sectors and still count the stops
    plain = PR.build_events(tiny(), 1)
    laps = [o.event for o in plain if o.event.type == "lap"]
    assert all(e.sector1_s is None and e.pb_speed_trap_kph is None for e in laps)
    assert {(e.driver_id, e.lap): e.pit_stops for e in laps}[("a", 2)] == 1


def _analysis_laps(spark: SparkSession, rows: list[tuple[Any, ...]]) -> Any:
    from pyspark.sql.types import DoubleType, IntegerType, StringType, StructField, StructType

    schema = StructType(
        [
            StructField("season", IntegerType()),
            StructField("round", IntegerType()),
            StructField("driver_id", StringType()),
            StructField("lap", IntegerType()),
            StructField("sector1_s", DoubleType()),
            StructField("sector2_s", DoubleType()),
            StructField("sector3_s", DoubleType()),
            StructField("speed_st_kph", DoubleType()),
        ]
    )
    return spark.createDataFrame(rows, schema)


def test_race_inputs_take_sectors_from_analysis_laps(
    spark: SparkSession, scenario: dict[str, Any]
) -> None:
    base: PR.RaceInputs = scenario["inputs"]
    s, r = SC.season, SC.round
    rows = [
        (s, r, "a", 2, 28.5, 31.0, 24.0, 320.0),
        (s, r, "a", 3, float("nan"), 0.0, -1.0, None),  # unusable values become null
        (s, r + 1, "a", 2, 1.0, 1.0, 1.0, 1.0),  # another race: ignored
    ]
    frames = {**scenario["clean"], PR.ANALYSIS_LAPS_TABLE: _analysis_laps(spark, rows)}
    got = PR.race_inputs(frames, s, r)
    by_key = {(x.driver_id, x.lap): x for x in got.laps}
    a2 = by_key[("a", 2)]
    assert (a2.sector1_s, a2.sector2_s, a2.sector3_s, a2.speed_trap_kph) == (
        28.5,
        31.0,
        24.0,
        320.0,
    )
    a3 = by_key[("a", 3)]
    assert (a3.sector1_s, a3.sector2_s, a3.sector3_s, a3.speed_trap_kph) == (None,) * 4
    # every other field is the v1 path, unchanged
    for b, x in zip(base.laps, got.laps, strict=True):
        assert replace(x, sector1_s=None, sector2_s=None, sector3_s=None, speed_trap_kph=None) == b
    assert (got.stops, got.race_laps) == (base.stops, base.race_laps)
    dup = [*rows, (s, r, "a", 2, 28.0, 31.0, 24.0, 320.0)]
    with pytest.raises(PR.ProducerError, match="duplicate analysis_laps"):
        PR.race_inputs(
            {**scenario["clean"], PR.ANALYSIS_LAPS_TABLE: _analysis_laps(spark, dup)}, s, r
        )


# ------------------------------------------------------------------ main with controls (Feature 7)
def test_main_with_a_control_file_writes_progress_and_sends_everything(
    spark: SparkSession,
    sample_clean_lake: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    monkeypatch.setenv("DATA_LAKE_URI", sample_clean_lake.settings().data_lake_uri)
    control, progress = tmp_path / "replay_control.json", tmp_path / "replay_progress.json"
    PR.write_control(control, PR.ReplayControl(1e9))
    fakes: list[FakeProducer] = []

    def make(conf: dict[str, Any]) -> FakeProducer:
        fakes.append(FakeProducer())
        return fakes[-1]

    args = ["--season", "2024", "--round", "5", "--speed", "1"]
    args += ["--control-file", str(control), "--progress-file", str(progress)]
    rc = PR.main(args, make_producer=make, partitions=lambda b, t: 3, spark_factory=lambda: spark)
    assert rc == 0
    sent = [from_json(c["value"]) for c in fakes[0].calls]
    done = PR.read_progress(progress)
    assert done is not None and done.events_sent == len(sent) and done.speed == 1e9
    assert done.lap == max(e.lap for e in sent if e.type == "lap" and e.lap is not None)
    assert [e.type for e in sent[-3:]] == ["session_end"] * 3


def test_main_exits_4_when_orphaned(
    spark: SparkSession,
    sample_clean_lake: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    monkeypatch.setenv("DATA_LAKE_URI", sample_clean_lake.settings().data_lake_uri)
    control = tmp_path / "replay_control.json"
    PR.write_control(control, PR.ReplayControl(60.0, True))  # paused: only the parent check ends it
    parents = iter([4242] + [1] * 10**6)
    monkeypatch.setattr(PR.os, "getppid", lambda: next(parents))
    args = ["--season", "2024", "--round", "5", "--control-file", str(control)]
    rc = PR.main(
        args,
        make_producer=lambda conf: FakeProducer(),
        partitions=lambda b, t: 1,
        spark_factory=lambda: spark,
    )
    assert rc == 4
