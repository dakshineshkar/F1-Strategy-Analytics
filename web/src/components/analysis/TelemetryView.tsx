"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { InfoTip } from "@/components/InfoTip";
import { lapTime } from "@/lib/format";
import { innerX, linear, niceTicks, pathOf } from "@/lib/plot";
import {
  carLabel,
  carStyles,
  crosshairKey,
  gainsAndLosses,
  laneBoxes,
  laneDomain,
  laneValues,
  lapOption,
  nearestIndex,
  onRuns,
  ONLY_2024_NOTE,
  pickLap,
  readoutAt,
  readoutText,
  signedS,
  stepPoints,
  telemetryAvailable,
  telemetryNotes,
  telemetrySummary,
  type CarStyle,
  type LaneBox,
  type TelemetryCompare,
  type TelemetryLaps,
} from "@/lib/telemetry";
import { useTelemetryCompare, useTelemetryLaps } from "@/lib/useTelemetry";
import { useWidth } from "@/lib/useWidth";

import { ChartTable, Notes, type Names } from "./common";

const FRAME = { width: 760, left: 64, right: 60, top: 8, bottom: 30 };

export interface TelemetryPick {
  ta: string | null;
  talap: number | null;
  tb: string | null;
  tblap: number | null;
}

/** One car's picker: driver and lap (the fastest lap is preselected and marked). */
function CarPicker({
  label,
  code,
  lap,
  codes,
  laps,
  error,
  onPick,
}: {
  label: string;
  code: string | null;
  lap: number | null;
  codes: readonly string[];
  laps: TelemetryLaps | null;
  error: string | null;
  onPick: (code: string, lap: number | null) => void;
}) {
  return (
    <fieldset className="telemetry-pick">
      <legend>{label}</legend>
      <label className="inline-field">
        <span>Driver</span>
        <select value={code ?? ""} onChange={(e) => onPick(e.target.value, null)}>
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-field">
        <span>Lap</span>
        <select
          value={lap ?? ""}
          disabled={!laps || laps.rows.length === 0}
          onChange={(e) => code && onPick(code, Number(e.target.value))}
        >
          {(laps?.rows ?? []).map((l) => (
            <option key={l.lap} value={l.lap}>
              {lapOption(l, laps?.fastest_lap ?? null)}
            </option>
          ))}
        </select>
      </label>
      {error !== null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function Swatch({ style }: { style: CarStyle }) {
  return (
    <svg width="28" height="10" aria-hidden="true" className="telemetry-swatch">
      <line x1="1" x2="27" y1="5" y2="5" stroke="var(--border)" strokeWidth={style.width + 2} />
      <line x1="1" x2="27" y1="5" y2="5" stroke={style.colour} strokeWidth={style.width} strokeDasharray={style.dash || undefined} />
    </svg>
  );
}

const fmt = {
  m: (v: number) => `${Math.round(v).toLocaleString("en-GB")} m`,
  s: (v: number) => `${v.toFixed(3)} s`,
  kph: (v: number) => `${v.toFixed(1)} km/h`,
  pct: (v: number) => `${Math.round(v)}%`,
  rpm: (v: number) => `${Math.round(v).toLocaleString("en-GB")}`,
};

/** The seven stacked lanes on one distance axis, with the shared crosshair. */
export function Lanes({
  compare,
  styles,
  index,
  onIndex,
  describedBy,
}: {
  compare: TelemetryCompare;
  styles: { a: CarStyle; b: CarStyle };
  index: number;
  onIndex: (i: number) => void;
  describedBy: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>(FRAME.width);
  const svgRef = useRef<SVGSVGElement>(null);
  const distance = compare.distance_m;
  const length = distance[distance.length - 1] as number;
  const [x0, x1] = innerX({ ...FRAME, width, height: 0 });
  const x = linear([0, length], [x0, x1]);
  const { boxes, bottom } = laneBoxes(FRAME.top);
  const height = bottom + FRAME.bottom;
  const r = readoutAt(compare, index);
  const xTicks = niceTicks(0, length, Math.max(3, Math.floor(width / 110)));

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ((e.clientX - rect.left) * width) / rect.width;
    const d = ((px - x0) / Math.max(1, x1 - x0)) * length;
    onIndex(nearestIndex(distance, d));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = crosshairKey(e.key, e.shiftKey, index, distance);
    if (next === null) return;
    e.preventDefault();
    onIndex(next);
  };

  const lane = (box: LaneBox) => {
    const { lane: l, top, bottom: b } = box;
    const dom = laneDomain(compare, l.id);
    const y = linear(dom, [b, top], true);
    const label = (
      <text x={FRAME.left - 8} y={(top + b) / 2 + 4} textAnchor="end" className="chart-axis">
        {l.label}
      </text>
    );
    if (l.kind === "band") {
      const mid = (top + b) / 2;
      const rows: ["a" | "b", number, number][] = [
        ["a", top, mid - 1],
        ["b", mid + 1, b],
      ];
      return (
        <g key={l.id} className="telemetry-lane">
          {label}
          <rect x={x0} y={top} width={x1 - x0} height={b - top} fill="none" stroke="var(--grid)" strokeWidth={0.5} />
          {rows.map(([car, y0, y1]) =>
            onRuns(distance, laneValues(compare, l.id, car)).map(([s, e]) => (
              <rect
                key={`${car}-${s}`}
                x={x(s)}
                y={y0}
                width={Math.max(1, x(e) - x(s))}
                height={y1 - y0}
                fill={styles[car].colour}
                fillOpacity={car === "a" ? 0.85 : 0.35}
                stroke={car === "b" ? styles.b.colour : "none"}
                strokeDasharray={car === "b" ? "3 2" : undefined}
                strokeWidth={car === "b" ? 1 : 0}
              />
            )),
          )}
        </g>
      );
    }
    const ticks = l.id === "gear" ? [2, 4, 6, 8] : niceTicks(dom[0], dom[1], 3);
    const series = (car: "a" | "b") => {
      const values = laneValues(compare, l.id, car);
      if (l.kind === "step") return pathOf(stepPoints(distance, values), (p) => x(p.d), (p) => y(p.v));
      return pathOf(
        distance.map((d, i) => ({ d, v: values[i] as number })),
        (p) => x(p.d),
        (p) => y(p.v),
      );
    };
    return (
      <g key={l.id} className="telemetry-lane">
        {label}
        {ticks.map((t) => (
          <g key={t} className="chart-grid">
            <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} />
            <text x={x1 + 4} y={y(t) + 4} textAnchor="start">
              {l.id === "delta" ? signedS(t) : t.toLocaleString("en-GB")}
            </text>
          </g>
        ))}
        {l.kind === "delta" ? (
          <>
            <line x1={x0} x2={x1} y1={y(0)} y2={y(0)} stroke="var(--text)" strokeWidth={1} />
            <text x={x0 + 4} y={top + 11} className="chart-axis">
              ↑ A behind
            </text>
            <text x={x0 + 4} y={b - 4} className="chart-axis">
              ↓ A ahead
            </text>
            <path d={series("a")} fill="none" stroke="var(--border)" strokeWidth={3.5} strokeLinejoin="round" />
            <path d={series("a")} fill="none" stroke="var(--text)" strokeWidth={1.75} strokeLinejoin="round" />
          </>
        ) : (
          (["b", "a"] as const).map((car) => (
            <g key={car}>
              <path d={series(car)} fill="none" stroke="var(--border)" strokeWidth={styles[car].width + 1.75} strokeLinejoin="round" />
              <path
                d={series(car)}
                fill="none"
                stroke={styles[car].colour}
                strokeWidth={styles[car].width}
                strokeDasharray={styles[car].dash || undefined}
                strokeLinejoin="round"
              />
            </g>
          ))
        )}
      </g>
    );
  };

  return (
    <div className="chart-box telemetry-chart" ref={ref} style={{ height }}>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Crosshair along the lap"
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(r.distance)}
        aria-valuetext={readoutText(r)}
        aria-describedby={describedBy}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End"
        className="telemetry-crosshair"
        onKeyDown={onKey}
        onPointerDown={fromPointer}
        onPointerMove={(e) => (e.buttons > 0 || e.pointerType === "mouse" ? fromPointer(e) : undefined)}
      >
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="chart">
          {boxes.map(lane)}
          {xTicks.map((t) => (
            <text key={t} className="chart-axis" x={x(t)} y={height - 10} textAnchor="middle">
              {t === 0 ? "0 m" : t.toLocaleString("en-GB")}
            </text>
          ))}
          <line
            x1={x(r.distance)}
            x2={x(r.distance)}
            y1={FRAME.top}
            y2={bottom}
            stroke="var(--text)"
            strokeWidth={1}
            strokeDasharray="2 2"
            className="telemetry-cursor"
          />
        </svg>
      </div>
    </div>
  );
}

/** The readout of every channel for both laps at the crosshair (a real table). */
export function ReadoutTable({ compare, index }: { compare: TelemetryCompare; index: number }) {
  const r = readoutAt(compare, index);
  const rows: [string, string, string][] = [
    ["Lap distance", fmt.m(r.a.ownDistance), fmt.m(r.b.ownDistance)],
    ["Elapsed", fmt.s(r.a.elapsed), fmt.s(r.b.elapsed)],
    ["Speed", fmt.kph(r.a.speed), fmt.kph(r.b.speed)],
    ["Throttle", fmt.pct(r.a.throttle), fmt.pct(r.b.throttle)],
    ["Brake", r.a.brake ? "on" : "off", r.b.brake ? "on" : "off"],
    ["Gear", String(r.a.gear), String(r.b.gear)],
    ["RPM", fmt.rpm(r.a.rpm), fmt.rpm(r.b.rpm)],
    ["DRS", r.a.drs ? "open" : "closed", r.b.drs ? "open" : "closed"],
  ];
  return (
    <div className="telemetry-readout-wrap" role="region" aria-label="Values at the crosshair" tabIndex={0}>
      <table className="tower analysis-table telemetry-readout">
        <caption>Values at {fmt.m(r.distance)} (lap A&apos;s distance)</caption>
        <thead>
          <tr>
            <th scope="col">Channel</th>
            <th scope="col" className="c-num">
              A · {compare.a.driver_code} {compare.a.lap}
            </th>
            <th scope="col" className="c-num">
              B · {compare.b.driver_code} {compare.b.lap}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, a, b]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="c-num">{a}</td>
              <td className="c-num">{b}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Delta (A − B)</th>
            <td className="c-num" colSpan={2}>
              {signedS(r.delta)} {r.delta > 0.0005 ? "(A behind)" : r.delta < -0.0005 ? "(A ahead)" : "(level)"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The "Telemetry" view of the Race analysis tab (display only, Feature 6, 2024 only): two laps
 * overlaid on one distance axis with a delta-time lane. */
export function TelemetryView({
  season,
  round,
  order,
  names,
  pick,
  onPick,
}: {
  season: number;
  round: number;
  order: readonly string[];
  names: Names;
  pick: TelemetryPick;
  onPick: (next: Partial<TelemetryPick>) => void;
}) {
  const id = useId();
  const available = telemetryAvailable(season);
  const codes = useMemo(() => order.map((d) => names.code(d)), [order, names]);
  const idOf = useMemo(() => new Map(order.map((d) => [names.code(d), d])), [order, names]);
  const aCode = available ? (pick.ta ?? codes[0] ?? null) : null;
  const bCode = available ? (pick.tb ?? codes[1] ?? codes[0] ?? null) : null;
  const lapsA = useTelemetryLaps(season, round, aCode);
  const lapsB = useTelemetryLaps(season, round, bCode);
  const aLap = pickLap(lapsA.laps, pick.talap);
  let bLap = pickLap(lapsB.laps, pick.tblap);
  if (aCode !== null && aCode === bCode && bLap === aLap && lapsB.laps) {
    // the same driver: default B to the driver's next lap so the two picks differ
    const other = lapsB.laps.rows.find((l) => l.lap !== aLap);
    bLap = other ? other.lap : bLap;
  }
  const { compare, error } = useTelemetryCompare(
    season,
    round,
    aCode !== null && aLap !== null ? { code: aCode, lap: aLap } : null,
    bCode !== null && bLap !== null ? { code: bCode, lap: bLap } : null,
  );
  const [index, setIndex] = useState(0);
  const teamOf = (code: string | null) => {
    const d = code === null ? undefined : idOf.get(code);
    return d === undefined ? null : names.team(d);
  };
  const styles = carStyles(teamOf(aCode), teamOf(bCode));
  const k = compare ? Math.min(index, compare.distance_m.length - 1) : 0;

  const head = (
    <div className="panel-head">
      <h2 id={`${id}-h`}>
        Telemetry: two laps overlaid <InfoTip id="teldelta" />
      </h2>
    </div>
  );
  if (!available) {
    return (
      <section aria-labelledby={`${id}-h`} className="analysis-view">
        {head}
        <p className="panel-note telemetry-only" role="note">
          {ONLY_2024_NOTE}
        </p>
      </section>
    );
  }

  const same = aCode !== null && aCode === bCode && aLap === bLap;
  const summary = compare ? telemetrySummary(compare) : [];
  const { gains, losses } = compare ? gainsAndLosses(compare.segments, 25) : { gains: [], losses: [] };

  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      {head}
      <div className="telemetry-picks">
        <CarPicker
          label="Lap A (solid line)"
          code={aCode}
          lap={aLap}
          codes={codes}
          laps={lapsA.laps}
          error={lapsA.error}
          onPick={(c, l) => onPick({ ta: c, talap: l })}
        />
        <CarPicker
          label="Lap B (dashed line)"
          code={bCode}
          lap={bLap}
          codes={codes}
          laps={lapsB.laps}
          error={lapsB.error}
          onPick={(c, l) => onPick({ tb: c, tblap: l })}
        />
        <button
          type="button"
          className="btn-small"
          disabled={aCode === null || bCode === null}
          onClick={() => onPick({ ta: bCode, talap: bLap, tb: aCode, tblap: aLap })}
        >
          Swap A and B
        </button>
      </div>
      {same ? (
        <p className="error" role="alert">
          Pick two different laps.
        </p>
      ) : error !== null ? (
        <p className="error" role="alert">
          Could not compare: {error}
        </p>
      ) : compare === null ? (
        <p className="muted" aria-live="polite">
          {lapsA.error !== null || lapsB.error !== null ? "No telemetry to compare." : "Loading the telemetry…"}
        </p>
      ) : (
        <>
          <Notes notes={telemetryNotes(compare)} />
          <ul className="telemetry-summary" id={`${id}-sum`} aria-live="polite">
            {summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="telemetry-legend">
            <span>
              <Swatch style={styles.a} /> A: {carLabel(compare.a)}
              {compare.a.summary.lap_time_s !== null ? ` (${lapTime(compare.a.summary.lap_time_s)})` : ""}
            </span>{" "}
            <span>
              <Swatch style={styles.b} /> B: {carLabel(compare.b)}
              {compare.b.summary.lap_time_s !== null ? ` (${lapTime(compare.b.summary.lap_time_s)})` : ""}
            </span>
            <span className="muted">
              {" "}
              Team colours; A solid, B dashed{styles.sameColour ? " (same colour: tell them apart by the line style)" : ""}.
              In the brake and DRS lanes A is the upper, filled row and B the lower, outlined row.{" "}
              <InfoTip id="telgrid" />
            </span>
          </p>
          <p className="panel-note">
            Move the crosshair with the pointer, or focus the chart and use the arrow keys (5 m; with Shift 50 m),
            Page Up / Page Down (250 m), Home and End.
          </p>
          <Lanes compare={compare} styles={styles} index={k} onIndex={setIndex} describedBy={`${id}-sum`} />
          <ReadoutTable compare={compare} index={k} />
          <ChartTable
            caption={`Mini-sectors: how the delta (A − B) changes over each 1/${compare.segments.length} of the lap`}
            head={
              <tr>
                <th scope="col" className="c-num">#</th>
                <th scope="col" className="c-num">From</th>
                <th scope="col" className="c-num">To</th>
                <th scope="col" className="c-num">Change</th>
                <th scope="col">Meaning</th>
              </tr>
            }
          >
            {compare.segments.map((s) => (
              <tr key={s.index}>
                <td className="c-num">{s.index + 1}</td>
                <td className="c-num">{fmt.m(s.start_m)}</td>
                <td className="c-num">{fmt.m(s.end_m)}</td>
                <td className="c-num">{signedS(s.delta_change_s)}</td>
                <td>
                  {gains.includes(s) ? `A gains` : losses.includes(s) ? `A loses` : "level"}
                </td>
              </tr>
            ))}
          </ChartTable>
        </>
      )}
    </section>
  );
}
