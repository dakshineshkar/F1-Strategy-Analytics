"""Delta-time and overlay maths of the telemetry compare (``api.telemetry``, Feature 6), on exact
hand-made laps (constant speeds, so every elapsed time is known in closed form)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from f1sa.api import telemetry as T
from f1sa.api.models import TelemetryLapOut, TelemetryTraceOut


def summary(lap: int = 1, **over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {c: None for c in TelemetryLapOut.model_fields}
    row.update(
        lap=lap, lap_time_s=None, trace_time_s=1.0, lap_length_m=1.0, n_samples=10, max_gap_s=0.1,
        coverage="full", brake_share=0.0, drs_share=0.0, n_braking_zones=0,
    )  # fmt: skip
    row.update(over)
    return row


def trace(
    code: str,
    speed_ms: float,
    length_m: float,
    *,
    lap: int = 1,
    step: float = 5.0,
    lap_time_s: float | None = None,
    **arrays: list[Any],
) -> TelemetryTraceOut:
    grid = np.arange(0.0, length_m + 1e-9, step)
    if length_m - grid[-1] > 1e-9:
        grid = np.append(grid, length_m)
    n = len(grid)
    doc: dict[str, Any] = {
        "season": 2024,
        "round": 5,
        "driver_id": code.lower(),
        "driver_code": code,
        "is_synthetic": False,
        "source": "tracinginsights",
        "grid_step_m": step,
        "summary": summary(
            lap, lap_time_s=lap_time_s, trace_time_s=length_m / speed_ms, lap_length_m=length_m
        ),
        "distance_m": grid.tolist(),
        "elapsed_s": (grid / speed_ms).tolist(),
        "speed_kph": [speed_ms * 3.6] * n,
        "throttle_pct": [100.0] * n,
        "rpm": [11000.0] * n,
        "brake": [0] * n,
        "n_gear": [7] * n,
        "drs": [0] * n,
        "braking_start_m": [],
        "braking_end_m": [],
        "braking_apex_kph": [],
    }
    doc.update(arrays)
    return TelemetryTraceOut.model_validate(doc)


def test_equal_lengths_give_the_closed_form_delta() -> None:
    a, b = trace("AAA", 50.0, 1000.0), trace("BBB", 40.0, 1000.0)
    out = T.compare_traces(a, b)
    x = np.asarray(out.distance_m)
    np.testing.assert_allclose(out.delta_s, x / 50 - x / 40, atol=1e-3)
    assert out.final_delta_s == pytest.approx(1000 / 50 - 1000 / 40)  # -5 s: a ahead at the line
    assert out.a.speed_kph[0] == 180.0 and out.b.speed_kph[0] == 144.0
    assert out.b.own_distance_m == out.distance_m


def test_unequal_lengths_are_compared_at_the_same_lap_fraction() -> None:
    # b's integrated lap is 1% longer; at the same pace per lap fraction the delta is 0 everywhere
    a, b = trace("AAA", 50.0, 1000.0), trace("BBB", 50.5, 1010.0)
    out = T.compare_traces(a, b)
    assert max(abs(d) for d in out.delta_s) <= 0.001
    assert out.b.own_distance_m[-1] == 1010.0 and out.distance_m[-1] == 1000.0
    # at equal raw metres the finish line would be wrong: b's time at a's line is not b's lap
    assert out.final_delta_s == pytest.approx(
        a.summary.trace_time_s - b.summary.trace_time_s, abs=1e-3
    )


def test_the_final_delta_is_the_lap_time_difference() -> None:
    a = trace("AAA", 50.0, 1000.0, lap_time_s=20.0)
    b = trace("BBB", 40.0, 1003.0, lap_time_s=25.075)
    out = T.compare_traces(a, b)
    assert out.final_delta_s == pytest.approx(20.0 - 1003.0 / 40.0, abs=1e-3)
    assert out.lap_time_delta_s == pytest.approx(20.0 - 25.075)
    assert T.compare_traces(a, trace("BBB", 40.0, 1000.0)).lap_time_delta_s is None


def test_segments_add_up_to_the_change_of_the_delta() -> None:
    a = trace("AAA", 50.0, 1002.0)
    b = trace("BBB", 45.0, 998.0)
    out = T.compare_traces(a, b)
    assert len(out.segments) == T.N_SEGMENTS
    assert out.segments[0].start_m == 0.0 and out.segments[-1].end_m == 1002.0
    total = sum(s.delta_change_s for s in out.segments)
    assert total == pytest.approx(out.delta_s[-1] - out.delta_s[0], abs=T.N_SEGMENTS * 0.0005)
    assert all(s.delta_change_s < 0 for s in out.segments)  # a is faster everywhere


def test_segment_changes_telescope_exactly() -> None:
    axis = np.linspace(0, 100, 21)
    delta = np.sin(axis / 10)
    parts = T.segment_changes(axis, delta, 7)
    assert sum(c for _, _, c in parts) == pytest.approx(delta[-1] - delta[0], abs=1e-12)
    with pytest.raises(ValueError):
        T.segment_changes(axis, delta, 0)


def test_where_a_loses_time_is_where_the_delta_rises() -> None:
    # a is slower (25 m/s) over 400-600 m only; b holds 50 m/s throughout
    grid = np.arange(0.0, 1001.0, 5.0)
    seg = np.clip(grid - 400, 0, 200)
    t_a = grid / 50 + seg / 25 - seg / 50
    a = trace("AAA", 50.0, 1000.0, elapsed_s=t_a.tolist())
    b = trace("BBB", 50.0, 1000.0)
    out = T.compare_traces(a, b)
    worst = max(out.segments, key=lambda s: s.delta_change_s)
    assert 400 <= worst.start_m < 600 and worst.delta_change_s > 0
    assert out.final_delta_s == pytest.approx(4.0)
    assert all(
        abs(s.delta_change_s) < 1e-9 for s in out.segments if s.end_m <= 400 or s.start_m >= 600
    )


def test_discrete_channels_hold_and_continuous_interpolate() -> None:
    n_b = 201  # b: 1000 m on a 5 m grid
    b = trace(
        "BBB",
        50.0,
        1000.0,
        n_gear=[3 if i < 100 else 8 for i in range(n_b)],
        speed_kph=list(np.linspace(100.0, 300.0, n_b)),
    )
    a = trace("AAA", 50.0, 500.0, step=2.5)  # a's grid point k is b's lap fraction k/200
    out = T.compare_traces(a, b)
    half = out.distance_m.index(250.0)  # lap fraction 0.5 = b's 500 m
    assert out.b.n_gear[half] == 8 and out.b.n_gear[half - 1] == 3
    assert out.b.speed_kph[half] == pytest.approx(200.0)
    assert out.b.speed_kph[1] == pytest.approx(100.0 + 200.0 * (5.0 / 1000.0), abs=0.05)


def test_braking_zones_of_b_are_mapped_onto_a_axis() -> None:
    b = trace(
        "BBB", 50.0, 1010.0, braking_start_m=[505.0], braking_end_m=[606.0], braking_apex_kph=[80.0]
    )
    out = T.compare_traces(trace("AAA", 50.0, 1000.0), b)
    assert out.b.braking_start_m == [500.0] and out.b.braking_end_m == [600.0]
    assert out.b.braking_apex_kph == [80.0]


def test_fastest_lap_prefers_clean_full_laps() -> None:
    rows = [
        TelemetryLapOut.model_validate(summary(1, lap_time_s=89.0, is_pit_out_lap=True)),
        TelemetryLapOut.model_validate(summary(2, lap_time_s=89.5, is_deleted=True)),
        TelemetryLapOut.model_validate(summary(3, lap_time_s=90.0, coverage="partial")),
        TelemetryLapOut.model_validate(summary(4, lap_time_s=91.0)),
        TelemetryLapOut.model_validate(summary(5, lap_time_s=90.5)),
    ]
    assert T.fastest_lap(rows) == 5
    no_times = [TelemetryLapOut.model_validate(summary(k, trace_time_s=100.0 - k)) for k in (1, 2)]
    assert T.fastest_lap(no_times) == 2
    partial = [TelemetryLapOut.model_validate(summary(1, coverage="partial", trace_time_s=9.0))]
    assert T.fastest_lap(partial) == 1 and T.fastest_lap([]) is None


def test_a_trace_with_mismatched_arrays_is_invalid() -> None:
    with pytest.raises(ValueError):
        trace("AAA", 50.0, 100.0, speed_kph=[1.0])
    with pytest.raises(ValueError):
        trace("AAA", 50.0, 100.0, distance_m=[0.0] * 21)
    with pytest.raises(ValueError):
        trace("AAA", 50.0, 100.0, braking_start_m=[1.0])
