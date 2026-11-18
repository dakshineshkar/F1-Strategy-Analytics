"""SYNTHETIC raw telemetry samples for the sample race 2024 R5 (Feature 6 fixture; tests only).

    python -m f1sa.ingest.synthetic_telemetry          (make telemetry-trace-sample runs it first)

**This is NOT real telemetry.** The sample bundle has no TracingInsights data, so this writes
samples in the layout of the kept raw telemetry
(``{lake}/fixtures/telemetry_raw/tracinginsights/telemetry/season=2024/round=5/driver=CODE/
telemetry.parquet``) for the telemetry-trace job's ``--source sample``. Its rows are marked
``is_synthetic = true`` and ``source = synthetic`` there, and the dashboard labels them SYNTHETIC.
It never writes outside ``./data/lake`` and never touches the sample bundle (``data/sample``) or the
raw zone. ``make demo`` does not run it.

Generator ``synthetic-telemetry-v1``, deterministic per (seed, driver code, lap):

* a fixed synthetic circuit of ``TRACK_LENGTH_M`` with ``CORNERS`` (position, apex speed); the speed
  profile is the minimum of the top speed and each corner's braking / acceleration envelope
  (constant ``BRAKE_MS2`` / ``ACCEL_MS2``; lap 1 adds a standing start), with small seeded
  per-lap variations of the apex and top speeds;
* the profile is scaled so the lap takes exactly the sample's real (Jolpica) lap time;
* samples every 0.06-0.20 s (seeded), the first at 0 s / 0 m and the last at the lap time and
  the lap length; throttle 100 when accelerating or at top speed, 0 with the brake on when
  slowing, 40 around an apex; gears from speed bands; RPM within the gear band; DRS open in
  ``DRS_ZONES`` on a seeded share of laps from lap 3.
"""

from __future__ import annotations

import argparse
import io
import sys
import zlib
from collections.abc import Iterable, Mapping
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from f1sa.config import get_settings
from f1sa.lake.paths import is_within, local_path

GENERATOR = "synthetic-telemetry-v1"
SEED = 20240421
SEASON, ROUND = 2024, 5
TRACK_LENGTH_M = 5451.0
TOP_KPH = 322.0
BRAKE_MS2 = 38.0
ACCEL_MS2 = 9.0
CORNERS: tuple[tuple[float, float], ...] = (
    (330.0, 115.0),
    (520.0, 75.0),
    (1350.0, 165.0),
    (1700.0, 95.0),
    (2300.0, 235.0),
    (2650.0, 125.0),
    (3150.0, 205.0),
    (4720.0, 70.0),
    (5150.0, 140.0),
)
DRS_ZONES: tuple[tuple[float, float], ...] = ((3650.0, 4600.0), (5250.0, 5451.0))
GEAR_BANDS_KPH: tuple[float, ...] = (0.0, 95.0, 125.0, 155.0, 190.0, 225.0, 260.0, 292.0)
COLUMNS: tuple[str, ...] = (
    "driver_code",
    "lap",
    "time_in_lap_s",
    "speed_kph",
    "rpm",
    "n_gear",
    "throttle_pct",
    "brake",
    "drs",
    "distance_m",
    "rel_distance",
)
FIXTURE_DIR = "fixtures/telemetry_raw"


def _rng(seed: int, code: str, lap: int) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([seed, zlib.crc32(code.encode()), lap]))


def speed_profile(
    apex_scale: float, top_kph: float, *, standing_start: bool, step_m: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """(distance m, speed m/s) on a ``step_m`` grid over the synthetic lap (before scaling)."""
    d = np.arange(0.0, TRACK_LENGTH_M + step_m / 2, step_m)
    d[-1] = TRACK_LENGTH_M
    v = np.full_like(d, top_kph / 3.6)
    for pos, apex in CORNERS:
        va = apex * apex_scale / 3.6
        for c in (pos - TRACK_LENGTH_M, pos, pos + TRACK_LENGTH_M):
            before = np.sqrt(va**2 + 2 * BRAKE_MS2 * np.clip(c - d, 0, None))
            after = np.sqrt(va**2 + 2 * ACCEL_MS2 * np.clip(d - c, 0, None))
            v = np.minimum(v, np.where(d <= c, before, after))
    if standing_start:
        v = np.minimum(v, np.sqrt(2 * ACCEL_MS2 * d) + 0.5)
    return d, v


def lap_samples(code: str, lap: int, lap_time_s: float, seed: int = SEED) -> pd.DataFrame:
    """One synthetic lap of samples that takes exactly ``lap_time_s``."""
    if not (np.isfinite(lap_time_s) and lap_time_s > 0):
        raise ValueError(f"{code} lap {lap}: lap time must be positive, got {lap_time_s!r}")
    rng = _rng(seed, code, lap)
    apex_scale = float(rng.normal(1.0, 0.012))
    top = TOP_KPH * float(rng.normal(1.0, 0.006))
    drs_lap = lap >= 3 and bool(rng.random() < 0.45)
    d, v = speed_profile(apex_scale, top, standing_start=lap == 1)
    mid = (v[1:] + v[:-1]) / 2
    t = np.r_[0.0, np.cumsum(np.diff(d) / mid)]
    scale = t[-1] / lap_time_s
    v, t = v * scale, t / scale
    times = [0.0]
    while times[-1] < lap_time_s:
        times.append(times[-1] + float(rng.uniform(0.06, 0.20)))
    times[-1] = lap_time_s
    ts = np.round(np.asarray(times), 3)
    ds = np.interp(ts, t, d)
    vs = np.interp(ds, d, v) * 3.6
    slope = np.gradient(v, d)
    dv = np.interp(ds, d, slope)
    at_top = vs >= top * scale * 0.995
    braking = dv < -0.02
    throttle = np.where(braking, 0.0, np.where((dv > 0.005) | at_top, 100.0, 40.0))
    gear = np.searchsorted(np.asarray(GEAR_BANDS_KPH), vs, side="right")
    gear = np.clip(gear, 1, 8)
    bands = np.asarray((*GEAR_BANDS_KPH, 345.0))
    lo, hi = bands[gear - 1], bands[gear]
    rpm = 7000.0 + 4800.0 * np.clip((vs - lo) / np.maximum(hi - lo, 1.0), 0, 1)
    drs = np.zeros(len(ds), dtype=np.int64)
    if drs_lap:
        for a, b in DRS_ZONES:
            drs[(ds >= a) & (ds <= b)] = 1
    return pd.DataFrame(
        {
            "driver_code": pd.array([code] * len(ts), dtype="string"),
            "lap": np.full(len(ts), lap, dtype=np.int64),
            "time_in_lap_s": ts,
            "speed_kph": np.round(vs, 3),
            "rpm": np.round(rpm, 1),
            "n_gear": gear.astype(np.int64),
            "throttle_pct": throttle,
            "brake": braking,
            "drs": drs,
            "distance_m": np.round(ds, 3),
            "rel_distance": np.round(ds / TRACK_LENGTH_M, 6),
        },
        columns=list(COLUMNS),
    )


def build_fixture(laps: pd.DataFrame, seed: int = SEED) -> dict[str, pd.DataFrame]:
    """``driver_code, lap, lap_time_s`` rows -> one samples frame per driver code (sorted). Laps
    without a positive lap time are skipped."""
    need = {"driver_code", "lap", "lap_time_s"}
    if not need <= set(laps.columns):
        raise ValueError(f"laps need the columns {sorted(need)}")
    usable = laps.dropna(subset=["driver_code", "lap", "lap_time_s"])
    usable = usable[usable["lap_time_s"] > 0].sort_values(["driver_code", "lap"])
    out: dict[str, pd.DataFrame] = {}
    for code, rows in usable.groupby("driver_code", sort=True):
        frames = [
            lap_samples(str(code), int(r.lap), float(r.lap_time_s), seed)
            for r in rows.itertuples(index=False)
        ]
        out[str(code)] = pd.concat(frames, ignore_index=True)
    if not out:
        raise ValueError("no laps with a lap time: nothing to generate")
    return out


def parquet_bytes(frame: pd.DataFrame) -> bytes:
    """Deterministic Parquet bytes (no pandas index, fixed writer options)."""
    table = pa.Table.from_pandas(frame, preserve_index=False).replace_schema_metadata(
        {"generator": GENERATOR, "is_synthetic": "true"}
    )
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


def write_fixture(
    lake_root: Path,
    frames: Mapping[str, pd.DataFrame],
    season: int = SEASON,
    round_: int = ROUND,
    *,
    allowed_root: Path = Path("data/lake"),
) -> list[Path]:
    """Write the frames under ``{lake_root}/fixtures/telemetry_raw/...``; refuses outside
    ``allowed_root`` (``./data/lake``)."""
    base = lake_root / FIXTURE_DIR / "tracinginsights" / "telemetry"
    if not is_within(base, allowed_root):
        raise ValueError(f"refusing to write the fixture outside {allowed_root}: {base}")
    written: list[Path] = []
    for code, frame in sorted(frames.items()):
        part = base / f"season={season}" / f"round={round_}" / f"driver={code}"
        part.mkdir(parents=True, exist_ok=True)
        path = part / "telemetry.parquet"
        path.write_bytes(parquet_bytes(frame))
        written.append(path)
    return written


def read_sample_laps(lake_root: Path, season: int = SEASON, round_: int = ROUND) -> pd.DataFrame:
    """The sample race's ``driver_code, lap, lap_time_s`` from ``clean/analysis_laps``."""
    part = lake_root / "clean" / "analysis_laps" / f"season={season}" / f"round={round_}"
    files = sorted(p for p in part.glob("*.parquet") if not p.name.startswith(("_", ".")))
    if not files:
        raise FileNotFoundError(
            f"no clean/analysis_laps for {season} R{round_} under {lake_root}: "
            "run make etl-sample analysis-sample first"
        )
    tables = [pq.read_table(f, columns=["driver_code", "lap", "lap_time_s"]) for f in files]
    return pa.concat_tables(tables).to_pandas()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m f1sa.ingest.synthetic_telemetry")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args(list(argv) if argv is not None else None)
    uri = get_settings().data_lake_uri
    if not uri.startswith("file://"):
        print("error: the synthetic telemetry fixture needs a file:// lake", file=sys.stderr)
        return 2
    lake = local_path(uri)
    try:
        frames = build_fixture(read_sample_laps(lake), args.seed)
        paths = write_fixture(lake, frames)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    n = sum(len(f) for f in frames.values())
    print(
        f"SYNTHETIC telemetry fixture ({GENERATOR}): {len(paths)} drivers, {n} samples, "
        f"{SEASON} R{ROUND} under {lake / FIXTURE_DIR}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
