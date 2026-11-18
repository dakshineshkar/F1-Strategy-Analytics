"""Distance resampling of one lap (``etl.telemetry_resample``, Feature 6): exact maths on small
hand-made laps (no F1 data)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest

from f1sa.etl import telemetry_resample as R
from f1sa.features.telemetry_agg import FULL_THROTTLE_PCT
from f1sa.lake import schemas_telemetry_trace as TT


def _lap(t: list[float], d: list[float], **channels: list[Any]) -> pd.DataFrame:
    n = len(t)
    base: dict[str, Any] = {
        "time_in_lap_s": t,
        "distance_m": d,
        "speed_kph": [200.0] * n,
        "throttle_pct": [100.0] * n,
        "rpm": [11000.0] * n,
        "n_gear": [7] * n,
        "brake": [False] * n,
        "drs": [0] * n,
    }
    base.update(channels)
    return pd.DataFrame(base)


def _constant(
    speed_ms: float, length_m: float, dt: float = 0.1, **channels: list[Any]
) -> pd.DataFrame:
    t = list(np.arange(0.0, length_m / speed_ms + 1e-9, dt))
    if t[-1] < length_m / speed_ms - 1e-9:
        t.append(length_m / speed_ms)
    d = [speed_ms * x for x in t]
    return _lap(t, d, **{k: v(len(t)) if callable(v) else v for k, v in channels.items()})


# ------------------------------------------------------------------ grid
def test_grid_is_every_step_plus_the_final_distance() -> None:
    assert R.distance_grid(12.0, 5.0).tolist() == [0.0, 5.0, 10.0, 12.0]
    assert R.distance_grid(10.0, 5.0).tolist() == [0.0, 5.0, 10.0]
    assert R.distance_grid(3.0, 5.0).tolist() == [0.0, 3.0]
    for bad in (0.0, -1.0, float("nan"), float("inf")):
        with pytest.raises(ValueError):
            R.distance_grid(bad)
    with pytest.raises(ValueError):
        R.distance_grid(10.0, 0.0)


def test_hold_takes_the_last_value_at_or_before() -> None:
    xp = np.array([0.0, 2.0, 4.0])
    fp = np.array([1.0, 2.0, 3.0])
    assert R.hold(np.array([-1.0, 0.0, 1.9, 2.0, 3.9, 4.0, 9.0]), xp, fp).tolist() == [
        1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0,
    ]  # fmt: skip


# ------------------------------------------------------------------ resampling
def test_constant_speed_gives_exact_linear_time_and_keeps_the_finish() -> None:
    trace = R.resample_lap(_constant(50.0, 1002.0))
    assert trace is not None
    assert trace.lap_length_m == pytest.approx(1002.0)
    assert trace.distance_m[:3].tolist() == [0.0, 5.0, 10.0]
    assert trace.distance_m[-2:].tolist() == pytest.approx([1000.0, 1002.0])
    assert len(trace.distance_m) == 202
    np.testing.assert_allclose(trace.elapsed_s, trace.distance_m / 50.0, atol=1e-9)
    assert trace.trace_time_s == pytest.approx(1002.0 / 50.0)
    assert trace.n_corrected == 0 and trace.max_gap_s == pytest.approx(0.1)
    for arr in (
        trace.speed_kph,
        trace.throttle_pct,
        trace.rpm,
        trace.brake,
        trace.n_gear,
        trace.drs,
    ):
        assert len(arr) == len(trace.distance_m)


def test_continuous_channels_are_linear_and_discrete_ones_hold() -> None:
    lap = _lap(
        [0.0, 1.0, 2.0],
        [0.0, 10.0, 20.0],
        speed_kph=[100.0, 200.0, 300.0],
        throttle_pct=[0.0, 50.0, 100.0],
        rpm=[8000.0, 10000.0, 12000.0],
        n_gear=[3, 4, 5],
        brake=[True, False, False],
        drs=[0, 0, 1],
    )
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.distance_m.tolist() == [0.0, 5.0, 10.0, 15.0, 20.0]
    assert trace.elapsed_s.tolist() == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert trace.speed_kph.tolist() == [100.0, 150.0, 200.0, 250.0, 300.0]
    assert trace.throttle_pct.tolist() == [0.0, 25.0, 50.0, 75.0, 100.0]
    assert trace.rpm.tolist() == [8000.0, 9000.0, 10000.0, 11000.0, 12000.0]
    assert trace.n_gear.tolist() == [3, 3, 4, 4, 5]
    assert trace.brake.tolist() == [1, 1, 0, 0, 0]
    assert trace.drs.tolist() == [0, 0, 0, 0, 1]


def test_backward_jitter_is_clamped_and_counted() -> None:
    lap = _lap([0.0, 0.1, 0.2, 0.3, 1.0], [0.01, -0.1, 0.005, 2.0, 10.0])
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.n_corrected == 2  # -0.1 -> 0.01 and 0.005 -> 0.01
    assert np.all(np.diff(trace.elapsed_s) >= 0)
    assert trace.distance_m.tolist() == [0.0, 5.0, 10.0]


def test_a_standstill_collapses_to_the_time_the_car_leaves() -> None:
    # stopped at 10 m from t=1 to t=5 (a pit stop), then drives on
    lap = _lap(
        [0.0, 1.0, 3.0, 5.0, 6.0],
        [0.0, 10.0, 10.0, 10.0, 20.0],
        speed_kph=[36.0, 0.0, 0.0, 0.0, 36.0],
    )
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.elapsed_s.tolist() == pytest.approx([0.0, 2.5, 5.0, 5.5, 6.0])
    assert trace.trace_time_s == 6.0 and trace.max_gap_s == 2.0


def test_samples_are_sorted_by_time_and_nulls_dropped() -> None:
    lap = _lap(
        [2.0, 0.0, None, 1.0],
        [20.0, 0.0, 5.0, None],
        speed_kph=[300.0, 100.0, 999.0, 200.0],
    )
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.n_samples == 4  # input samples (the summary counts what was received)
    assert trace.elapsed_s.tolist() == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert trace.top_speed_kph == 300.0 and trace.top_speed_at_m == 20.0


def test_missing_channel_values_carry_the_previous_value() -> None:
    lap = _lap(
        [0.0, 1.0, 2.0],
        [0.0, 10.0, 20.0],
        speed_kph=[100.0, None, 300.0],
        brake=[True, None, False],
    )
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.speed_kph.tolist() == [100.0, 100.0, 100.0, 200.0, 300.0]
    assert trace.brake.tolist() == [1, 1, 1, 1, 0]


@pytest.mark.parametrize(
    "t, d",
    [
        ([], []),
        ([0.0], [0.0]),
        ([0.0, None], [0.0, 5.0]),
        ([0.0, 1.0], [0.0, 0.0]),  # never moves
        ([0.0, 1.0], [-1.0, -0.5]),  # only negative distances
    ],
)
def test_a_lap_without_two_usable_samples_or_distance_has_no_trace(
    t: list[Any], d: list[Any]
) -> None:
    assert R.resample_lap(_lap(t, d)) is None


# ------------------------------------------------------------------ summary
def test_shares_are_distance_weighted_on_the_grid() -> None:
    # 0-100 m full throttle, 100-150 m braking, 150-200 m DRS open, at 10 m/s
    t = [x / 10 for x in range(0, 201, 5)]
    d = [x * 10 for x in t]
    n = len(t)
    lap = _lap(
        t,
        d,
        throttle_pct=[FULL_THROTTLE_PCT if x < 100 else 0.0 for x in d],
        brake=[100 <= x < 150 for x in d],
        drs=[1 if x >= 150 else 0 for x in d],
        speed_kph=[300.0 - x for x in d][:n],
    )
    trace = R.resample_lap(lap)
    assert trace is not None
    assert trace.full_throttle_share == pytest.approx(0.5)
    assert trace.brake_share == pytest.approx(0.25)
    assert trace.drs_share == pytest.approx(0.25)


def test_braking_zones_merge_short_gaps_drop_flickers_and_find_the_apex() -> None:
    grid = np.arange(0.0, 501.0, 5.0)
    brake = np.zeros(len(grid), dtype=np.int8)
    brake[(grid >= 100) & (grid < 130)] = 1  # zone 1: 100-130 m
    brake[(grid >= 140) & (grid < 150)] = 1  # 10 m gap -> merged into zone 1 (100-150 m)
    brake[grid == 300] = 1  # a 5 m flicker -> dropped
    brake[(grid >= 400) & (grid < 420)] = 1  # zone 2: 400-420 m
    speed = np.full(len(grid), 250.0)
    speed[grid == 160] = 80.0  # zone 1's apex (inside the 200 m after its end)
    speed[grid == 380] = 50.0  # before zone 2 and after zone 1's window: never an apex
    speed[grid == 430] = 95.0  # zone 2's apex
    zones = R.braking_zones(grid, brake, speed)
    assert [(z.start_m, z.end_m, z.apex_kph, z.apex_at_m) for z in zones] == [
        (100.0, 150.0, 80.0, 160.0),
        (400.0, 420.0, 95.0, 430.0),
    ]


def test_the_apex_window_stops_at_the_next_zone() -> None:
    grid = np.arange(0.0, 301.0, 5.0)
    brake = np.zeros(len(grid), dtype=np.int8)
    brake[(grid >= 50) & (grid < 70)] = 1
    brake[(grid >= 120) & (grid < 140)] = 1
    speed = np.full(len(grid), 200.0)
    speed[grid == 130] = 60.0  # inside zone 2, so not zone 1's apex
    speed[grid == 90] = 110.0
    zones = R.braking_zones(grid, brake, speed)
    assert [(z.apex_kph, z.apex_at_m) for z in zones] == [(110.0, 90.0), (60.0, 130.0)]


def test_min_corner_is_the_lowest_apex_and_none_without_zones() -> None:
    lap = _constant(50.0, 400.0, brake=lambda n: [False] * n)
    trace = R.resample_lap(lap)
    assert trace is not None and trace.zones == () and trace.min_corner is None
    row = R.to_row({"season": 2024, "round": 5, "driver_code": "AAA", "lap": 3}, trace)
    assert row["min_corner_speed_kph"] is None and row["n_braking_zones"] == 0
    assert row["braking_start_m"] == []


# ------------------------------------------------------------------ rows
def test_to_row_has_the_resampled_schema_and_rounds() -> None:
    trace = R.resample_lap(_constant(50.0, 1002.0))
    assert trace is not None
    row = R.to_row({"season": 2024, "round": 5, "driver_code": "AAA", "lap": 3}, trace)
    assert tuple(row) == R.RESAMPLED_COLUMNS == tuple(TT.RESAMPLED.fieldNames())
    assert row["elapsed_s"][-1] == pytest.approx(20.04, abs=1e-5)
    assert row["lap_length_m"] == 1002.0 and row["trace_time_s"] == 20.04
    assert set(row["brake"]) <= {0, 1} and row["n_gear"][0] == 7


def test_resample_group_returns_zero_or_one_rows() -> None:
    lap = _constant(50.0, 100.0).assign(season=2024, round=5, driver_code="AAA", lap=2)
    out = R.resample_group(lap)
    assert len(out) == 1 and list(out.columns) == list(R.RESAMPLED_COLUMNS)
    assert out.iloc[0]["lap"] == 2 and out.iloc[0]["driver_code"] == "AAA"
    empty = R.resample_group(lap.iloc[:1])
    assert empty.empty and list(empty.columns) == list(R.RESAMPLED_COLUMNS)
    assert R.resample_group(lap.iloc[:0]).empty
