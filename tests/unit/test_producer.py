"""Race replay producer: inputs equal the batch tables, event order, pacing, Kafka delivery, CLI."""

from __future__ import annotations

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
        assert replace(r, compound=None, compound_source="none") == b
        pitted = any(d == r.driver_id and p < r.lap for d, p in stops)
        if r.driver_id == "d" and pitted:  # conflicting TI stint, v1 has no compound
            assert (r.compound, r.compound_source) == (None, "none")
        else:
            assert r.compound == ("MEDIUM" if pitted else "SOFT")
            assert r.compound_source == "tracinginsights"
    # the in-lap keeps the old tyre, the out-lap gets the new one (a pits at the end of lap 6)
    by_key = {(r.driver_id, r.lap): r.compound for r in got.laps}
    assert (by_key[("a", 6)], by_key[("a", 7)]) == ("SOFT", "MEDIUM")
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
    assert PR.main([*args, "--dry-run"], spark_factory=lambda: spark) == 0
