"use client";

import { useId } from "react";

import {
  compoundLetter,
  lapSeries,
  lapTimeDomain,
  type AnalysisLap,
  type NeutralRange,
} from "@/lib/analysis";
import { lapTime } from "@/lib/format";
import { innerX, innerY, linear, niceTicks, pathOf } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { ChartTable, CompoundMark, type Names } from "./common";

const BASE = { width: 760, height: 340, left: 56, right: 48, top: 22, bottom: 30 };
export const SERIES_DASHES = ["", "6 4", "2 3", "10 3 2 3"];
const NEUTRAL_TEXT: Record<NeutralRange["kind"], string> = { SC: "SC", VSC: "VSC", RED: "RED", NEUTRALISED: "NEU" };

/** Lap times of the chosen drivers: a thin line per driver (colour + dash + end label), each lap a
 * point whose shape and colour give the compound, pit laps marked P, SC/VSC/red-flag laps as bands
 * with a text label, and the lap from the URL marked. Laps far above the field's median time are
 * pinned to the top edge (counted in the description); the table has every value. */
export function LapTimesChart({
  laps,
  drivers,
  order,
  onToggle,
  neutral,
  markLap,
  totalLaps,
  names,
}: {
  laps: readonly AnalysisLap[];
  drivers: readonly string[];
  order: readonly string[];
  onToggle: (id: string) => void;
  neutral: readonly NeutralRange[];
  markLap: number | null;
  totalLaps: number;
  names: Names;
}) {
  const id = useId();
  const { ref, width } = useWidth<HTMLDivElement>(BASE.width);
  const frame = { ...BASE, width };
  const series = lapSeries(laps, drivers);
  const dom = lapTimeDomain(series.flatMap((s) => s.points.map((p) => p.time)));
  const x = linear([0.5, Math.max(1, totalLaps) + 0.5], innerX(frame));
  const [yTop, yBottom] = innerY(frame);
  const y = linear([dom.lo, dom.hi], [yBottom, yTop], true);
  const yTicks = niceTicks(dom.lo, dom.hi, 5);
  const xTicks = niceTicks(1, Math.max(1, totalLaps), Math.max(3, Math.floor(width / 90))).filter((t) => t >= 1);

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <h2 id={`${id}-h`}>Lap times</h2>
      <fieldset className="driver-picker">
        <legend>Drivers (finishing order)</legend>
        {order.map((d) => (
          <label key={d}>
            <input type="checkbox" checked={drivers.includes(d)} onChange={() => onToggle(d)} /> {names.code(d)}
          </label>
        ))}
      </fieldset>
      <p className="panel-note">
        Point shape and colour give the compound; P marks a pit-in lap; shaded bands are SC, VSC or red-flag laps
        (labelled).{dom.above > 0 ? ` ${dom.above} slow laps (pit, SC) are pinned to the top edge.` : ""}
      </p>
      <div className="chart-box" ref={ref} style={{ height: BASE.height }}>
        <svg viewBox={`0 0 ${width} ${BASE.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="chart">
          <title id={`${id}-t`}>Lap times by lap</title>
          <desc id={`${id}-d`}>
            {drivers.length === 0
              ? "No driver chosen."
              : `${drivers.map((d) => names.code(d)).join(", ")}: lap time in seconds by lap, ${lapTime(dom.lo)} to ${lapTime(dom.hi)}.`}
            {neutral.length > 0 ? ` Neutralised: ${neutral.map((n) => `${NEUTRAL_TEXT[n.kind]} laps ${n.from}–${n.to}`).join(", ")}.` : ""}
            {markLap ? ` Lap ${markLap} is marked.` : ""}
          </desc>
          {neutral.map((n) => (
            <g key={`${n.kind}-${n.from}`} className="neutral-band">
              <rect x={x(n.from - 0.5)} y={yTop} width={Math.max(2, x(n.to + 0.5) - x(n.from - 0.5))} height={yBottom - yTop} />
              <text x={(x(n.from - 0.5) + x(n.to + 0.5)) / 2} y={yTop - 6} textAnchor="middle">
                {NEUTRAL_TEXT[n.kind]}
              </text>
            </g>
          ))}
          {yTicks.map((t) => (
            <g key={t} className="chart-grid">
              <line x1={BASE.left} x2={width - BASE.right} y1={y(t)} y2={y(t)} />
              <text x={BASE.left - 6} y={y(t) + 4} textAnchor="end">
                {lapTime(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="chart-axis" x={x(t)} y={BASE.height - 10} textAnchor="middle">
              {t}
            </text>
          ))}
          {markLap ? (
            <g className="lap-mark">
              <line x1={x(markLap)} x2={x(markLap)} y1={yTop} y2={yBottom} />
              <text x={x(markLap) + 4} y={yTop + 12}>
                Lap {markLap}
              </text>
            </g>
          ) : null}
          {series.map((s, i) => {
            const last = s.points[s.points.length - 1];
            return (
              <g key={s.driverId} style={{ color: `var(--line-${i % 10})` }}>
                <path
                  d={pathOf(s.points, (p) => x(p.lap), (p) => y(p.time))}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeDasharray={SERIES_DASHES[i % SERIES_DASHES.length] || undefined}
                />
                {s.points.map((p) =>
                  p.time > dom.hi ? (
                    <path key={p.lap} d={`M${x(p.lap)} ${yTop - 1}l-4 7h8z`} fill="currentColor" />
                  ) : (
                    <CompoundMark key={p.lap} compound={p.compound} x={x(p.lap)} y={y(p.time)} r={3.5} />
                  ),
                )}
                {s.points
                  .filter((p) => p.pit === "in")
                  .map((p) => (
                    <text key={`p${p.lap}`} x={x(p.lap)} y={Math.max(yTop + 10, y(p.time) - 7)} textAnchor="middle" className="chart-label" fill="currentColor">
                      P
                    </text>
                  ))}
                {last ? (
                  <text x={width - BASE.right + 6} y={y(last.time) + 4} className="chart-label" fill="currentColor">
                    {names.code(s.driverId)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <ChartTable
        caption="Lap times by lap"
        head={
          <tr>
            <th scope="col" className="c-num">Lap</th>
            {series.map((s) => (
              <th key={s.driverId} scope="col">
                {names.code(s.driverId)}
              </th>
            ))}
          </tr>
        }
      >
        {Array.from({ length: totalLaps }, (_, i) => i + 1).map((lap) => (
          <tr key={lap} className={lap === markLap ? "is-marked" : undefined}>
            <th scope="row" className="c-num">
              {lap}
            </th>
            {series.map((s) => {
              const p = s.points.find((q) => q.lap === lap);
              return (
                <td key={s.driverId}>
                  {p
                    ? `${lapTime(p.time)} ${compoundLetter(p.compound)}${p.pit === "in" ? " pit in" : p.pit === "out" ? " pit out" : ""}${p.neutralised ? " SC/VSC" : ""}`
                    : "—"}
                </td>
              );
            })}
          </tr>
        ))}
      </ChartTable>
    </section>
  );
}
