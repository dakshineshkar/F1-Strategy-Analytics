"""Feature 5 in the archive (schema v2): ``status[]`` comes from the live ``race_status`` over a
``LapLog`` fed the bundle's own messages, is causal, and the snapshots' timing equals what a live
replay leaves in Redis."""

from __future__ import annotations

from _archive_fixtures import SCENARIO_LAPPED, bundle_of, scenario_replay

from f1sa.api.lap_log import LapLog
from f1sa.api.race_status import race_status
from f1sa.archive.build import status_laps


def test_status_is_the_live_function_over_the_messages_up_to_lap_n() -> None:
    _inputs, _priors, rep = scenario_replay(SCENARIO_LAPPED)
    bundle = bundle_of(rep)
    for st in bundle.status:
        log = LapLog(rep.season, rep.round)
        for m in rep.messages:
            if m.lap <= st.lap:
                log.observe(m.message)
        live = race_status(rep.season, rep.round, st.lap, log.lap_rows(), None, None)
        assert st.model_dump() == live.model_dump(exclude={"season", "round"})
    assert {s.source for s in bundle.status} <= {"estimated", "none"}  # no race control here


def test_status_at_lap_n_does_not_depend_on_later_messages() -> None:
    _inputs, _priors, rep = scenario_replay(SCENARIO_LAPPED)
    laps = [x.lap for x in rep.snapshots]
    full = status_laps(rep.season, rep.round, rep.messages, laps, None, None)
    for n in (3, 7, 10):
        cut = status_laps(
            rep.season, rep.round, [m for m in rep.messages if m.lap <= n], laps[:n], None, None
        )
        assert cut == full[:n]


def test_snapshot_timing_follows_the_lap_events() -> None:
    _inputs, _priors, rep = scenario_replay()
    for snap in rep.snapshots:
        laps = {
            m.message["payload"]["driver_id"]: m.message["payload"]
            for m in rep.messages
            if m.lap <= snap.lap and m.message["type"] == "lap"
        }
        assert set(snap.timing) == set(laps)
        for d, t in snap.timing.items():
            p = laps[d]  # the latest lap event of the car (messages are in publish order)
            assert t.lap == p["lap"] and t.pit_stops == p["pit_stops"]
            assert (t.sector1_s, t.pb_speed_trap_kph) == (p["sector1_s"], p["pb_speed_trap_kph"])
