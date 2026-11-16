"use client";

import { useId, useState } from "react";

import { positionLines, teamStyles, type PositionSeries } from "@/lib/analysis";
import { gridLabel } from "@/lib/entrants";
import { innerX, innerY, linear, pathOf, spreadLabels } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { ChartTable, type Names } from "./common";

const BASE = { width: 760, height: 420, left: 40, top: 14, bottom: 30 };

/** Position at the end of every lap (lap 0 = the grid; a pit-lane start at the back). Each line has
 * its team colour over a border-coloured halo (visible on any background), the second driver of a
 * team is dashed, and every line ends in a label (code or full name), so colour is never the only
 * cue. A highlight dims the others. */
export function PositionsChart({ series, totalLaps, names }: { series: PositionSeries[]; totalLaps: number; names: Names }) {
  const id = useId();
  const [labels, setLabels] = useState<"code" | "name">("code");
  const [focus, setFocus] = useState("");
  const { ref, width } = useWidth<HTMLDivElement>(BASE.width);
  const right = labels === "code" ? 48 : 150;
  const frame = { ...BASE, right, width };
  const lines = positionLines(series);
  const field = Math.max(1, ...lines.flatMap((l) => l.points.map((p) => p.position)));
  const x = linear([0, Math.max(1, totalLaps)], innerX(frame));
  const y = linear([1, field], innerY(frame));
  const styles = teamStyles(
    lines.map((l) => l.driverId),
    names.team,
  );
  const ends = spreadLabels(
    lines.map((l) => ({ id: l.driverId, y: y(l.points[l.points.length - 1]?.position ?? field) })),
    13,
    BASE.top,
    BASE.height - BASE.bottom,
  );
  const endY = new Map(ends.map((e) => [e.id, e.y]));
  const label = (id: string) => (labels === "code" ? names.code(id) : names.name(id));
  const yTicks = [1, 5, 10, 15, 20].filter((p) => p <= field);
  const xTicks = [0, ...Array.from({ length: Math.floor(totalLaps / 10) }, (_, i) => (i + 1) * 10)];

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <div className="panel-head">
        <h2 id={`${id}-h`}>Positions</h2>
        <div className="inline-field" role="radiogroup" aria-label="Line labels">
          <span>Labels</span>
          {(["code", "name"] as const).map((v) => (
            <label key={v}>
              <input type="radio" name={`${id}-labels`} checked={labels === v} onChange={() => setLabels(v)} />{" "}
              {v === "code" ? "Code" : "Full name"}
            </label>
          ))}
        </div>
        <label className="inline-field">
          <span>Highlight</span>
          <select value={focus} onChange={(e) => setFocus(e.target.value)}>
            <option value="">None</option>
            {lines.map((l) => (
              <option key={l.driverId} value={l.driverId}>
                {names.code(l.driverId)} · {names.name(l.driverId)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="panel-note">Team colours; the second driver of each team is dashed. Lap 0 is the grid.</p>
      <div className="chart-box" ref={ref} style={{ height: BASE.height }}>
        <svg viewBox={`0 0 ${width} ${BASE.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="chart">
          <title id={`${id}-t`}>Position by lap</title>
          <desc id={`${id}-d`}>
            {lines.length} drivers in finishing order: {lines.map((l) => names.code(l.driverId)).join(", ")}. P1 at the top.
          </desc>
          {yTicks.map((p) => (
            <g key={p} className="chart-grid">
              <line x1={BASE.left} x2={width - right} y1={y(p)} y2={y(p)} />
              <text x={BASE.left - 6} y={y(p) + 4} textAnchor="end">
                P{p}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="chart-axis" x={x(t)} y={BASE.height - 10} textAnchor="middle">
              {t === 0 ? "Grid" : t}
            </text>
          ))}
          {lines.map((l, i) => {
            const style = styles.get(l.driverId);
            const colour = style?.colour ?? `var(--line-${i % 10})`;
            const chosen = focus === l.driverId;
            const dim = focus !== "" && !chosen;
            const d = pathOf(l.points, (p) => x(p.lap), (p) => y(p.position));
            return (
              <g key={l.driverId} className={`chart-line${dim ? " is-dim" : ""}`}>
                <path d={d} fill="none" stroke="var(--border)" strokeWidth={chosen ? 5.5 : 3.75} strokeLinejoin="round" />
                <path
                  d={d}
                  fill="none"
                  stroke={colour}
                  strokeWidth={chosen ? 3.5 : 2}
                  strokeDasharray={style?.dash || undefined}
                  strokeLinejoin="round"
                />
                <text x={width - right + 6} y={(endY.get(l.driverId) ?? 0) + 4} className="chart-label" fill="var(--text)">
                  {label(l.driverId)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ChartTable
        caption="Positions by driver"
        head={
          <tr>
            <th scope="col">Driver</th>
            <th scope="col" className="c-num">Grid</th>
            <th scope="col" className="c-num">Last pos.</th>
            <th scope="col" className="c-num">Laps</th>
            <th scope="col">Position by lap</th>
          </tr>
        }
      >
        {series.map((s) => {
          const last = s.positions[s.positions.length - 1];
          return (
            <tr key={s.driver_id}>
              <th scope="row">
                {names.code(s.driver_id)} <span className="name">{names.name(s.driver_id)}</span>
              </th>
              <td className="c-num">{gridLabel(s.grid)}</td>
              <td className="c-num">{last ? `P${last.position}` : "—"}</td>
              <td className="c-num">{last ? last.lap : 0}</td>
              <td className="wrap">{s.positions.map((p) => p.position).join(" ")}</td>
            </tr>
          );
        })}
      </ChartTable>
    </section>
  );
}
