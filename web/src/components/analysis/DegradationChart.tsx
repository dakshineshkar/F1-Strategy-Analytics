"use client";

import { useId } from "react";

import { InfoTip } from "@/components/InfoTip";
import {
  compoundName,
  EXCLUSION_TEXT,
  lapList,
  slopeText,
  type Coverage,
  type Degradation,
} from "@/lib/analysis";
import { lapTime } from "@/lib/format";
import { innerX, innerY, linear, niceTicks } from "@/lib/plot";
import { useWidth } from "@/lib/useWidth";

import { ChartTable, CompoundMark, CompoundTag, type Names } from "./common";

const BASE = { width: 760, height: 320, left: 60, right: 150, top: 16, bottom: 34 };
const FIT_DASHES = ["", "6 4", "2 3", "10 3 2 3"];

/** The fit's status in words. */
export function fitText(s: Degradation["stints"][number]): string {
  if (s.fit && s.status === "ok") return `${slopeText(s.fit.slope)} over ${s.nQuick} quick laps`;
  if (s.status === "no_tyre_life") return "no fit: tyre life unknown";
  return `no fit: ${s.nQuick} quick lap${s.nQuick === 1 ? "" : "s"} (at least 5 needed)`;
}

/** Lap time against tyre life on the chosen driver's quick laps, per stint, with the stored
 * straight-line fit and its slope as text. A lap-time proxy, not tyre wear. */
export function DegradationChart({
  deg,
  driver,
  order,
  onDriver,
  coverage,
  names,
}: {
  deg: Degradation;
  driver: string;
  order: readonly string[];
  onDriver: (id: string) => void;
  coverage: Coverage;
  names: Names;
}) {
  const id = useId();
  const { ref, width } = useWidth<HTMLDivElement>(BASE.width);
  const frame = { ...BASE, width };
  const pts = deg.stints.flatMap((s) => s.points);
  const lives = pts.map((p) => p.life);
  const times = pts.map((p) => p.time);
  const x = linear([Math.min(0, ...lives), Math.max(5, ...lives) + 1], innerX(frame));
  const [yTop, yBottom] = innerY(frame);
  const yLo = times.length ? Math.floor(Math.min(...times) - 0.3) : 0;
  const yHi = times.length ? Math.ceil(Math.max(...times) + 0.3) : 1;
  const y = linear([yLo, yHi], [yBottom, yTop], true);
  const yTicks = niceTicks(yLo, yHi, 5);
  const xTicks = niceTicks(0, Math.max(5, ...lives) + 1, 6);

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <div className="panel-head">
        <h2 id={`${id}-h`}>
          Tyre degradation <span className="muted">(lap-time proxy)</span> <InfoTip id="degslope" />
        </h2>
        <label className="inline-field">
          <span>Driver</span>
          <select value={driver} onChange={(e) => onDriver(e.target.value)}>
            {order.map((d) => (
              <option key={d} value={d}>
                {names.code(d)} · {names.name(d)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="panel-note">
        <strong>A lap-time proxy, not tyre wear:</strong> fuel burn-off and track evolution are in the slope too. Only
        quick laps are plotted <InfoTip id="quicklap" align="end" />.
        {coverage.is_synthetic ? <strong className="synthetic-tag"> SYNTHETIC tyre life: not real tyre data.</strong> : null}
      </p>
      <div className="chart-box" ref={ref} style={{ height: BASE.height }}>
        <svg viewBox={`0 0 ${width} ${BASE.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="chart">
          <title id={`${id}-t`}>{`Lap time against tyre life, ${names.code(driver)}`}</title>
          <desc id={`${id}-d`}>
            {deg.stints.map((s) => `Stint ${s.stint} ${compoundName(s.compound)}: ${fitText(s)}.`).join(" ") ||
              "No stints for this driver."}
          </desc>
          {yTicks.map((t) => (
            <g key={t} className="chart-grid">
              <line x1={BASE.left} x2={width - BASE.right} y1={y(t)} y2={y(t)} />
              <text x={BASE.left - 6} y={y(t) + 4} textAnchor="end">
                {lapTime(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="chart-axis" x={x(t)} y={BASE.height - 16} textAnchor="middle">
              {t}
            </text>
          ))}
          <text className="chart-axis" x={(BASE.left + width - BASE.right) / 2} y={BASE.height - 2} textAnchor="middle">
            tyre life (laps on the set)
          </text>
          {deg.stints.map((s, i) => (
            <g key={s.stint}>
              {s.points.map((p) => (
                <CompoundMark key={p.lap} compound={s.compound} x={x(p.life)} y={y(p.time)} r={3.5} />
              ))}
              {s.fit ? (
                <g>
                  <line
                    x1={x(s.fit.x0)}
                    x2={x(s.fit.x1)}
                    y1={y(s.fit.intercept + s.fit.slope * s.fit.x0)}
                    y2={y(s.fit.intercept + s.fit.slope * s.fit.x1)}
                    stroke="var(--text)"
                    strokeWidth={1.75}
                    strokeDasharray={FIT_DASHES[i % FIT_DASHES.length] || undefined}
                  />
                  <text
                    x={width - BASE.right + 6}
                    y={y(s.fit.intercept + s.fit.slope * s.fit.x1) + 4}
                    className="chart-label"
                    fill="var(--text)"
                  >
                    S{s.stint} {compoundName(s.compound)} {slopeText(s.fit.slope)}
                  </text>
                </g>
              ) : null}
            </g>
          ))}
        </svg>
      </div>
      <ul className="analysis-list">
        {deg.stints.map((s) => (
          <li key={s.stint}>
            Stint {s.stint} · <CompoundTag compound={s.compound} /> · {fitText(s)}
          </li>
        ))}
      </ul>
      <p className="panel-note">
        Excluded laps:{" "}
        {deg.excluded.length === 0
          ? "none"
          : deg.excluded.map((e) => `${EXCLUSION_TEXT[e.reason]}: ${lapList(e.laps)}`).join("; ")}
        .
      </p>
      <ChartTable
        caption={`Quick laps of ${names.code(driver)}`}
        head={
          <tr>
            <th scope="col">Stint</th>
            <th scope="col" className="c-num">Lap</th>
            <th scope="col" className="c-num">Tyre life</th>
            <th scope="col" className="c-num">Lap time</th>
          </tr>
        }
      >
        {deg.stints.flatMap((s) =>
          s.points.map((p) => (
            <tr key={`${s.stint}-${p.lap}`}>
              <td>
                {s.stint} · {compoundName(s.compound)}
              </td>
              <td className="c-num">{p.lap}</td>
              <td className="c-num">{p.life}</td>
              <td className="c-num">{lapTime(p.time)}</td>
            </tr>
          )),
        )}
      </ChartTable>
    </section>
  );
}
