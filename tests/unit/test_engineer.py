"""The engineer view's pure calculations (Feature 3) on invented laps (no F1 data).

Race 2024 R5 (circuit ``c1``), four cars, 10 laps:
* ``alpha`` leads by 10 s; ``bravo`` (focus) is P2; ``charlie`` P3 closes on ``bravo`` by 0.5 s a
  lap; ``delta`` is 40 s back.
* Lap times are 90 s; ``charlie`` laps in 89.5 s from lap 2; ``bravo`` pits on lap 6 (in-lap 6,
  out-lap 7, each 10 s slower).
"""

from __future__ import annotations

from typing import Any

import pytest

from f1sa.api import engineer as E
from f1sa.api.lap_log import LapRow
from f1sa.api.models import AnalysisCoverageOut, AnalysisLapsOut, AnalysisRaceControlsOut


def row(d: str, lap: int, t: float, pos: int, **over: Any) -> LapRow:
    base: dict[str, Any] = {
        "driver_id": d,
        "lap": lap,
        "race_time_s": t,
        "lap_time_s": 90.0,
        "position": pos,
        "compound": "MEDIUM",
        "tyre_age": lap,
        "tyre_life_laps": lap + 2,
        "tyre_life_at_start_laps": 2,
        "pit_in": False,
        "pit_out": False,
    }
    base.update(over)
    return LapRow(**base)


def race(n_laps: int = 10) -> list[LapRow]:
    rows: list[LapRow] = []
    t = {"alpha": 0.0, "bravo": 10.0, "charlie": 14.0, "delta": 50.0}
    for lap in range(1, n_laps + 1):
        lt = {"alpha": 90.0, "bravo": 90.0, "charlie": 89.5 if lap > 1 else 90.0, "delta": 90.0}
        if lap in (6, 7):
            lt["bravo"] = 100.0
        for d in t:
            t[d] += lt[d]
        order = sorted(t, key=t.get)  # type: ignore[arg-type]
        for d in t:
            over: dict[str, Any] = {"lap_time_s": lt[d]}
            if d == "bravo" and lap == 6:
                over["pit_in"] = True
            if d == "bravo" and lap == 7:
                over |= {"pit_out": True, "compound": "HARD", "tyre_life_laps": 1}
            if d == "bravo" and lap > 7:
                over |= {"compound": "HARD", "tyre_life_laps": lap - 6}
            rows.append(row(d, lap, round(t[d], 3), order.index(d) + 1, **over))
    return rows


STINTS = [
    E.StintSample(2023, 5, "MEDIUM", 20, False),  # same circuit, earlier
    E.StintSample(2023, 5, "MEDIUM", 24, False),
    E.StintSample(2023, 9, "HARD", 30, False),  # other circuit, earlier
    E.StintSample(2024, 9, "MEDIUM", 99, False),  # same circuit, LATER: never used
]
CIRCUITS = {(2023, 5): "c1", (2023, 9): "c2", (2024, 5): "c1", (2024, 9): "c1"}


def inputs(rows: list[LapRow], **over: Any) -> E.EngineerInputs:
    base: dict[str, Any] = {
        "season": 2024,
        "round": 5,
        "focus_id": "bravo",
        "lap": None,
        "rows": rows,
        "current_probs": {"bravo": (False, 0.31), "charlie": (True, 0.64)},
        "recorded_probs": {},
        "pit_loss_s": 21.0,
        "pit_loss_source": "circuit_prior",
        "circuit_of": CIRCUITS,
        "stints": STINTS,
        "codes": {"alpha": "ALP", "bravo": "BRA", "charlie": "CHA", "delta": "DEL"},
    }
    base.update(over)
    return E.EngineerInputs(**base)


# ------------------------------------------------------------------ order, gaps, trend, pace
def test_order_projects_a_car_that_has_not_completed_the_lap_and_leaves_out_lapped() -> None:
    laps = E.by_driver([row("a", 5, 450.0, 1), row("b", 4, 365.0, 2), row("c", 3, 280.0, 3)], 5)
    order, left = E.order_at(laps, 5)
    assert [(c.driver_id, c.time_s, c.projected) for c in order] == [
        ("a", 450.0, False),
        ("b", 455.0, True),
    ]
    assert left == ["c"]
    assert E.time_at(laps["c"], 5) is None


def test_by_driver_drops_every_lap_after_n() -> None:
    laps = E.by_driver(race(), 4)
    assert all(max(v) == 4 for v in laps.values())


def test_slope_and_gap_series() -> None:
    assert E.slope([(1, 4.0), (2, 3.5), (3, 3.0)]) == -0.5
    assert E.slope([(1, 4.0), (2, 3.5)]) is None
    laps = E.by_driver(race(), 5)
    series = E.gap_series(laps, "bravo", "charlie", 5)
    assert [n for n, _ in series] == [1, 2, 3, 4, 5]
    assert series[0][1] == 4.0 and series[-1][1] == 2.0


def test_pace_skips_lap_1_pit_and_neutralised_laps() -> None:
    laps = E.by_driver(race(), 10)["bravo"]
    assert E.pace(laps, 8, set()) == 90.0  # laps 8, 5, 4 (6 and 7 are pit laps)
    assert E.pace(laps, 3, set()) is None  # only laps 2-3 usable
    assert E.pace(laps, 10, {9, 10}) == 90.0  # 8, 5, 4


def test_stint_laps_and_tyre_life_sources() -> None:
    laps = E.by_driver(race(), 10)["bravo"]
    assert E.stint_laps(laps, 10) == 4 and E.stint_laps(laps, 5) == 5
    assert E.tyre_life(row("x", 3, 1.0, 1)) == (5, "real")
    assert E.tyre_life(row("x", 3, 1.0, 1, tyre_life_laps=None)) == (3, "estimated")
    assert E.tyre_life(row("x", 3, 1.0, 1, tyre_life_laps=None, tyre_age=None)) == (None, "none")


# ------------------------------------------------------------------ neutralisation
def test_estimated_neutral_is_causal() -> None:
    rows = race(8)
    sc = [r if r.lap != 8 else LapRow(**{**r.__dict__, "lap_time_s": 130.0}) for r in rows]
    laps = E.by_driver(sc, 8)
    status, neutral = E.estimated_neutral(laps, 8)
    assert status == "neutralised" and neutral == {8}
    # lap 5 is green whatever happens on lap 8 (the baseline uses earlier laps only)
    assert E.estimated_neutral(E.by_driver(sc, 5), 5)[0] == "green"
    assert E.estimated_neutral(E.by_driver(rows, 2), 2)[0] == "unknown"  # no earlier green lap
    red = [r if r.lap != 8 else LapRow(**{**r.__dict__, "lap_time_s": 400.0}) for r in rows]
    assert E.estimated_neutral(E.by_driver(red, 8), 8)[0] == "red"


def _laps_doc(sc_lap: int, n_rc: int = 1) -> AnalysisLapsOut:
    cov = AnalysisCoverageOut(
        n_drivers=1, n_laps=10, n_lap_rows=10, tyre_source="tracinginsights", is_synthetic=False,
        has_sectors=True, has_speed_traps=True, deleted_known=True,
        neutralised_source="track_status", n_race_control=n_rc, n_pitstops=0, n_quick_laps=0,
        n_ti_only_laps_dropped=0,
    )  # fmt: skip
    rows = []
    for lap in range(1, 11):
        rows.append(
            {
                "driver_id": "alpha", "driver_code": "ALP", "lap": lap, "position": 1,
                "lap_time_s": 90.0, "cumulative_time_s": None, "gap_to_leader_s": 0.0,
                "sector1_s": None, "sector2_s": None, "sector3_s": None, "speed_i1_kph": None,
                "speed_i2_kph": None, "speed_fl_kph": None, "speed_st_kph": None, "stint": 1,
                "compound": "MEDIUM", "tyre_life_laps": lap, "compound_source": "tracinginsights",
                "is_synthetic": False, "is_pit_in_lap": False, "is_pit_out_lap": False,
                "is_deleted": False, "deleted_reason": None,
                "track_status": "4" if lap == sc_lap else "1",
                "is_sc_lap": lap == sc_lap, "is_vsc_lap": False, "is_red_flag_lap": False,
                "is_neutralised_lap": lap == sc_lap, "neutralised_source": "track_status",
                "is_quick_lap": True, "quick_lap_exclusion": None,
            }
        )  # fmt: skip
    return AnalysisLapsOut.model_validate(
        {"season": 2024, "round": 5, "coverage": cov, "rows": rows}
    )


def _rc_doc(cov: AnalysisCoverageOut) -> AnalysisRaceControlsOut:
    msgs = [
        (0, 3, "SAFETY CAR DEPLOYED", "sc_deployed", True),
        (1, 9, "SAFETY CAR IN THIS LAP", "sc_ending", True),
    ]
    rows = [
        {"seq": s, "lap": lap, "time_utc": None, "category": None, "message": m, "status": None,
         "flag": None, "scope": None, "driver_id": None, "driver_code": None, "kind": k,
         "is_key": key}
        for s, lap, m, k, key in msgs
    ]  # fmt: skip
    return AnalysisRaceControlsOut.model_validate(
        {"season": 2024, "round": 5, "coverage": cov, "rows": rows}
    )


def test_lake_neutral_uses_lap_n_and_messages_up_to_n_only() -> None:
    doc = _laps_doc(sc_lap=3)
    rc = _rc_doc(doc.coverage)
    out = E.lake_neutral(doc, rc, 3)
    assert out is not None
    status, neutral = out
    assert (status.status, status.source, status.message_lap) == ("sc", "track_status", 3)
    assert neutral == {3}
    later = E.lake_neutral(doc, rc, 5)
    assert later is not None and later[0].status == "green"
    assert later[0].message == "SAFETY CAR DEPLOYED"  # the lap-9 message is not seen at lap 5
    assert E.lake_neutral(_laps_doc(3, n_rc=0), rc, 3) is None  # no race control: estimate


# ------------------------------------------------------------------ typical stint
def test_typical_stint_circuit_then_all_circuits_then_none_earlier_races_only() -> None:
    med = E.typical_stint("MEDIUM", (2024, 5), CIRCUITS, STINTS)
    assert (med.median_laps, med.n_stints, med.n_races, med.source) == (22.0, 2, 1, "circuit")
    hard = E.typical_stint("HARD", (2024, 5), CIRCUITS, STINTS)
    assert (hard.median_laps, hard.source) == (30.0, "all_circuits")
    assert E.typical_stint("SOFT", (2024, 5), CIRCUITS, STINTS).source == "none"
    assert E.typical_stint(None, (2024, 5), CIRCUITS, STINTS).source == "none"
    # a race before every stint has no history at all
    assert E.typical_stint("MEDIUM", (2023, 1), CIRCUITS, STINTS).source == "none"
    assert E.needs_all_circuits(["MEDIUM"], (2024, 5), CIRCUITS, STINTS) is False
    assert E.needs_all_circuits(["MEDIUM", "HARD"], (2024, 5), CIRCUITS, STINTS) is True


# ------------------------------------------------------------------ rejoin
def _c(d: str, t: float, projected: bool = False) -> E.Crossing:
    return E.Crossing(d, t, projected)


def test_rejoin_position_neighbours_gaps_and_traffic() -> None:
    focus = _c("f", 100.0)
    others = [_c("a", 90.0), _c("b", 105.0), _c("c", 119.5), _c("d", 125.0)]
    out = E.rejoin(focus, others, 21.0, "circuit_prior", "green", 1)
    assert (out.position, out.ahead_id, out.behind_id) == (4, "c", "d")
    assert (out.gap_ahead_s, out.gap_behind_s, out.in_traffic) == (1.5, 4.0, True)
    assert out.reliable and out.reasons == [] and out.left_out == 1
    assert out.pit_loss_text == "circuit prior from earlier races"
    assert [c.driver_id for c in out.field] == ["a", "b", "c", "d"]
    clear = E.rejoin(focus, [_c("c", 117.0)], 21.0, "global_prior", "green", 0)
    assert clear.in_traffic is False and clear.behind_id is None and clear.position == 2
    assert clear.pit_loss_text.startswith("all-circuit prior")


def test_rejoin_unreliable_under_sc_without_prior_or_with_projected_cars() -> None:
    focus = _c("f", 100.0)
    sc = E.rejoin(focus, [_c("a", 110.0)], 21.0, "circuit_prior", "sc", 0)
    assert not sc.reliable and sc.reasons == ["SC"]
    none = E.rejoin(focus, [_c("a", 110.0)], None, "none", "green", 0)
    assert none.position is None and not none.reliable and none.reasons == ["no pit-loss prior"]
    proj = E.rejoin(focus, [_c("a", 120.0, projected=True)], 21.0, "circuit_prior", "green", 0)
    assert not proj.reliable and proj.reasons == ["projected cars near the rejoin point"]


# ------------------------------------------------------------------ the whole view
def test_build_cards_pairs_and_calls() -> None:
    out = E.build(inputs(race(5)))
    assert (out.lap, out.current_lap, out.history_from_lap) == (5, 5, 1)
    assert (out.ahead.driver_id, out.focus.driver_id, out.behind.driver_id) == (  # type: ignore[union-attr]
        "alpha",
        "bravo",
        "charlie",
    )
    assert (out.focus.position, out.focus.compound, out.focus.tyre_life_laps) == (2, "MEDIUM", 7)
    pa, pb = out.pair_ahead, out.pair_behind
    assert pa is not None and pb is not None
    assert (pa.gap_s, pa.trend_s_per_lap, pa.prob, pa.prob_role) == (
        10.0,
        0.0,
        0.31,
        "focus_on_ahead",
    )
    assert (pb.gap_s, pb.trend_s_per_lap, pb.prob, pb.prob_role) == (2.0, -0.5, 0.64, "threat")
    assert pb.pair_matches is True and len(pb.gaps) == 5
    assert out.focus.typical_stint.median_laps == 22.0
    ids = [c.id for c in out.calls]
    assert ids == ["threat", "being_caught", "rejoin"]
    texts = {c.id: c.text for c in out.calls}
    assert texts["threat"] == "Under threat from behind: CHA 64%"
    assert texts["being_caught"] == "CHA closing: 0.50 s/lap, gap 2.0 s"
    assert texts["rejoin"] == "Pit now rejoins P3 behind CHA, clear (19.0 s)"
    assert out.neutralised.source == "estimated" and out.neutralised.status == "green"
    assert out.disclaimer.endswith("not model output.")


def test_call_rules_and_their_edges() -> None:
    out = E.build(inputs(race(5), current_probs={"bravo": (True, 0.5), "charlie": (False, 0.49)}))
    ids = [c.id for c in out.calls]
    assert "undercut_window" in ids and "threat" not in ids  # >= 0.5 fires, 0.49 does not
    assert next(c.text for c in out.calls if c.id == "undercut_window") == (
        "Undercut window open on ALP: 50%"
    )
    long = E.build(inputs(race(10), lap=5, stints=[E.StintSample(2023, 5, "MEDIUM", 5, False)]))
    assert any(c.id == "long_stint" and "past the typical 5" in c.text for c in long.calls)
    tyres = E.build(inputs(race(10)))  # after its stop bravo (HARD, life 4) is behind charlie (12)
    assert tyres.ahead is not None and tyres.ahead.driver_id == "charlie"
    assert tyres.ahead.tyre_life_delta_laps == 8
    assert any(
        c.id == "tyre_offset" and c.text == "CHA's tyres are 8 laps older" for c in tyres.calls
    )


def test_no_hindsight_lap_n_is_unchanged_by_later_laps_and_later_races() -> None:
    probs = {n: {"bravo": (False, 0.2), "charlie": (True, 0.6)} for n in range(1, 11)}
    early = E.build(inputs(race(5), lap=5, recorded_probs=probs, current_probs=None))
    later_stints = [*STINTS, E.StintSample(2024, 7, "MEDIUM", 1, False)]
    later = E.build(
        inputs(
            race(10),
            lap=5,
            recorded_probs=probs,
            current_probs={"bravo": (True, 0.99), "charlie": (True, 0.99)},
            stints=later_stints,
            circuit_of={**CIRCUITS, (2024, 7): "c1"},
        )
    )
    assert later.model_dump(exclude={"current_lap"}) == early.model_dump(exclude={"current_lap"})
    assert (early.current_lap, later.current_lap) == (5, 10)


def test_recorded_probabilities_for_an_earlier_lap_and_not_recorded() -> None:
    out = E.build(inputs(race(10), lap=4, recorded_probs={4: {"bravo": (True, 0.7)}}))
    assert (
        out.pair_ahead is not None and out.pair_ahead.prob == 0.7 and out.pair_ahead.prob_recorded
    )
    missing = E.build(inputs(race(10), lap=3, recorded_probs={}))
    assert missing.pair_ahead is not None and missing.pair_ahead.prob is None
    assert missing.pair_ahead.prob_recorded is False


def test_lake_track_status_makes_the_rejoin_unreliable() -> None:
    doc = _laps_doc(sc_lap=5)
    out = E.build(inputs(race(5), laps_doc=doc, rc_doc=_rc_doc(doc.coverage)))
    assert (out.neutralised.status, out.neutralised.source) == ("sc", "track_status")
    assert not out.rejoin.reliable and out.rejoin.reasons == ["SC"]
    assert any(c.id == "rejoin" and c.text.endswith("estimate unreliable: SC") for c in out.calls)


def test_leader_and_last_car_have_one_neighbour() -> None:
    lead = E.build(inputs(race(5), focus_id="alpha"))
    assert lead.ahead is None and lead.pair_ahead is None and lead.behind is not None
    last = E.build(inputs(race(5), focus_id="delta"))
    assert last.behind is None and last.pair_behind is None


def test_errors_unknown_driver_and_lap_out_of_range() -> None:
    with pytest.raises(E.EngineerError) as exc:
        E.build(inputs(race(5), focus_id="zulu"))
    assert exc.value.status == 404
    with pytest.raises(E.EngineerError) as exc:
        E.build(inputs(race(5), lap=6))
    assert exc.value.status == 409 and "laps 1-5" in exc.value.detail


def test_pair_matches_uses_the_position_at_lap_n_minus_1() -> None:
    laps = E.by_driver(race(5), 5)
    assert E._pair_matches(laps, "charlie", "bravo", 5) is True
    assert E._pair_matches(laps, "charlie", "alpha", 5) is False
    assert E._pair_matches(laps, "charlie", "bravo", 1) is None


def test_gap_trend_starts_after_a_pit_lap_of_either_car() -> None:
    laps = E.by_driver(race(10), 10)
    # bravo pitted on lap 6 (in) and 7 (out): its gap to alpha is measured from lap 8 only
    series = E.gap_series(laps, "alpha", "bravo", 10)
    assert [n for n, _ in series] == [8, 9, 10]
    assert E.slope(series) == 0.0
    assert [n for n, _ in E.gap_series(laps, "alpha", "bravo", 7)] == []


def test_threat_needs_the_pair_to_match_too() -> None:
    out = E.build(inputs(race(5)))
    pb = out.pair_behind
    assert pb is not None and pb.prob == 0.64
    mismatch = E.strategy_calls(
        lambda d: d[:3].upper(),
        out.focus,
        out.ahead,
        out.behind,
        out.pair_ahead,
        pb.model_copy(update={"pair_matches": False}),
        out.rejoin,
    )
    assert "threat" not in [c.id for c in mismatch]
