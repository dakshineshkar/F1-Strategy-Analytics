"use client";

import { useId } from "react";

import { InfoTip } from "@/components/InfoTip";
import { compareSummary, compoundLetter, sectorTotals, signed, type Compare } from "@/lib/analysis";
import { lapTime } from "@/lib/format";
import { innerX, innerY, linear, niceTicks, pathOf } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { seriesColour } from "@/lib/chart";

import { ChartHover } from "./ChartHover";
import { ChartTable, type Names } from "./common";

const DELTA = { width: 760, height: 220, left: 56, right: 16, top: 16, bottom: 34 };
const GAP = { width: 760, height: 220, left: 56, right: 16, top: 16, bottom: 34 };
const DELTA_CAP_S = 5;

/** One sentence: who was faster how often, the median lap delta and the gap at the end. */
export function compareText(c: Compare): string {
  const s = compareSummary(c.rows);
  const a = c.a.driver_code;
  const b = c.b.driver_code;
  const parts = [`On ${s.laps} laps with both times, ${a} was faster on ${s.aFaster} and ${b} on ${s.bFaster}.`];
  if (s.medianDelta !== null) parts.push(`Median lap delta (${a} − ${b}): ${signed(s.medianDelta)} s.`);
  if (s.finalGap !== null && s.finalLap !== null)
    parts.push(
      `After lap ${s.finalLap}, ${s.finalGap > 0 ? `${a} was ${Math.abs(s.finalGap).toFixed(3)} s behind ${b}` : s.finalGap < 0 ? `${a} was ${Math.abs(s.finalGap).toFixed(3)} s ahead of ${b}` : "they were level"}.`,
    );
  return parts.join(" ");
}

export function CompareView({
  compare,
  error,
  a,
  b,
  order,
  onPick,
  totalLaps,
  hasSectors,
  names,
}: {
  compare: Compare | null;
  error: string | null;
  a: string | null;
  b: string | null;
  order: readonly string[];
  onPick: (a: string, b: string) => void;
  totalLaps: number;
  hasSectors: boolean;
  names: Names;
}) {
  const id = useId();
  const { ref, width } = useWidth<HTMLDivElement>(DELTA.width);
  const codes = order.map((d) => names.code(d));
  const rows = compare?.rows ?? [];
  const x = linear([0.5, Math.max(1, totalLaps) + 0.5], innerX({ ...DELTA, width }));
  const deltas = rows.map((r) => r.delta_s).filter((d): d is number => d !== null);
  const dMax = Math.min(DELTA_CAP_S, Math.max(0.5, ...deltas.map(Math.abs)));
  const [dTop, dBottom] = innerY(DELTA);
  const dy = linear([-dMax, dMax], [dBottom, dTop], true);
  const gaps = rows.map((r) => r.gap_s).filter((g): g is number => g !== null);
  const gLo = Math.min(-1, ...gaps);
  const gHi = Math.max(1, ...gaps);
  const [gTop, gBottom] = innerY(GAP);
  const gy = linear([gLo, gHi], [gBottom, gTop]);
  const xTicks = niceTicks(1, Math.max(1, totalLaps), Math.max(3, Math.floor(width / 90))).filter((t) => t >= 1 && Number.isInteger(t));
  const barW = Math.max(1.5, (x(2) - x(1)) * 0.7);
  const ac = compare?.a.driver_code ?? a ?? "A";
  const bc = compare?.b.driver_code ?? b ?? "B";
  const deltaRows = rows.filter((r) => r.delta_s !== null);
  const gapRows = rows.filter((r) => r.gap_s !== null);
  const notes = (r: (typeof rows)[number]) =>
    [r.a_pit ? `${ac} pit` : "", r.b_pit ? `${bc} pit` : "", r.neutralised ? "SC/VSC" : ""].filter(Boolean).join(", ");
  const axisTitle = (h: number, f: typeof DELTA) => (
    <text className="chart-axis-title" x={(f.left + width - f.right) / 2} y={h - 3} textAnchor="middle">
      lap
    </text>
  );

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <div className="panel-head">
        <h2 id={`${id}-h`}>
          Compare two drivers <InfoTip id="cumgap" />
        </h2>
        <div className="compare-pick">
          <label className="inline-field">
            <span>Driver a</span>
            <select value={a ?? ""} onChange={(e) => onPick(e.target.value, b ?? "")}>
              {codes.map((c) => (
                <option key={c} value={c} disabled={c === b}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            <span>Driver b</span>
            <select value={b ?? ""} onChange={(e) => onPick(a ?? "", e.target.value)}>
              {codes.map((c) => (
                <option key={c} value={c} disabled={c === a}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-small" onClick={() => a && b && onPick(b, a)}>
            Swap
          </button>
        </div>
      </div>
      {/* measured here, not on a chart: this box is mounted while the comparison loads, so the charts get the
          panel's width (a ref on a chart mounted later was never observed and stayed at the 760 px fallback) */}
      <div ref={ref} className="compare-body">
      {error !== null ? (
        <p className="error" role="alert">
          Could not compare: {error}
        </p>
      ) : compare === null ? (
        <p className="muted" aria-live="polite">
          Loading the comparison…
        </p>
      ) : (
        <>
          <p className="compare-summary" aria-live="polite">
            {compareText(compare)}
          </p>
          <h3 className="chart-h">
            Lap delta ({ac} − {bc}): bars above the line = {ac} slower, below = {ac} faster
          </h3>
          <ul className="chart-legend" aria-label="Bars">
            <li>
              <span className="bar-key bar-key-gain" aria-hidden="true" /> {ac} faster (below)
            </li>
            <li>
              <span className="bar-key bar-key-loss" aria-hidden="true" /> {ac} slower (above)
            </li>
            <li>
              <span className="bar-key bar-key-hollow" aria-hidden="true" /> pit or SC/VSC lap (hollow)
            </li>
          </ul>
          <div className="chart-box" style={{ height: DELTA.height }}>
            <svg viewBox={`0 0 ${width} ${DELTA.height}`} role="img" aria-labelledby={`${id}-dt ${id}-dd`} className="chart">
              <title id={`${id}-dt`}>
                {`Lap time delta, ${ac} minus ${bc}, by lap (capped at ±${dMax.toFixed(1)} s; pit and neutralised laps hollow)`}
              </title>
              <desc id={`${id}-dd`}>{`${compareText(compare)} Every lap's delta is in the table below.`}</desc>
              {[-dMax, -dMax / 2, 0, dMax / 2, dMax].map((t) => (
                <g key={t} className="chart-grid">
                  <line x1={DELTA.left} x2={width - DELTA.right} y1={dy(t)} y2={dy(t)} />
                  <text x={DELTA.left - 6} y={dy(t) + 4} textAnchor="end">
                    {signed(t).replace(/0+$/, "").replace(/\.$/, "")}s
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text key={t} className="chart-axis" x={x(t)} y={DELTA.height - 18} textAnchor="middle">
                  {t}
                </text>
              ))}
              {axisTitle(DELTA.height, DELTA)}
              {rows.map((r) => {
                if (r.delta_s === null) return null;
                const top = Math.min(dy(r.delta_s), dy(0));
                const h = Math.max(1, Math.abs(dy(r.delta_s) - dy(0)));
                const hollow = r.a_pit || r.b_pit || r.neutralised;
                // gain blue below the line (A faster), loss orange above (A slower): the side carries the meaning
                const colour = r.delta_s < 0 ? "var(--gain)" : "var(--loss)";
                return (
                  <rect
                    key={r.lap}
                    x={x(r.lap) - barW / 2}
                    y={top}
                    width={barW}
                    height={h}
                    fill={hollow ? "none" : colour}
                    stroke={colour}
                    strokeWidth={1}
                  />
                );
              })}
            </svg>
            <ChartHover
              width={width}
              height={DELTA.height}
              points={deltaRows.map((r) => ({ x: x(r.lap) }))}
              mark={(i) => ({ kind: "line", x: x((deltaRows[i] as (typeof rows)[number]).lap), top: dTop, bottom: dBottom })}
              readout={(i) => {
                const r = deltaRows[i] as (typeof rows)[number];
                const d = r.delta_s as number;
                return {
                  title: `Lap ${r.lap}${notes(r) ? ` (${notes(r)})` : ""}`,
                  rows: [
                    { key: "d", value: `${signed(d)} s`, label: d < 0 ? `${ac} faster` : d > 0 ? `${ac} slower` : "level" },
                    { key: "a", value: lapTime(r.a_lap_time_s), label: ac },
                    { key: "b", value: lapTime(r.b_lap_time_s), label: bc },
                  ],
                };
              }}
              label="Lap delta: read a lap"
            />
          </div>
          <h3 className="chart-h">
            Gap ({ac} − {bc}) at the end of each lap: above the line = {ac} behind
          </h3>
          <div className="chart-box" style={{ height: GAP.height }}>
            <svg viewBox={`0 0 ${width} ${GAP.height}`} role="img" aria-labelledby={`${id}-gt ${id}-gd`} className="chart">
              <title id={`${id}-gt`}>{`Cumulative gap, ${ac} minus ${bc}, by lap`}</title>
              <desc id={`${id}-gd`}>
                {gapRows.length === 0
                  ? "No lap with both cars timed."
                  : `From lap ${(gapRows[0] as (typeof rows)[number]).lap} to lap ${(gapRows[gapRows.length - 1] as (typeof rows)[number]).lap}; above zero ${ac} is behind ${bc}. Every gap is in the table below.`}
              </desc>
              {niceTicks(gLo, gHi, 4).map((t) => (
                <g key={t} className="chart-grid">
                  <line x1={GAP.left} x2={width - GAP.right} y1={gy(t)} y2={gy(t)} />
                  <text x={GAP.left - 6} y={gy(t) + 4} textAnchor="end">
                    {t}s
                  </text>
                </g>
              ))}
              <line x1={GAP.left} x2={width - GAP.right} y1={gy(0)} y2={gy(0)} stroke="var(--text)" strokeWidth={1} />
              <path
                d={pathOf(rows, (r) => x(r.lap), (r) => (r.gap_s === null ? null : gy(r.gap_s)))}
                fill="none"
                stroke={seriesColour(0)}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {xTicks.map((t) => (
                <text key={t} className="chart-axis" x={x(t)} y={GAP.height - 18} textAnchor="middle">
                  {t}
                </text>
              ))}
              {axisTitle(GAP.height, GAP)}
            </svg>
            <ChartHover
              width={width}
              height={GAP.height}
              points={gapRows.map((r) => ({ x: x(r.lap) }))}
              mark={(i) => ({ kind: "line", x: x((gapRows[i] as (typeof rows)[number]).lap), top: gTop, bottom: gBottom })}
              readout={(i) => {
                const r = gapRows[i] as (typeof rows)[number];
                const g = r.gap_s as number;
                return {
                  title: `After lap ${r.lap}`,
                  rows: [
                    {
                      key: "g",
                      value: `${Math.abs(g).toFixed(3)} s`,
                      label: g > 0 ? `${ac} behind ${bc}` : g < 0 ? `${ac} ahead of ${bc}` : "level",
                      stroke: { colour: seriesColour(0) },
                    },
                  ],
                };
              }}
              label="Gap: read a lap"
            />
          </div>
          {hasSectors ? (
            <ul className="analysis-list" aria-label="Sector totals">
              {sectorTotals(rows).map((s) => (
                <li key={s.sector}>
                  Sector {s.sector}: {ac} {signed(s.total)} s vs {bc} over {s.laps} laps (
                  {s.total < 0 ? `${ac} faster` : s.total > 0 ? `${bc} faster` : "level"})
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">No sector times in this lake.</p>
          )}
          <ChartTable
            caption={`${ac} vs ${bc} by lap`}
            head={
              <tr>
                <th scope="col" className="c-num">Lap</th>
                <th scope="col" className="c-num">{ac}</th>
                <th scope="col" className="c-num">{bc}</th>
                <th scope="col" className="c-num">Delta</th>
                <th scope="col" className="c-num">Gap</th>
                {hasSectors ? (
                  <>
                    <th scope="col" className="c-num">S1 delta</th>
                    <th scope="col" className="c-num">S2 delta</th>
                    <th scope="col" className="c-num">S3 delta</th>
                  </>
                ) : null}
                <th scope="col">Notes</th>
              </tr>
            }
          >
            {rows.map((r) => (
              <tr key={r.lap}>
                <th scope="row" className="c-num">
                  {r.lap}
                </th>
                <td className="c-num">
                  {lapTime(r.a_lap_time_s)} {r.a_lap_time_s !== null ? compoundLetter(r.a_compound) : ""}
                </td>
                <td className="c-num">
                  {lapTime(r.b_lap_time_s)} {r.b_lap_time_s !== null ? compoundLetter(r.b_compound) : ""}
                </td>
                <td className="c-num">{r.delta_s === null ? "—" : signed(r.delta_s)}</td>
                <td className="c-num">{r.gap_s === null ? "—" : signed(r.gap_s)}</td>
                {hasSectors ? (
                  <>
                    <td className="c-num">{r.sector1_delta_s === null ? "—" : signed(r.sector1_delta_s)}</td>
                    <td className="c-num">{r.sector2_delta_s === null ? "—" : signed(r.sector2_delta_s)}</td>
                    <td className="c-num">{r.sector3_delta_s === null ? "—" : signed(r.sector3_delta_s)}</td>
                  </>
                ) : null}
                <td>{notes(r)}</td>
              </tr>
            ))}
          </ChartTable>
        </>
      )}
      </div>
    </section>
  );
}
