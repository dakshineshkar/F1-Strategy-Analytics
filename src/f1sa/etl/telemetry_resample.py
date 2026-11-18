"""Distance resampling of one lap's raw telemetry samples (Feature 6, display only).

Pure numpy / pandas, so the maths is unit-tested without Spark; ``etl.telemetry_trace`` runs
``resample_group`` once per (season, round, driver_code, lap) with ``applyInPandas``.

Rules, in order (``resample_lap``):

1. Samples without a time or a distance are dropped; the rest are sorted by time (stable). Fewer
   than 2 samples give no trace.
2. ``d = cummax(max(distance, 0))``. TracingInsights integrates the distance per lap, so it can
   step back by a few centimetres at the start or at a standstill; such a sample is moved forward
   and counted (``n_corrected``). Consecutive samples at the same distance (a standstill) collapse
   into the last one: the time and channels when the car leaves that point.
3. The grid is ``0, step, 2·step, … ⌊L/step⌋·step`` plus ``L`` itself when it is not on the grid
   (``L`` = the lap's final distance), so the finish line keeps its time. ``L <= 0`` gives no trace.
4. Elapsed time, speed, throttle and RPM are interpolated linearly in distance. Gear, brake and DRS
   are discrete: each grid point holds the value of the last sample at or before it.
5. Summary: the top speed and where it is from the raw samples (not the grid); the shares
   (full throttle at ``FULL_THROTTLE_PCT``, brake, DRS) are distance shares on the grid (each
   interval weighted by its length, valued at its start). Braking zones are runs of brake = 1 on
   the grid, merged across gaps of at most ``MERGE_GAP_M`` and kept when at least
   ``MIN_ZONE_M`` long; a zone's apex is the lowest grid speed from its start to ``APEX_AFTER_M``
   after its end (or to the next zone's start); the minimum corner speed is the lowest apex.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from f1sa.features.telemetry_agg import FULL_THROTTLE_PCT
from f1sa.lake.schemas_telemetry_trace import GRID_STEP_M, RESAMPLED

MERGE_GAP_M = 10.0
MIN_ZONE_M = 10.0
APEX_AFTER_M = 200.0
_EPS_M = 1e-6
RESAMPLED_COLUMNS: tuple[str, ...] = tuple(RESAMPLED.fieldNames())
_KEYS = ("season", "round", "driver_code", "lap")


@dataclass(frozen=True)
class BrakingZone:
    start_m: float
    end_m: float
    apex_kph: float
    apex_at_m: float


@dataclass(frozen=True)
class LapTrace:
    """One lap on the distance grid (arrays of equal length) plus its summary."""

    n_samples: int
    n_corrected: int
    lap_length_m: float
    trace_time_s: float
    max_gap_s: float
    distance_m: np.ndarray
    elapsed_s: np.ndarray
    speed_kph: np.ndarray
    throttle_pct: np.ndarray
    rpm: np.ndarray
    brake: np.ndarray
    n_gear: np.ndarray
    drs: np.ndarray
    top_speed_kph: float | None
    top_speed_at_m: float | None
    full_throttle_share: float | None
    brake_share: float
    drs_share: float
    zones: tuple[BrakingZone, ...]

    @property
    def min_corner(self) -> BrakingZone | None:
        return min(self.zones, key=lambda z: (z.apex_kph, z.start_m)) if self.zones else None


def distance_grid(length_m: float, step_m: float = GRID_STEP_M) -> np.ndarray:
    """``0, step, … ⌊L/step⌋·step`` plus ``L`` when it is not on the grid."""
    if not (math.isfinite(length_m) and length_m > 0):
        raise ValueError(f"lap length must be positive, got {length_m!r}")
    if not (math.isfinite(step_m) and step_m > 0):
        raise ValueError(f"grid step must be positive, got {step_m!r}")
    n = math.floor(length_m / step_m + 1e-9)
    grid = np.arange(n + 1, dtype=np.float64) * step_m
    if length_m - grid[-1] > _EPS_M:
        grid = np.append(grid, length_m)
    return grid


def hold(x: np.ndarray, xp: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """The value of the last ``xp`` at or before each ``x`` (the first one before ``xp[0]``)."""
    idx = np.searchsorted(xp, x, side="right") - 1
    return fp[np.clip(idx, 0, len(fp) - 1)]


def _numeric(frame: pd.DataFrame, column: str) -> np.ndarray:
    """A column as float64 (booleans 0/1; nulls and unparseable values NaN)."""
    series = frame[column]
    if pd.api.types.is_bool_dtype(series.dtype):
        series = series.astype("Float64")
    out: np.ndarray = pd.to_numeric(series, errors="coerce").to_numpy(
        dtype=np.float64, na_value=np.nan
    )
    return out


def _fill(values: np.ndarray, default: float) -> np.ndarray:
    """Missing channel values carry the previous known value (else the next, else ``default``)."""
    out: np.ndarray = pd.Series(values).ffill().bfill().fillna(default).to_numpy(dtype=np.float64)
    return out


def _share(grid: np.ndarray, mask: np.ndarray) -> float:
    widths = np.diff(grid)
    total = float(widths.sum())
    return float((widths * mask[:-1]).sum() / total) if total > 0 else 0.0


def braking_zones(
    grid: np.ndarray,
    brake: np.ndarray,
    speed: np.ndarray,
    *,
    merge_gap_m: float = MERGE_GAP_M,
    min_zone_m: float = MIN_ZONE_M,
    apex_after_m: float = APEX_AFTER_M,
) -> tuple[BrakingZone, ...]:
    """Braking zones on the grid (see the module rules); a run covers
    ``[g_first, g_after_last)``."""
    on = np.asarray(brake, dtype=bool)
    n = len(grid)
    runs: list[list[float]] = []
    i = 0
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and on[j + 1]:
            j += 1
        end = float(grid[j + 1]) if j + 1 < n else float(grid[j])
        start = float(grid[i])
        if runs and start - runs[-1][1] <= merge_gap_m + _EPS_M:
            runs[-1][1] = end
        else:
            runs.append([start, end])
        i = j + 1
    kept = [r for r in runs if r[1] - r[0] >= min_zone_m - _EPS_M]
    zones: list[BrakingZone] = []
    for k, (start, end) in enumerate(kept):
        stop = end + apex_after_m
        if k + 1 < len(kept):
            stop = min(stop, kept[k + 1][0])
        window = (grid >= start - _EPS_M) & (grid <= stop + _EPS_M)
        idx = np.flatnonzero(window)
        best = int(idx[np.argmin(speed[idx])])
        zones.append(
            BrakingZone(
                start_m=start, end_m=end, apex_kph=float(speed[best]), apex_at_m=float(grid[best])
            )
        )
    return tuple(zones)


def resample_lap(samples: pd.DataFrame, step_m: float = GRID_STEP_M) -> LapTrace | None:
    """One lap's samples (``time_in_lap_s``, ``distance_m``, ``speed_kph``, ``throttle_pct``,
    ``rpm``, ``n_gear``, ``brake``, ``drs``) on the distance grid; ``None`` when the lap has fewer
    than 2 usable samples or no distance."""
    t_all = _numeric(samples, "time_in_lap_s")
    d_all = _numeric(samples, "distance_m")
    valid = np.isfinite(t_all) & np.isfinite(d_all)
    if int(valid.sum()) < 2:
        return None
    frame = samples.loc[valid].copy()
    frame["_t"] = t_all[valid]
    frame["_d"] = d_all[valid]
    frame = frame.sort_values("_t", kind="stable")
    t = frame["_t"].to_numpy(dtype=np.float64)
    raw_d = frame["_d"].to_numpy(dtype=np.float64)
    d = np.maximum.accumulate(np.maximum(raw_d, 0.0))
    n_corrected = int(np.sum(np.abs(d - raw_d) > 1e-9))
    max_gap = float(np.max(np.diff(t))) if len(t) > 1 else 0.0

    speed_raw = _numeric(frame, "speed_kph")
    finite_speed = np.isfinite(speed_raw)
    top_speed = top_at = None
    if finite_speed.any():
        k = int(np.nanargmax(np.where(finite_speed, speed_raw, -np.inf)))
        top_speed, top_at = float(speed_raw[k]), float(d[k])

    channels = {
        "speed": _fill(speed_raw, 0.0),
        "throttle": _fill(_numeric(frame, "throttle_pct"), 0.0),
        "rpm": _fill(_numeric(frame, "rpm"), 0.0),
        "gear": _fill(_numeric(frame, "n_gear"), 0.0),
        "brake": _fill(_numeric(frame, "brake"), 0.0),
        "drs": _fill(_numeric(frame, "drs"), 0.0),
    }
    last = np.r_[d[1:] != d[:-1], True]  # the last sample of each run at one distance
    d, t = d[last], t[last]
    channels = {k: v[last] for k, v in channels.items()}
    length = float(d[-1])
    if len(d) < 2 or length <= 0:
        return None

    grid = distance_grid(length, step_m)
    elapsed = np.interp(grid, d, t)
    speed = np.interp(grid, d, channels["speed"])
    throttle = np.interp(grid, d, channels["throttle"])
    rpm = np.interp(grid, d, channels["rpm"])
    gear = hold(grid, d, channels["gear"])
    brake = (hold(grid, d, channels["brake"]) > 0.5).astype(np.int8)
    drs = (hold(grid, d, channels["drs"]) > 0.5).astype(np.int8)
    return LapTrace(
        n_samples=len(samples),
        n_corrected=n_corrected,
        lap_length_m=length,
        trace_time_s=float(elapsed[-1]),
        max_gap_s=max_gap,
        distance_m=grid,
        elapsed_s=elapsed,
        speed_kph=speed,
        throttle_pct=throttle,
        rpm=rpm,
        brake=brake,
        n_gear=np.clip(np.round(gear), 0, 127).astype(np.int8),
        drs=drs,
        top_speed_kph=top_speed,
        top_speed_at_m=top_at,
        full_throttle_share=_share(grid, throttle >= FULL_THROTTLE_PCT),
        brake_share=_share(grid, brake.astype(bool)),
        drs_share=_share(grid, drs.astype(bool)),
        zones=braking_zones(grid, brake, speed),
    )


def _f32(values: np.ndarray, decimals: int) -> list[float]:
    return [float(v) for v in np.round(values, decimals).astype(np.float32)]


def to_row(keys: dict[str, Any], trace: LapTrace) -> dict[str, Any]:
    """A ``RESAMPLED`` row (float32 arrays rounded: metres and km/h to 0.1, time to 1 ms)."""
    corner = trace.min_corner
    row: dict[str, Any] = {
        **{k: keys[k] for k in _KEYS},
        "n_samples": trace.n_samples,
        "n_corrected": trace.n_corrected,
        "lap_length_m": round(trace.lap_length_m, 3),
        "trace_time_s": round(trace.trace_time_s, 3),
        "max_gap_s": round(trace.max_gap_s, 3),
        "distance_m": _f32(trace.distance_m, 1),
        "elapsed_s": _f32(trace.elapsed_s, 3),
        "speed_kph": _f32(trace.speed_kph, 1),
        "throttle_pct": _f32(trace.throttle_pct, 1),
        "rpm": _f32(trace.rpm, 0),
        "brake": [int(v) for v in trace.brake],
        "n_gear": [int(v) for v in trace.n_gear],
        "drs": [int(v) for v in trace.drs],
        "top_speed_kph": trace.top_speed_kph,
        "top_speed_at_m": None if trace.top_speed_at_m is None else round(trace.top_speed_at_m, 1),
        "min_corner_speed_kph": None if corner is None else round(corner.apex_kph, 1),
        "min_corner_at_m": None if corner is None else round(corner.apex_at_m, 1),
        "full_throttle_share": None
        if trace.full_throttle_share is None
        else round(trace.full_throttle_share, 4),
        "brake_share": round(trace.brake_share, 4),
        "drs_share": round(trace.drs_share, 4),
        "n_braking_zones": len(trace.zones),
        "braking_start_m": [float(np.float32(round(z.start_m, 1))) for z in trace.zones],
        "braking_end_m": [float(np.float32(round(z.end_m, 1))) for z in trace.zones],
        "braking_apex_kph": [float(np.float32(round(z.apex_kph, 1))) for z in trace.zones],
    }
    return row


def resample_group(pdf: pd.DataFrame) -> pd.DataFrame:
    """``applyInPandas`` body: one (season, round, driver_code, lap) group -> 0 or 1 rows."""
    if pdf.empty:
        return pd.DataFrame(columns=list(RESAMPLED_COLUMNS))
    first = pdf.iloc[0]
    keys = {
        "season": int(first["season"]),
        "round": int(first["round"]),
        "driver_code": str(first["driver_code"]),
        "lap": int(first["lap"]),
    }
    trace = resample_lap(pdf)
    if trace is None:
        return pd.DataFrame(columns=list(RESAMPLED_COLUMNS))
    return pd.DataFrame([to_row(keys, trace)], columns=list(RESAMPLED_COLUMNS))
