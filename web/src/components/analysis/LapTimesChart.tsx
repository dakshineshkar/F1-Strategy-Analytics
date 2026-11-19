"use client";

import { useId } from "react";

import {
  compoundLetter,
  lapSeries,
  lapTimeDomain,
  lapTimesSummary,
  type AnalysisLap,
  type NeutralRange,
} from "@/lib/analysis";
import { seriesColour } from "@/lib/chart";
import { lapTick, lapTime } from "@/lib/format";
import { innerX, innerY, linear, niceTicks, pathOf, spreadLabels } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { ChartHover, type HoverRow } from "./ChartHover";
import { ChartTable, CompoundMark, type Names } from "./common";

const BASE = { width: 760, height: 340, left: 56, right: 64, top: 22, bottom: 36 };
export const SERIES_DASHES = ["", "6 4", "2 3", "10 3 2 3"];
/** The stroke of the ``i``-th chosen driver: a categorical colour for the first four (2 px), then the neutral grid
 * (1.5 px) with a dash; the dash pattern repeats, the end label and the legend tell them apart. */
export function seriesStroke(i: number): { colour: string; dash: string; width: number } {
  return { colour: seriesColour(i), dash: SERIES_DASHES[i % SERIES_DASHES.length] ?? "", width: i < 4 ? 2 : 1.5 };
}

/** A legend's (and an end label's) line key: a short stroke in the series' colour and dash. */
export function LineKey({ colour, dash, width = 2 }: { colour: string; dash?: string; width?: number }) {
  return (
    <svg className="line-key" width="22" height="8" aria-hidden="true" focusable="false">
      <line x1="1" x2="21" y1="4" y2="4" stroke={colour} strokeWidth={width} strokeDasharray={dash || undefined} />
    </svg>
  );
}
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
  const xTicks = niceTicks(1, Math.max(1, totalLaps), Math.max(3, Math.floor(width / 90))).filter((t) => t >= 1 && Number.isInteger(t));
  const ends = spreadLabels(
    series.flatMap((s) => {
      const last = s.points[s.points.length - 1];
      return last ? [{ id: s.driverId, y: Math.min(y(last.time), yBottom) }] : [];
    }),
    13,
    yTop + 4,
    yBottom,
  );
  const endY = new Map(ends.map((e) => [e.id, e.y]));
  const hoverLaps = [...new Set(series.flatMap((s) => s.points.map((p) => p.lap)))].sort((a, b) => a - b);
  const summary = lapTimesSummary(series, names.code);

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
      {summary.length > 0 ? (
        <ul className="chart-summary">
          {summary.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="chart-summary">No driver chosen: tick one above.</p>
      )}
      <p className="panel-note">
        Point shape and colour give the compound; P marks a pit-in lap; shaded bands are SC, VSC or red-flag laps
        (labelled).{dom.above > 0 ? ` ${dom.above} slow laps (pit, SC) are pinned to the top edge.` : ""}
      </p>
      {series.length > 1 ? (
        <ul className="chart-legend" aria-label="Lines">
          {series.map((s, i) => {
            const st = seriesStroke(i);
            return (
              <li key={s.driverId}>
                <LineKey colour={st.colour} dash={st.dash} width={st.width} /> {names.code(s.driverId)}
              </li>
            );
          })}
        </ul>
      ) : null}
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
                {lapTick(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="chart-axis" x={x(t)} y={BASE.height - 18} textAnchor="middle">
              {t}
            </text>
          ))}
          <text className="chart-axis-title" x={(BASE.left + width - BASE.right) / 2} y={BASE.height - 3} textAnchor="middle">
            lap
          </text>
          {markLap ? (
            <g className="lap-mark" aria-hidden="true">
              <line x1={x(markLap)} x2={x(markLap)} y1={yTop} y2={yBottom} />
              <text x={x(markLap) + 4} y={yTop + 12}>
                Lap {markLap}
              </text>
            </g>
          ) : null}
          {series.map((s, i) => {
            const last = s.points[s.points.length - 1];
            const st = seriesStroke(i);
            const ly = endY.get(s.driverId);
            return (
              <g key={s.driverId} style={{ color: st.colour }}>
                <path
                  d={pathOf(s.points, (p) => x(p.lap), (p) => y(p.time))}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={st.width}
                  strokeLinejoin="round"
                  strokeDasharray={st.dash || undefined}
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
                    <text key={`p${p.lap}`} x={x(p.lap)} y={Math.max(yTop + 10, y(p.time) - 7)} textAnchor="middle" className="chart-label" fill="var(--text)">
                      P
                    </text>
                  ))}
                {last && ly !== undefined ? (
                  <>
                    <line x1={width - BASE.right + 4} x2={width - BASE.right + 16} y1={ly} y2={ly} stroke="currentColor" strokeWidth={st.width} strokeDasharray={st.dash ? "3 2" : undefined} />
                    <text x={width - BASE.right + 20} y={ly + 4} className="chart-label" fill="var(--text)">
                      {names.code(s.driverId)}
                    </text>
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
        <ChartHover
          width={width}
          height={BASE.height}
          points={hoverLaps.map((l) => ({ x: x(l) }))}
          mark={(i) => ({ kind: "line", x: x(hoverLaps[i] as number), top: yTop, bottom: yBottom })}
          readout={(i) => {
            const lap = hoverLaps[i] as number;
            return {
              title: `Lap ${lap}`,
              rows: series.map((s, k): HoverRow => {
                const p = s.points.find((q) => q.lap === lap);
                const st = seriesStroke(k);
                return {
                  key: s.driverId,
                  value: p ? `${lapTime(p.time)} ${compoundLetter(p.compound)}` : "—",
                  label: `${names.code(s.driverId)}${p?.pit === "in" ? ", pit in" : p?.pit === "out" ? ", pit out" : ""}${p?.neutralised ? ", SC/VSC" : ""}`,
                  stroke: { colour: st.colour, dash: st.dash },
                };
              }),
            };
          }}
          label="Lap times: read a lap"
        />
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
