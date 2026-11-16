"""The engineer view (Feature 3, display only): one focus car against the car directly ahead and
the car directly behind at lap N, from information up to lap N only.

``GET /api/races/{s}/{r}/engineer/{driverId}?lap=N`` (``routes/engineer.py``). Inputs, all read
only:

* the API's lap log (``api/lap_log.py``): per lap race time, lap time, position, compound, tyre
  age, real tyre life and pit flags, and the stream's published undercut probabilities per leader
  lap. **Every value uses log rows with ``lap <= N``.**
* the Redis driver hashes, for the probabilities at the current lap (never written);
* ``features/pit_loss`` of this race (``pit_loss_prior_s``: earlier races only);
* ``clean/races`` and ``clean/analysis_stints`` of **strictly earlier** races (typical stint);
* ``clean/analysis_laps`` / ``clean/analysis_race_control`` of this race, **lap N / lap <= N only**,
  through the cached ``AnalysisService`` (track status where the lake has race control).

The values (the pure functions below; thresholds are module constants):

* **Order at lap N**: running cars sorted by their race time at lap N. A car that has not
  completed lap N is projected from its latest lap (N - 1) and last lap time (``projected``); a car
  further back (lapped by more than a lap at that moment, or retired) is left out and counted.
* **Gap**: race-time difference at lap N. **Gap trend**: least-squares slope of the pair's gap over
  laps N-4..N where both have the lap, after the latest pit lap of either car (s/lap; negative = the
  rear car is closing), at least 3 laps.
* **Pace**: the mean of the last 3 laps <= N, without lap 1, pit-in/out and neutralised laps.
* **Tyre life**: the real TracingInsights life, else the inferred age (``estimated``).
  **Stint**: laps since the latest pit out (lap 1 when none).
* **Typical stint**: the median ``laps`` of completed stints (ending in a stop) on that compound
  in strictly earlier races at this circuit, else at every earlier circuit (labelled), else none.
* **Neutralised at lap N**: with race control in the lake, the leader's lap-N track-status codes
  (SC / VSC / red) and the latest key race-control message with lap <= N. Without (the sample):
  the v1 lap-time rule made causal, with the baseline taken from earlier green laps only.
* **Undercut probability**: the stream's own value of the rear car of each pair (focus on the car
  ahead; the car behind on the focus = the threat). It refers to the car directly ahead at the
  stream's latest decision lap, so ``pair_matches`` says whether that was the displayed car.
* **Pit-rejoin estimate** ("if the focus pits now"): the focus's time at lap N plus the race's
  pit-loss prior, placed among the other cars' times at lap N. Unreliable under SC/VSC/red flag,
  without a prior, or when a car near the rejoin point is projected.
* **Strategy calls** (``strategy_calls``): short display rules built only from those values; not
  model output.

The what-if panel's pit loss additionally adjusts for the driver's expected stop and out-lap, so the
two estimates can differ slightly.
"""

from __future__ import annotations

import logging
import statistics
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from f1sa.api.catalog import LakeReader
from f1sa.api.lap_log import LapRow, Probs
from f1sa.api.models import (
    AnalysisLapsOut,
    AnalysisRaceControlsOut,
    EngineerCallOut,
    EngineerCarOut,
    EngineerNeutralOut,
    EngineerOut,
    EngineerPairOut,
    EngineerRejoinOut,
    GapPointOut,
    RejoinCarOut,
    TypicalStintOut,
)

log = logging.getLogger(__name__)

TABLES: tuple[str, ...] = ("races", "analysis_stints")
"""The clean tables the typical-stint reader may open (never raw)."""

TREND_LAPS = 5
MIN_TREND_LAPS = 3
PACE_LAPS = 3
TRAFFIC_GAP_S = 2.0
PROJECTED_WINDOW_S = 5.0
PROB_THRESHOLD = 0.5
CLOSING_RATE_S = -0.2
CLOSING_GAP_S = 3.0
TYRE_OFFSET_LAPS = 8
NEUTRAL_RATIO = 1.10
NEUTRAL_SLOW_SHARE = 0.5
SLOW_FACTOR = 1.07
RED_FLAG_RATIO = 3.0
KNOWN_COMPOUNDS = ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET")
DISCLAIMER = "Strategy calls are display rules built from these values, not model output."
PIT_LOSS_TEXT = {
    "circuit_prior": "circuit prior from earlier races",
    "global_prior": "all-circuit prior from earlier races (no earlier race here)",
    "none": "no pit-loss prior",
}


class EngineerError(LookupError):
    """The request cannot be answered (``status``: 404 unknown driver, 409 lap out of range)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ============================================================================== lap data
Laps = dict[str, dict[int, LapRow]]


def by_driver(rows: Iterable[LapRow], upto: int) -> Laps:
    """driver -> lap -> row, keeping only laps <= ``upto`` (the no-hindsight cut)."""
    out: Laps = {}
    for r in rows:
        if r.lap <= upto:
            out.setdefault(r.driver_id, {})[r.lap] = r
    return out


@dataclass(frozen=True)
class Crossing:
    driver_id: str
    time_s: float
    projected: bool


def time_at(laps: Mapping[int, LapRow], lap: int) -> Crossing | None:
    """The car's race time at the end of ``lap``: recorded, or projected from lap - 1 with its last
    lap time; None when it is further back (or has no usable time)."""
    row = laps.get(lap)
    if row is not None:
        return Crossing(row.driver_id, row.race_time_s, False)
    prev = laps.get(lap - 1)
    if prev is None or prev.lap_time_s is None:
        return None
    return Crossing(prev.driver_id, prev.race_time_s + prev.lap_time_s, True)


def order_at(laps: Laps, lap: int) -> tuple[list[Crossing], list[str]]:
    """Running cars at ``lap`` by race time, and the ids left out (further back or retired)."""
    crossings, left_out = [], []
    for d in sorted(laps):
        c = time_at(laps[d], lap)
        if c is None:
            left_out.append(d)
        else:
            crossings.append(c)
    crossings.sort(key=lambda c: (c.time_s, c.driver_id))
    return crossings, left_out


def slope(points: Sequence[tuple[int, float]]) -> float | None:
    """Least-squares slope of (lap, value); None for fewer than ``MIN_TREND_LAPS`` points."""
    if len(points) < MIN_TREND_LAPS:
        return None
    xs = [float(x) for x, _ in points]
    ys = [y for _, y in points]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / den, 4)


def gap_series(laps: Laps, front: str, rear: str, lap: int) -> list[tuple[int, float]]:
    """(lap, rear - front race time) over laps lap-4..lap where both cars recorded the lap.

    A pit stop shifts the gap by the stop time, so the series starts after the latest pit-in or
    pit-out lap of either car in the window (the trend then covers clean laps only)."""
    a, b = laps.get(front, {}), laps.get(rear, {})
    window = range(max(1, lap - TREND_LAPS + 1), lap + 1)
    pits = [
        n for n in window for x in (a.get(n), b.get(n)) if x is not None and (x.pit_in or x.pit_out)
    ]
    start = max(pits) + 1 if pits else window.start
    return [
        (n, round(b[n].race_time_s - a[n].race_time_s, 3))
        for n in range(start, lap + 1)
        if n in a and n in b
    ]


def pace(laps: Mapping[int, LapRow], lap: int, neutral: set[int]) -> float | None:
    """Mean of the last ``PACE_LAPS`` laps <= ``lap``, without lap 1, pit and neutralised laps."""
    times = [
        r.lap_time_s
        for n, r in sorted(laps.items(), reverse=True)
        if n <= lap
        and n > 1
        and not r.pit_in
        and not r.pit_out
        and n not in neutral
        and r.lap_time_s is not None
    ][:PACE_LAPS]
    return round(sum(times) / len(times), 3) if len(times) == PACE_LAPS else None


def stint_laps(laps: Mapping[int, LapRow], lap: int) -> int:
    """Laps on the current set at ``lap``: since the latest pit-out lap (from lap 1 when none)."""
    outs = [n for n, r in laps.items() if r.pit_out and n <= lap]
    return lap - (max(outs) if outs else 1) + 1


def known_compound(c: str | None) -> str | None:
    text = c.strip().upper() if isinstance(c, str) else None
    return text if text in KNOWN_COMPOUNDS else None


def tyre_life(row: LapRow) -> tuple[int | None, str]:
    """The real tyre life, else the inferred tyre age (``estimated``), else none."""
    if row.tyre_life_laps is not None:
        return row.tyre_life_laps, "real"
    if row.tyre_age is not None:
        return row.tyre_age, "estimated"
    return None, "none"


# ============================================================================== neutralisation
def _median(values: Sequence[float]) -> float | None:
    return statistics.median(values) if values else None


def estimated_neutral(laps: Laps, lap: int) -> tuple[str, set[int]]:
    """The v1 lap-time rule made causal: lap n is neutralised when the field's median lap time is
    more than 1.10 x the median of the earlier green laps (2..n-1), or when at least half the field
    is slower than 1.07 x that median; a red flag above 3.0 x. Lap 1 and pit laps are left out.
    Returns the status of ``lap`` and every neutralised lap <= ``lap``."""
    per_lap: dict[int, list[float]] = {}
    for d in laps.values():
        for n, r in d.items():
            if n > 1 and n <= lap and not r.pit_in and not r.pit_out and r.lap_time_s is not None:
                per_lap.setdefault(n, []).append(r.lap_time_s)
    green: list[float] = []
    neutral: set[int] = set()
    status = "unknown"
    for n in sorted(per_lap):
        times = per_lap[n]
        base = _median(green)
        if base is None or base <= 0:
            green.extend(times)
            status = "unknown" if n == lap else status
            continue
        ratio = (_median(times) or 0.0) / base
        slow = sum(t > SLOW_FACTOR * base for t in times) / len(times)
        if ratio > RED_FLAG_RATIO:
            neutral.add(n)
            s = "red"
        elif ratio > NEUTRAL_RATIO or slow >= NEUTRAL_SLOW_SHARE:
            neutral.add(n)
            s = "neutralised"
        else:
            green.extend(times)
            s = "green"
        if n == lap:
            status = s
    return status, neutral


def lake_neutral(
    laps_doc: AnalysisLapsOut | None, rc_doc: AnalysisRaceControlsOut | None, lap: int
) -> tuple[EngineerNeutralOut, set[int]] | None:
    """Track status from the lake (only when it has race control): the leader's lap-N codes and the
    latest key race-control message with lap <= N; None to fall back to the estimate."""
    if laps_doc is None or laps_doc.coverage.n_race_control == 0:
        return None
    neutral: set[int] = set()
    leader = None
    for r in laps_doc.rows:
        if r.lap > lap or r.neutralised_source != "track_status":
            continue
        if r.position == 1:
            if r.is_neutralised_lap or r.is_red_flag_lap:
                neutral.add(r.lap)
            if r.lap == lap:
                leader = r
    if leader is None:
        return None
    if leader.is_red_flag_lap:
        status = "red"
    elif leader.is_sc_lap:
        status = "sc"
    elif leader.is_vsc_lap:
        status = "vsc"
    else:
        status = "green"
    msgs = [
        m
        for m in (rc_doc.rows if rc_doc else [])
        if m.is_key and m.lap is not None and m.lap <= lap
    ]
    last = max(msgs, key=lambda m: (m.lap or 0, m.seq)) if msgs else None
    return (
        EngineerNeutralOut(
            status=status,  # type: ignore[arg-type]
            source="track_status",
            message=last.message if last else None,
            message_lap=last.lap if last else None,
        ),
        neutral,
    )


# ============================================================================== typical stint
@dataclass(frozen=True)
class StintSample:
    season: int
    round: int
    compound: str
    laps: int
    is_synthetic: bool


def typical_stint(
    compound: str | None,
    target: tuple[int, int],
    circuit_of: Mapping[tuple[int, int], str | None],
    stints: Iterable[StintSample],
) -> TypicalStintOut:
    """Median completed-stint length for ``compound`` in races strictly before ``target``: at the
    target's circuit, else at every circuit (``all_circuits``), else ``none``."""
    seq = target[0] * 100 + target[1]
    here = circuit_of.get(target)
    earlier = [s for s in stints if s.season * 100 + s.round < seq and s.compound == compound]
    pools = (
        (
            "circuit",
            [
                s
                for s in earlier
                if here is not None and circuit_of.get((s.season, s.round)) == here
            ],
        ),
        ("all_circuits", earlier),
    )
    for source, pool in pools:
        if compound is not None and pool:
            return TypicalStintOut(
                compound=compound,  # type: ignore[arg-type]
                median_laps=float(statistics.median(s.laps for s in pool)),
                n_stints=len(pool),
                n_races=len({(s.season, s.round) for s in pool}),
                source=source,  # type: ignore[arg-type]
                is_synthetic=any(s.is_synthetic for s in pool),
            )
    return TypicalStintOut(
        compound=compound,  # type: ignore[arg-type]
        median_laps=None,
        n_stints=0,
        n_races=0,
        source="none",
        is_synthetic=False,
    )


# ============================================================================== rejoin
def rejoin(
    focus: Crossing,
    others: Sequence[Crossing],
    loss_s: float | None,
    loss_source: str,
    neutral_status: str,
    left_out: int,
) -> EngineerRejoinOut:
    """Where the focus would rejoin if it pitted now: its lap-N time plus ``loss_s`` among the other
    cars' lap-N times (see the module docstring)."""
    field_ = [
        RejoinCarOut(
            driver_id=c.driver_id, gap_s=round(c.time_s - focus.time_s, 3), projected=c.projected
        )
        for c in sorted(others, key=lambda c: c.time_s)
    ]
    reasons: list[str] = []
    if neutral_status in ("sc", "vsc", "red", "neutralised"):
        reasons.append(
            {"sc": "SC", "vsc": "VSC", "red": "red flag"}.get(neutral_status, "neutralised")
        )
    if loss_s is None:
        reasons.append("no pit-loss prior")
        return EngineerRejoinOut(
            pit_loss_s=None,
            pit_loss_source=loss_source,  # type: ignore[arg-type]
            pit_loss_text=PIT_LOSS_TEXT.get(loss_source, PIT_LOSS_TEXT["none"]),
            position=None,
            ahead_id=None,
            behind_id=None,
            gap_ahead_s=None,
            gap_behind_s=None,
            in_traffic=None,
            reliable=False,
            reasons=reasons,
            field=field_,
            left_out=left_out,
        )
    t = focus.time_s + loss_s
    ahead = [c for c in others if c.time_s < t]
    behind = [c for c in others if c.time_s >= t]
    a = max(ahead, key=lambda c: c.time_s) if ahead else None
    b = min(behind, key=lambda c: c.time_s) if behind else None
    near = [c for c in others if abs(c.time_s - t) <= PROJECTED_WINDOW_S and c.projected]
    if near:
        reasons.append("projected cars near the rejoin point")
    gap_a = round(t - a.time_s, 3) if a else None
    return EngineerRejoinOut(
        pit_loss_s=round(loss_s, 3),
        pit_loss_source=loss_source,  # type: ignore[arg-type]
        pit_loss_text=PIT_LOSS_TEXT.get(loss_source, PIT_LOSS_TEXT["none"]),
        position=len(ahead) + 1,
        ahead_id=a.driver_id if a else None,
        behind_id=b.driver_id if b else None,
        gap_ahead_s=gap_a,
        gap_behind_s=round(b.time_s - t, 3) if b else None,
        in_traffic=gap_a is not None and gap_a < TRAFFIC_GAP_S,
        reliable=not reasons,
        reasons=reasons,
        field=field_,
        left_out=left_out,
    )


# ============================================================================== calls
def _pct(p: float) -> str:
    return f"{round(p * 100)}%"


def strategy_calls(
    code: Callable[[str], str],
    focus: EngineerCarOut,
    ahead: EngineerCarOut | None,
    behind: EngineerCarOut | None,
    pair_ahead: EngineerPairOut | None,
    pair_behind: EngineerPairOut | None,
    rejoin_: EngineerRejoinOut,
) -> list[EngineerCallOut]:
    """The display rules (fixed order, stable ids; ``docs/architecture.md`` lists them)."""
    calls: list[EngineerCallOut] = []
    if (
        pair_ahead
        and ahead
        and pair_ahead.prob is not None
        and pair_ahead.prob >= PROB_THRESHOLD
        and pair_ahead.pair_matches is not False
    ):
        prob = _pct(pair_ahead.prob)
        calls.append(
            EngineerCallOut(
                id="undercut_window",
                severity="info",
                text=f"Undercut window open on {code(ahead.driver_id)}: {prob}",
            )
        )
    if (
        pair_behind
        and behind
        and pair_behind.prob is not None
        and pair_behind.prob >= PROB_THRESHOLD
        and pair_behind.pair_matches is not False
    ):
        calls.append(
            EngineerCallOut(
                id="threat",
                severity="warn",
                text=f"Under threat from behind: {code(behind.driver_id)} {_pct(pair_behind.prob)}",
            )
        )
    if (
        pair_ahead
        and ahead
        and pair_ahead.trend_s_per_lap is not None
        and pair_ahead.trend_s_per_lap <= CLOSING_RATE_S
        and pair_ahead.gap_s is not None
        and pair_ahead.gap_s <= CLOSING_GAP_S
    ):
        calls.append(
            EngineerCallOut(
                id="closing",
                severity="info",
                text=f"Closing on {code(ahead.driver_id)}: "
                f"{abs(pair_ahead.trend_s_per_lap):.2f} s/lap, gap {pair_ahead.gap_s:.1f} s",
            )
        )
    if (
        pair_behind
        and behind
        and pair_behind.trend_s_per_lap is not None
        and pair_behind.trend_s_per_lap <= CLOSING_RATE_S
        and pair_behind.gap_s is not None
    ):
        calls.append(
            EngineerCallOut(
                id="being_caught",
                severity="warn",
                text=f"{code(behind.driver_id)} closing: "
                f"{abs(pair_behind.trend_s_per_lap):.2f} s/lap, gap {pair_behind.gap_s:.1f} s",
            )
        )
    if rejoin_.position is not None:
        if rejoin_.ahead_id is None:
            where = f"Pit now rejoins P{rejoin_.position}, in the lead"
        elif rejoin_.in_traffic:
            where = (
                f"Pit now rejoins P{rejoin_.position} behind {code(rejoin_.ahead_id)}, "
                f"in traffic ({rejoin_.gap_ahead_s:.1f} s)"
            )
        else:
            where = (
                f"Pit now rejoins P{rejoin_.position} behind {code(rejoin_.ahead_id)}, "
                f"clear ({rejoin_.gap_ahead_s:.1f} s)"
            )
        if not rejoin_.reliable:
            where += f" — estimate unreliable: {', '.join(rejoin_.reasons)}"
        calls.append(
            EngineerCallOut(
                id="rejoin", severity="warn" if rejoin_.in_traffic else "info", text=where
            )
        )
    if (
        ahead
        and ahead.tyre_life_delta_laps is not None
        and abs(ahead.tyre_life_delta_laps) >= TYRE_OFFSET_LAPS
    ):
        d = ahead.tyre_life_delta_laps
        calls.append(
            EngineerCallOut(
                id="tyre_offset",
                severity="info",
                text=f"{code(ahead.driver_id)}'s tyres are {abs(d)} laps "
                f"{'older' if d > 0 else 'newer'}",
            )
        )
    typ = focus.typical_stint
    if (
        focus.stint_laps is not None
        and typ.median_laps is not None
        and focus.stint_laps >= typ.median_laps
    ):
        where_ = "here" if typ.source == "circuit" else "at earlier circuits"
        calls.append(
            EngineerCallOut(
                id="long_stint",
                severity="info",
                text=f"Stint {focus.stint_laps} laps, past the typical {typ.median_laps:g} "
                f"for {(typ.compound or '').title()} {where_}",
            )
        )
    return calls


# ============================================================================== assembly
@dataclass
class EngineerInputs:
    """Everything ``build`` needs, already gathered (so it is pure and testable)."""

    season: int
    round: int
    focus_id: str
    lap: int | None
    rows: Sequence[LapRow]
    current_probs: Probs | None
    recorded_probs: Mapping[int, Probs]
    pit_loss_s: float | None
    pit_loss_source: str
    circuit_of: Mapping[tuple[int, int], str | None]
    stints: Sequence[StintSample]
    laps_doc: AnalysisLapsOut | None = None
    rc_doc: AnalysisRaceControlsOut | None = None
    codes: Mapping[str, str] = field(default_factory=dict)


def _pair_matches(laps: Laps, rear: str, front: str, lap: int) -> bool | None:
    """Was ``front`` the car directly ahead of ``rear`` (by recorded position) at lap - 1, the
    stream's usual decision lap? None when it cannot be told."""
    n = lap - 1
    rr = laps.get(rear, {}).get(n)
    if rr is None or rr.position is None:
        return None
    for d, by_lap in laps.items():
        r = by_lap.get(n)
        if r is not None and r.position == rr.position - 1:
            return d == front
    return None


def build(inp: EngineerInputs) -> EngineerOut:
    """The engineer view for ``inp.focus_id`` at lap ``inp.lap`` (default: its latest lap).

    Raises ``EngineerError`` (404 unknown driver, 409 lap outside the recorded history)."""
    all_rows = [r for r in inp.rows]
    mine = sorted(r.lap for r in all_rows if r.driver_id == inp.focus_id)
    if not mine:
        raise EngineerError(404, f"no recorded laps for {inp.focus_id}")
    current = mine[-1]
    lap = current if inp.lap is None else inp.lap
    if lap > current or lap < mine[0]:
        raise EngineerError(
            409, f"lap {lap} is not recorded for {inp.focus_id} (laps {mine[0]}-{current})"
        )
    laps = by_driver(all_rows, lap)

    neutral_lake = lake_neutral(inp.laps_doc, inp.rc_doc, lap)
    if neutral_lake is not None:
        neutral_out, neutral_laps = neutral_lake
    else:
        status, neutral_laps = estimated_neutral(laps, lap)
        neutral_out = EngineerNeutralOut(
            status=status,  # type: ignore[arg-type]
            source="estimated" if status != "unknown" else "none",
            message=None,
            message_lap=None,
        )

    order, left_out = order_at(laps, lap)
    ids = [c.driver_id for c in order]
    i = ids.index(inp.focus_id)
    ahead_id = ids[i - 1] if i > 0 else None
    behind_id = ids[i + 1] if i + 1 < len(ids) else None
    focus_cross = order[i]

    probs = (
        inp.current_probs
        if lap == current and inp.current_probs is not None
        else inp.recorded_probs.get(lap)
    )
    probs_recorded = probs is not None

    def stint_of(d: str) -> TypicalStintOut:
        row = laps[d].get(lap) or laps[d][max(laps[d])]
        return typical_stint(
            known_compound(row.compound), (inp.season, inp.round), inp.circuit_of, inp.stints
        )

    focus_row = laps[inp.focus_id][lap]
    focus_life, _ = tyre_life(focus_row)
    focus_pace = pace(laps[inp.focus_id], lap, neutral_laps)

    def card(d: str, pos: int, cross: Crossing) -> EngineerCarOut:
        mine_ = laps[d]
        latest = max(mine_)
        row = mine_.get(lap) or mine_[latest]
        life, life_source = tyre_life(row)
        p = pace(mine_, lap, neutral_laps)
        flag, prob = (probs or {}).get(d, (None, None))
        return EngineerCarOut(
            driver_id=d,
            driver_code=inp.codes.get(d),
            position=pos,
            lap=latest,
            projected=cross.projected,
            compound=known_compound(row.compound),  # type: ignore[arg-type]
            tyre_life_laps=life,
            tyre_life_source=life_source,  # type: ignore[arg-type]
            tyre_life_delta_laps=(life - focus_life)
            if life is not None and focus_life is not None and d != inp.focus_id
            else None,
            stint_laps=stint_laps(mine_, latest),
            typical_stint=stint_of(d),
            pace_last3_s=p,
            pace_delta_s=round(p - focus_pace, 3)
            if p is not None and focus_pace is not None and d != inp.focus_id
            else None,
            last_lap_time_s=row.lap_time_s,
            in_pit=bool(row.pit_in and row.lap == lap),
            undercut_flag=flag,
            undercut_prob=prob,
            prob_recorded=probs_recorded,
        )

    focus_card = card(inp.focus_id, i + 1, focus_cross)
    ahead_card = card(ahead_id, i, order[i - 1]) if ahead_id else None
    behind_card = card(behind_id, i + 2, order[i + 1]) if behind_id else None

    def pair(
        front: str, rear: str, front_cross: Crossing, rear_cross: Crossing, role: str
    ) -> EngineerPairOut:
        series = gap_series(laps, front, rear, lap)
        _flag, prob = (probs or {}).get(rear, (None, None))
        return EngineerPairOut(
            front_id=front,
            rear_id=rear,
            gap_s=round(rear_cross.time_s - front_cross.time_s, 3),
            projected=front_cross.projected or rear_cross.projected,
            trend_s_per_lap=slope(series),
            trend_laps=len(series),
            gaps=[GapPointOut(lap=n, gap_s=g) for n, g in series],
            prob=prob,
            prob_role=role,  # type: ignore[arg-type]
            prob_recorded=probs_recorded,
            pair_matches=_pair_matches(laps, rear, front, lap),
        )

    pair_ahead = (
        pair(ahead_id, inp.focus_id, order[i - 1], focus_cross, "focus_on_ahead")
        if ahead_id
        else None
    )
    pair_behind = (
        pair(inp.focus_id, behind_id, focus_cross, order[i + 1], "threat") if behind_id else None
    )
    rejoin_out = rejoin(
        focus_cross,
        [c for c in order if c.driver_id != inp.focus_id],
        inp.pit_loss_s,
        inp.pit_loss_source,
        neutral_out.status,
        len(left_out),
    )

    def code(d: str) -> str:
        return inp.codes.get(d) or d[:3].upper()

    calls = strategy_calls(
        code, focus_card, ahead_card, behind_card, pair_ahead, pair_behind, rejoin_out
    )
    return EngineerOut(
        season=inp.season,
        round=inp.round,
        lap=lap,
        current_lap=current,
        history_from_lap=mine[0],
        focus_id=inp.focus_id,
        neutralised=neutral_out,
        ahead=ahead_card,
        focus=focus_card,
        behind=behind_card,
        pair_ahead=pair_ahead,
        pair_behind=pair_behind,
        rejoin=rejoin_out,
        calls=calls,
        disclaimer=DISCLAIMER,
    )


# ============================================================================== service (I/O)
@dataclass
class StintHistory:
    """Circuit ids and completed stints of every race, read once per process (they never change
    during a replay). ``reader_factory`` opens only ``TABLES`` of the clean zone."""

    reader_factory: Callable[[], LakeReader]
    _circuits: dict[tuple[int, int], str | None] = field(default_factory=dict, init=False)
    _stints: dict[tuple[int, int], list[StintSample]] = field(default_factory=dict, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def load(
        self, target: tuple[int, int]
    ) -> tuple[dict[tuple[int, int], str | None], list[StintSample]]:
        """(circuit per race, completed stints of races strictly before ``target``)."""
        with self._lock:
            reader = self.reader_factory()
            seq = target[0] * 100 + target[1]
            races = [k for k in reader.partitions("races", required=False)]
            for key in races:
                if key not in self._circuits:
                    rows = reader.read_rows("races", key[0], key[1], ("circuit_id",))
                    self._circuits[key] = (
                        str(rows[0]["circuit_id"]) if rows and rows[0].get("circuit_id") else None
                    )
            here = self._circuits.get(target)
            earlier = [k for k in races if k[0] * 100 + k[1] < seq]
            same = [k for k in earlier if here is not None and self._circuits.get(k) == here]
            # read this circuit's history first; every earlier race only if a compound needs it
            for key in same or earlier:
                self._read(reader, key)
            out = [s for k in earlier if k in self._stints for s in self._stints[k]]
            return dict(self._circuits), out

    def load_all(self, target: tuple[int, int]) -> list[StintSample]:
        """Completed stints of every race strictly before ``target`` (the all-circuit fallback)."""
        with self._lock:
            reader = self.reader_factory()
            seq = target[0] * 100 + target[1]
            for key in reader.partitions("races", required=False):
                if key[0] * 100 + key[1] < seq:
                    self._read(reader, key)
            return [s for k, v in self._stints.items() if k[0] * 100 + k[1] < seq for s in v]

    def _read(self, reader: LakeReader, key: tuple[int, int]) -> None:
        if key in self._stints:
            return
        rows = reader.read_rows(
            "analysis_stints", key[0], key[1], ("compound", "laps", "ends_in_pit", "is_synthetic")
        )
        self._stints[key] = [
            StintSample(key[0], key[1], c, int(r["laps"]), bool(r.get("is_synthetic")))
            for r in rows
            if r.get("ends_in_pit")
            and (c := known_compound(r.get("compound"))) is not None
            and isinstance(r.get("laps"), int)
            and int(r["laps"]) > 0
        ]


def needs_all_circuits(
    compounds: Iterable[str | None],
    target: tuple[int, int],
    circuit_of: Mapping[tuple[int, int], str | None],
    stints: Sequence[StintSample],
) -> bool:
    """True when some compound has no completed stint at this circuit before ``target``."""
    here = circuit_of.get(target)
    seq = target[0] * 100 + target[1]
    for c in compounds:
        if c is None:
            continue
        if not any(
            s.compound == c
            and s.season * 100 + s.round < seq
            and circuit_of.get((s.season, s.round)) == here
            for s in stints
        ):
            return True
    return False


@dataclass
class EngineerService:
    """The lake side of the engineer view, cached per race (the priors and the history of earlier
    races do not change during a replay). ``readers`` returns the what-if's read-only
    ``(clean, features)`` readers; only ``features/pit_loss`` is read through it."""

    readers: Callable[[], tuple[LakeReader, LakeReader]]
    history: StintHistory
    _pit_loss: dict[tuple[int, int], tuple[float | None, str]] = field(
        default_factory=dict, init=False
    )

    def pit_loss(self, season: int, round_: int) -> tuple[float | None, str]:
        """(pit_loss_prior_s, source) of the race; (None, "none") without a row."""
        key = (season, round_)
        if key not in self._pit_loss:
            _clean, features = self.readers()
            rows = features.read_rows(
                "pit_loss", season, round_, ("pit_loss_prior_s", "pit_loss_source")
            )
            loss = rows[0].get("pit_loss_prior_s") if rows else None
            source = rows[0].get("pit_loss_source") if rows else None
            if isinstance(loss, int | float) and not isinstance(loss, bool) and loss > 0:
                known = source if source in ("circuit_prior", "global_prior") else "none"
                self._pit_loss[key] = (float(loss), str(known))
            else:
                self._pit_loss[key] = (None, "none")
        return self._pit_loss[key]

    def stints(
        self, season: int, round_: int, compounds: Iterable[str | None]
    ) -> tuple[dict[tuple[int, int], str | None], list[StintSample]]:
        """Circuits and completed stints of earlier races; every earlier race only when one of
        ``compounds`` has no history at this circuit."""
        circuits, stints = self.history.load((season, round_))
        if needs_all_circuits(compounds, (season, round_), circuits, stints):
            stints = self.history.load_all((season, round_))
        return circuits, stints
