"use client";

import { useId, useMemo, useState } from "react";

import { CHART_LAPS, gapSeries, layoutLabels, linePath, scales } from "@/lib/chart";
import { driverCode, driverName, gap } from "@/lib/format";
import type { RaceState } from "@/lib/reducer";
import { useWidth } from "@/lib/useWidth";

const BASE = { width: 720, height: 300, left: 44, right: 56, top: 16, bottom: 28 };
const DASHES = ["", "6 4", "2 3", "10 3 2 3"];

/** Gap to the leader over the last 15 laps (hand-written SVG). Every car is a neutral line with a dash
 * pattern and its driver code at the end; the highlighted car is drawn thicker in the text colour. No
 * categorical colour is cycled over twenty cars, and none sits next to the tower's team colours. A visually
 * hidden table carries the same numbers for screen readers.
 *
 * With ``pair`` (the live race view's call) the chart argues one thing: every car is a neutral line and only
 * the attacker (signal) and the defender (text colour) are drawn in colour and labelled, so ten line colours
 * are never cycled over twenty cars.
 *
 * ``live``: the chart holds only the laps this page received (critique F24; the history from before the page
 * opened is not back-filled, by decision). It says so in a note above the plot, and the laps of the window
 * that ran before the first lap received keep their place on the axis as a hatched band labelled "not
 * received", so an empty stretch is never read as a quiet stretch of the race. */
export function GapChart({
  state,
  pair = null,
  live = false,
}: {
  state: RaceState;
  pair?: { attackerId: string; defenderId: string } | null;
  /** the live race view: the history starts when this page opened (the archive replays from lap 1) */
  live?: boolean;
}) {
  const titleId = useId();
  const descId = useId();
  const [focus, setFocus] = useState<string>("");
  const { ref: boxRef, width } = useWidth<HTMLDivElement>(BASE.width);
  const FRAME = { ...BASE, width };
  const { lapRange, series } = useMemo(
    () => gapSeries(state.history, state.maxLap, state.order, CHART_LAPS),
    [state.history, state.maxLap, state.order],
  );
  const received = Object.keys(state.history).map(Number).filter(Number.isFinite);
  const firstReceived = received.length > 0 ? Math.min(...received) : null;
  const range = lapRange;
  // the window's laps before the first lap this page received (all of them when none arrived yet)
  const missing: [number, number] | null =
    state.maxLap < 1
      ? null
      : firstReceived === null
        ? range
        : firstReceived > range[0]
          ? [range[0], Math.min(firstReceived - 1, range[1])]
          : null;
  const missingText = missing === null ? "" : missing[0] === missing[1] ? `lap ${missing[0]}` : `laps ${missing[0]} to ${missing[1]}`;
  const hatchId = `hatch-${titleId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const maxGap = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.gapS)));
  const { x, y, yMax } = scales(FRAME, range, maxGap);
  const role = (id: string): "attacker" | "defender" | null =>
    pair === null ? null : id === pair.attackerId ? "attacker" : id === pair.defenderId ? "defender" : null;
  const labelled = pair === null ? series : series.filter((s) => role(s.driverId) !== null || s.driverId === focus);
  // rounded ticks repeat on a small range (0, 0, 1, 1, 2): keep each value once (it is also the React key)
  const ticks = [...new Set([0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax].map((t) => Math.round(t)))];
  const labels = layoutLabels(
    labelled.map((s) => ({ id: s.driverId, y: y(s.points[s.points.length - 1]?.gapS ?? 0) })),
    11,
    FRAME.top,
    FRAME.height - FRAME.bottom,
  );
  const labelY = new Map(labels.map((l) => [l.id, l.y]));
  const lapsShown = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
  const plotRight = FRAME.width - FRAME.right;
  const band =
    missing === null
      ? null
      : { x0: FRAME.left, x1: missing[1] >= range[1] ? plotRight : (x(missing[1]) + x(missing[1] + 1)) / 2 };
  const note = !live
    ? null
    : firstReceived === null
      ? `History from when you opened the page. No laps received yet${missing ? `; ${missingText} ran before that and are not shown` : ""}.`
      : `History from when you opened the page (from lap ${firstReceived}).${missing ? ` ${missingText.charAt(0).toUpperCase()}${missingText.slice(1)} ran before that and ${missing[0] === missing[1] ? "is" : "are"} not shown.` : ""}`;
  const bandLabel = live ? "Before you opened the page" : "No data";

  return (
    <section className="panel chart-panel" aria-labelledby={`${titleId}-h`}>
      <div className="panel-head">
        <h2 id={`${titleId}-h`}>Gap to leader</h2>
        <label className="inline-field">
          <span>Highlight</span>
          <select value={focus} onChange={(e) => setFocus(e.target.value)}>
            <option value="">None</option>
            {state.order.map((id) => (
              <option key={id} value={id}>
                {driverCode(id)} · {driverName(id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {note !== null ? <p className="panel-note chart-note">{note}</p> : null}
      <div className="chart-box" ref={boxRef}>
        <svg viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="chart">
          <title id={titleId}>{`Gap to leader, laps ${range[0]} to ${range[1]}${missing ? `; ${missingText} not received${live ? " (before this page opened)" : ""}` : ""}`}</title>
          <desc id={descId}>
            {series.length === 0
              ? live
                ? "No laps received since you opened this page."
                : "No laps received yet."
              : `${series.length} drivers. Leader at the top; lower lines are further behind, capped at ${yMax} seconds.`}
          </desc>
          {band !== null ? (
            <g className="chart-missing" aria-hidden="true">
              <defs>
                <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" />
                </pattern>
              </defs>
              <rect x={band.x0} y={FRAME.top} width={Math.max(0, band.x1 - band.x0)} height={FRAME.height - FRAME.bottom - FRAME.top} fill={`url(#${hatchId})`} />
              <line className="chart-missing-edge" x1={band.x1} x2={band.x1} y1={FRAME.top} y2={FRAME.height - FRAME.bottom} />
              {band.x1 - band.x0 >= 132 ? (
                <text className="chart-missing-label" x={(band.x0 + band.x1) / 2} y={FRAME.top + 14} textAnchor="middle">
                  <tspan x={(band.x0 + band.x1) / 2}>{bandLabel}</tspan>
                  <tspan x={(band.x0 + band.x1) / 2} dy="14">not received</tspan>
                </text>
              ) : null}
            </g>
          ) : null}
          {ticks.map((t) => (
            <g key={t} className="chart-grid">
              <line x1={FRAME.left} x2={FRAME.width - FRAME.right} y1={y(t)} y2={y(t)} />
              <text x={FRAME.left - 6} y={y(t) + 4} textAnchor="end">{t}s</text>
            </g>
          ))}
          {lapsShown.map((lap) => (
            <text key={lap} className="chart-axis" x={x(lap)} y={FRAME.height - 8} textAnchor="middle">
              {lap}
            </text>
          ))}
          {series.map((s, i) => {
            const r = role(s.driverId);
            const chosen = focus === s.driverId || r !== null;
            const dim = (focus !== "" || pair !== null) && !chosen;
            const last = s.points[s.points.length - 1];
            const colour =
              r === "attacker" ? "var(--signal-mark)" : r === "defender" || (pair === null && focus === s.driverId) ? "var(--text)" : "var(--grid)";
            const label = labelY.get(s.driverId);
            return (
              <g key={s.driverId} className={`chart-line${dim ? " is-dim" : ""}${chosen ? " is-focus" : ""}`} style={{ color: colour }}>
                <path d={linePath(s.points, x, y)} fill="none" stroke="currentColor" strokeWidth={chosen ? 3 : 1.5} strokeDasharray={(pair === null ? DASHES[i % DASHES.length] : r === "defender" ? "6 4" : "") || undefined} />
                {last ? <circle cx={x(last.lap)} cy={y(last.gapS)} r={chosen ? 4 : 2.5} fill="currentColor" /> : null}
                {label !== undefined ? (
                  <text x={FRAME.width - FRAME.right + 6} y={label + 4} className="chart-label" fill="var(--text)">
                    {driverCode(s.driverId)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      {/* A <table> ignores the 1px width of the visually-hidden pattern: hide a wrapper instead. */}
      <div className="visually-hidden">
        <table>
          <caption>{`Gap to leader in seconds by lap${missing ? `; ${missingText} not received${live ? ", before this page opened" : ""}` : ""}`}</caption>
          <thead>
            <tr>
              <th scope="col">Driver</th>
              {lapsShown.map((lap) => (
                <th key={lap} scope="col">Lap {lap}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const byLap = new Map(s.points.map((p) => [p.lap, p.gapS]));
              return (
                <tr key={s.driverId}>
                  <th scope="row">{driverName(s.driverId)}</th>
                  {lapsShown.map((lap) => (
                    <td key={lap}>{byLap.has(lap) ? gap(byLap.get(lap) ?? null) : "—"}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
