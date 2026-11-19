"use client";

import { useId } from "react";

import {
  compoundKey,
  compoundLetter,
  compoundName,
  type Coverage,
  type StrategyRow,
} from "@/lib/analysis";
import { innerX, linear, niceTicks } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { ChartHover } from "./ChartHover";
import { ChartTable, CompoundTag, SyntheticStamp, type Names } from "./common";

const ROW_H = 22;
const BASE = { width: 760, left: 52, right: 14, top: 10, bottom: 34 };

/** The pit-stop mark of the chart, authored (the Latin font subset has no "▼"). */
export function PitMark() {
  return (
    <svg className="pit-mark" width="10" height="7" viewBox="0 0 10 7" aria-hidden="true" focusable="false">
      <path d="M0 0h10l-5 7z" fill="currentColor" />
    </svg>
  );
}

/** "1 stop: 12 drivers · 2 stops: 7 drivers" (stops = stints − 1). */
export function stopSummary(rows: readonly StrategyRow[]): string {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.stints.length > 0) counts.set(r.stints.length - 1, (counts.get(r.stints.length - 1) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stops, n]) => `${stops} stop${stops === 1 ? "" : "s"}: ${n} driver${n === 1 ? "" : "s"}`)
    .join(" · ");
}

/** One row per driver (finishing order), each stint a bar in its compound colour with the
 * compound letter on it (``*`` = a used set), pit stops marked with a triangle. */
export function StrategyChart({ rows, laps, coverage, names }: { rows: StrategyRow[]; laps: number; coverage: Coverage; names: Names }) {
  const id = useId();
  const { ref, width } = useWidth<HTMLDivElement>(BASE.width);
  const height = BASE.top + BASE.bottom + rows.length * ROW_H;
  const frame = { ...BASE, width, height };
  const x = linear([0.5, Math.max(1, laps) + 0.5], innerX(frame));
  const ticks = niceTicks(1, Math.max(1, laps), Math.max(3, Math.floor(width / 90))).filter((t) => t >= 1 && Number.isInteger(t));
  const summary = stopSummary(rows);
  const marks = rows.flatMap((r, i) =>
    r.stints.map((st) => {
      const x0 = x(st.start - 0.5);
      const w = Math.max(1, x(st.end + 0.5) - x0);
      return { row: r, st, x0, w, y: BASE.top + i * ROW_H + 3 };
    }),
  );

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <h2 id={`${id}-h`}>Tyre strategy</h2>
      <p className="chart-summary">{summary || "No stints in the lake for this race."}</p>
      <p className="panel-note">
        Letters on the bars: S soft, M medium, H hard, I intermediate, W wet, ? unknown; * a used set;{" "}
        <PitMark /> a pit stop.
        {coverage.is_synthetic ? <> <SyntheticStamp>not real tyre data.</SyntheticStamp></> : null}
      </p>
      <div className="chart-scroll" ref={ref} style={{ height }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="chart">
          <title id={`${id}-t`}>Tyre strategy by driver</title>
          <desc id={`${id}-d`}>
            {rows.length} drivers in finishing order. {summary}. The table below lists every stint.
          </desc>
          {ticks.map((t) => (
            <g key={t} className="chart-grid">
              <line x1={x(t)} x2={x(t)} y1={BASE.top} y2={height - BASE.bottom} />
              <text x={x(t)} y={height - 18} textAnchor="middle">
                {t}
              </text>
            </g>
          ))}
          <text className="chart-axis-title" x={(BASE.left + width - BASE.right) / 2} y={height - 3} textAnchor="middle">
            lap
          </text>
          {rows.map((r, i) => {
            const y = BASE.top + i * ROW_H;
            return (
              <g key={r.driverId}>
                <text x={BASE.left - 8} y={y + 15} textAnchor="end" className="chart-label" fill="var(--text)">
                  {names.code(r.driverId)}
                </text>
                {r.stints.map((s) => {
                  const k = compoundKey(s.compound);
                  const x0 = x(s.start - 0.5);
                  const w = Math.max(1, x(s.end + 0.5) - x0);
                  return (
                    <g key={s.stint}>
                      <rect x={x0} y={y + 3} width={w} height={16} rx={2} fill={`var(--compound-${k})`} stroke="var(--surface)" strokeWidth={2} />
                      {w >= 16 ? (
                        <text x={x0 + w / 2} y={y + 15} textAnchor="middle" className="bar-label" fill={`var(--compound-${k}-ink)`}>
                          {compoundLetter(s.compound)}
                          {s.used ? "*" : ""}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
                {r.pitLaps.map((lap) => (
                  <path key={lap} d={`M${x(lap + 0.5) - 4} ${y}h8l-4 5z`} fill="var(--text)" />
                ))}
              </g>
            );
          })}
        </svg>
        <ChartHover
          width={width}
          height={height}
          points={marks.map((m) => ({ x: m.x0 + m.w / 2, y: m.y + 8 }))}
          mark={(i) => {
            const m = marks[i] as (typeof marks)[number];
            return { kind: "box", x: m.x0, y: m.y, w: m.w, h: 16 };
          }}
          readout={(i) => {
            const m = marks[i] as (typeof marks)[number];
            return {
              title: `${names.code(m.row.driverId)}, stint ${m.st.stint}`,
              rows: [
                { key: "c", value: compoundName(m.st.compound), label: m.st.used ? "used set" : "new set" },
                { key: "l", value: `${m.st.start}–${m.st.end}`, label: `laps (${m.st.end - m.st.start + 1})` },
              ],
            };
          }}
          label="Tyre strategy: read each stint"
        />
      </div>
      <ChartTable
        caption="Stints by driver"
        head={
          <tr>
            <th scope="col">Driver</th>
            <th scope="col">Stints</th>
            <th scope="col" className="c-num">Pit laps</th>
          </tr>
        }
      >
        {rows.map((r) => (
          <tr key={r.driverId}>
            <th scope="row">
              {names.code(r.driverId)} <span className="name">{names.name(r.driverId)}</span>
            </th>
            <td className="wrap">
              {r.stints.length === 0
                ? "—"
                : r.stints.map((s, i) => (
                    <span key={s.stint}>
                      {i > 0 ? " · " : ""}
                      <CompoundTag compound={s.compound} /> laps {s.start}–{s.end}
                      {s.used ? " (used set)" : ""}
                    </span>
                  ))}
            </td>
            <td className="c-num">{r.pitLaps.length ? r.pitLaps.join(", ") : "—"}</td>
          </tr>
        ))}
      </ChartTable>
    </section>
  );
}
