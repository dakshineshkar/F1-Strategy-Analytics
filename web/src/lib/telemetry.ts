/** Display-only telemetry lap overlay (Feature 6, 2024 only): API types and guards, the stacked
 * lanes' shaping, the crosshair maths and the text summary. Pure and unit-tested; the view is
 * ``components/analysis/TelemetryView.tsx``. Types mirror ``src/f1sa/api/models.py``.
 *
 * ``delta_s`` is elapsed time of lap A minus lap B at the same point of the lap (B read at the same
 * fraction of its own lap): positive = A behind there, negative = A ahead. Where it rises A loses
 * time; where it falls A gains. */

import { lapTime } from "./format";
import { isBool, isDriverId, isFiniteNumber, isInt, isObj, isStr } from "./guard";
import { dark, deltaE, light } from "./theme";

export const TELEMETRY_SEASON = 2024;
export const ONLY_2024_NOTE =
  "Telemetry traces are available for 2024 races only: the lake keeps raw telemetry samples for 2024 only.";
export const telemetryAvailable = (season: number): boolean => season === TELEMETRY_SEASON;

// ------------------------------------------------------------------ types
export interface TelemetryLap {
  lap: number;
  lap_time_s: number | null;
  trace_time_s: number;
  lap_length_m: number;
  n_samples: number;
  max_gap_s: number;
  coverage: "full" | "partial";
  is_pit_in_lap: boolean | null;
  is_pit_out_lap: boolean | null;
  is_deleted: boolean | null;
  is_neutralised_lap: boolean | null;
  is_red_flag_lap: boolean | null;
  compound: string | null;
  tyre_life_laps: number | null;
  top_speed_kph: number | null;
  top_speed_at_m: number | null;
  min_corner_speed_kph: number | null;
  min_corner_at_m: number | null;
  full_throttle_share: number | null;
  brake_share: number;
  drs_share: number;
  n_braking_zones: number;
}

export interface TelemetryLaps {
  season: number;
  round: number;
  driver_id: string;
  driver_code: string;
  is_synthetic: boolean;
  source: "tracinginsights" | "synthetic";
  grid_step_m: number;
  fastest_lap: number | null;
  rows: TelemetryLap[];
}

export interface TelemetryCar {
  driver_id: string;
  driver_code: string;
  lap: number;
  summary: TelemetryLap;
  own_distance_m: number[];
  elapsed_s: number[];
  speed_kph: number[];
  throttle_pct: number[];
  rpm: number[];
  brake: number[];
  n_gear: number[];
  drs: number[];
  braking_start_m: number[];
  braking_end_m: number[];
  braking_apex_kph: number[];
}

export interface TelemetrySegment {
  index: number;
  start_m: number;
  end_m: number;
  delta_change_s: number;
}

export interface TelemetryCompare {
  season: number;
  round: number;
  is_synthetic: boolean;
  grid_step_m: number;
  distance_m: number[];
  a: TelemetryCar;
  b: TelemetryCar;
  delta_s: number[];
  segments: TelemetrySegment[];
  final_delta_s: number;
  lap_time_delta_s: number | null;
}

// ------------------------------------------------------------------ guards
type Check = (v: unknown) => boolean;
const opt =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);
const num: Check = isFiniteNumber;
const nonNegInt: Check = (v) => isInt(v) && v >= 0;
const posInt: Check = (v) => isInt(v) && v >= 1;
const share: Check = (v) => isFiniteNumber(v) && v >= 0 && v <= 1;
const isCode: Check = (v) => isStr(v) && /^[A-Z]{3}$/.test(v);
const nums: Check = (v) => Array.isArray(v) && v.every(isFiniteNumber);
const ints: Check = (v) => Array.isArray(v) && v.every(isInt);
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    isStr(v) && values.includes(v);

function shape<T>(spec: Record<keyof T & string, Check>): (v: unknown) => T | undefined {
  const keys = Object.keys(spec) as (keyof T & string)[];
  return (v) => {
    if (!isObj(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (!(k in v) || !spec[k](v[k])) return undefined;
      out[k] = v[k];
    }
    return out as T;
  };
}

export const toTelemetryLap = shape<TelemetryLap>({
  lap: posInt,
  lap_time_s: opt(num),
  trace_time_s: num,
  lap_length_m: num,
  n_samples: nonNegInt,
  max_gap_s: num,
  coverage: oneOf(["full", "partial"]),
  is_pit_in_lap: opt(isBool),
  is_pit_out_lap: opt(isBool),
  is_deleted: opt(isBool),
  is_neutralised_lap: opt(isBool),
  is_red_flag_lap: opt(isBool),
  compound: opt(isStr),
  tyre_life_laps: opt(isInt),
  top_speed_kph: opt(num),
  top_speed_at_m: opt(num),
  min_corner_speed_kph: opt(num),
  min_corner_at_m: opt(num),
  full_throttle_share: opt(share),
  brake_share: share,
  drs_share: share,
  n_braking_zones: nonNegInt,
});

const META = {
  season: isInt,
  round: isInt,
  driver_id: isDriverId,
  driver_code: isCode,
  is_synthetic: isBool,
  source: oneOf(["tracinginsights", "synthetic"]),
  grid_step_m: num,
};

export function toTelemetryLaps(v: unknown): TelemetryLaps | undefined {
  const head = shape<Omit<TelemetryLaps, "rows"> & { rows: unknown }>({
    ...META,
    fastest_lap: opt(posInt),
    rows: Array.isArray,
  })(v);
  if (!head || !Array.isArray(head.rows)) return undefined;
  const rows = head.rows.map(toTelemetryLap);
  if (rows.some((r) => r === undefined)) return undefined;
  return { ...head, rows: rows as TelemetryLap[] };
}

const LANE_ARRAYS = ["own_distance_m", "elapsed_s", "speed_kph", "throttle_pct", "rpm", "brake", "n_gear", "drs"] as const;

function toCar(v: unknown, n: number): TelemetryCar | undefined {
  const car = shape<Omit<TelemetryCar, "summary"> & { summary: unknown }>({
    driver_id: isDriverId,
    driver_code: isCode,
    lap: posInt,
    summary: isObj,
    own_distance_m: nums,
    elapsed_s: nums,
    speed_kph: nums,
    throttle_pct: nums,
    rpm: nums,
    brake: ints,
    n_gear: ints,
    drs: ints,
    braking_start_m: nums,
    braking_end_m: nums,
    braking_apex_kph: nums,
  })(v);
  if (!car) return undefined;
  const summary = toTelemetryLap(car.summary);
  if (!summary || LANE_ARRAYS.some((k) => car[k].length !== n)) return undefined;
  return { ...car, summary };
}

export function toTelemetryCompare(v: unknown): TelemetryCompare | undefined {
  const head = shape<Omit<TelemetryCompare, "a" | "b" | "segments"> & { a: unknown; b: unknown; segments: unknown }>({
    season: isInt,
    round: isInt,
    is_synthetic: isBool,
    grid_step_m: num,
    distance_m: nums,
    a: isObj,
    b: isObj,
    delta_s: nums,
    segments: Array.isArray,
    final_delta_s: num,
    lap_time_delta_s: opt(num),
  })(v);
  if (!head || !Array.isArray(head.segments)) return undefined;
  const n = head.distance_m.length;
  if (n < 2 || head.delta_s.length !== n) return undefined;
  const a = toCar(head.a, n);
  const b = toCar(head.b, n);
  const segments = head.segments.map(
    shape<TelemetrySegment>({ index: nonNegInt, start_m: num, end_m: num, delta_change_s: num }),
  );
  if (!a || !b || segments.some((s) => s === undefined)) return undefined;
  return { ...head, a, b, segments: segments as TelemetrySegment[] };
}

// ------------------------------------------------------------------ lanes
export type LaneId = "speed" | "throttle" | "brake" | "gear" | "rpm" | "drs" | "delta";
export type LaneKind = "line" | "band" | "step" | "delta";

export interface Lane {
  id: LaneId;
  label: string;
  unit: string;
  kind: LaneKind;
  height: number;
}

/** Top to bottom; every lane shares one distance axis and one crosshair. */
export const LANES: readonly Lane[] = [
  { id: "speed", label: "Speed", unit: "km/h", kind: "line", height: 150 },
  { id: "throttle", label: "Throttle", unit: "%", kind: "line", height: 76 },
  { id: "brake", label: "Brake", unit: "on/off", kind: "band", height: 40 },
  { id: "gear", label: "Gear", unit: "", kind: "step", height: 76 },
  { id: "rpm", label: "RPM", unit: "rpm", kind: "line", height: 76 },
  { id: "drs", label: "DRS", unit: "open/closed", kind: "band", height: 40 },
  { id: "delta", label: "Delta", unit: "s", kind: "delta", height: 110 },
];
export const LANE_GAP = 12;

export interface LaneBox {
  lane: Lane;
  top: number;
  bottom: number;
}

/** Each lane's vertical position, starting at ``top`` with ``LANE_GAP`` between lanes. */
export function laneBoxes(top: number, lanes: readonly Lane[] = LANES): { boxes: LaneBox[]; bottom: number } {
  let y = top;
  const boxes = lanes.map((lane) => {
    const box = { lane, top: y, bottom: y + lane.height };
    y += lane.height + LANE_GAP;
    return box;
  });
  return { boxes, bottom: y - LANE_GAP };
}

type Car = "a" | "b";
const CHANNEL: Record<Exclude<LaneId, "delta">, keyof TelemetryCar> = {
  speed: "speed_kph",
  throttle: "throttle_pct",
  brake: "brake",
  gear: "n_gear",
  rpm: "rpm",
  drs: "drs",
};

/** The values one car plots in a lane (the delta lane has one series, shared). */
export function laneValues(c: TelemetryCompare, lane: LaneId, car: Car): number[] {
  if (lane === "delta") return c.delta_s;
  return c[car][CHANNEL[lane]] as number[];
}

const finiteMax = (v: readonly number[]) => v.reduce((m, x) => (x > m ? x : m), -Infinity);
const finiteMin = (v: readonly number[]) => v.reduce((m, x) => (x < m ? x : m), Infinity);

/** The y domain of a lane: speed 0 to the top speed (+5%, rounded up to 20 km/h), throttle 0-100,
 * on/off bands 0-1, gear 0.5-8.5, RPM rounded to 1,000, delta symmetric around 0 (at least ±0.1 s). */
export function laneDomain(c: TelemetryCompare, lane: LaneId): [number, number] {
  switch (lane) {
    case "speed": {
      const hi = Math.max(finiteMax(c.a.speed_kph), finiteMax(c.b.speed_kph), 20);
      return [0, Math.ceil((hi * 1.05) / 20) * 20];
    }
    case "throttle":
      return [0, 100];
    case "brake":
    case "drs":
      return [0, 1];
    case "gear":
      return [0.5, 8.5];
    case "rpm": {
      const lo = Math.min(finiteMin(c.a.rpm), finiteMin(c.b.rpm));
      const hi = Math.max(finiteMax(c.a.rpm), finiteMax(c.b.rpm));
      const l = Number.isFinite(lo) ? Math.floor(lo / 1000) * 1000 : 0;
      const h = Number.isFinite(hi) ? Math.ceil(hi / 1000) * 1000 : 13000;
      return h > l ? [l, h] : [l, l + 1000];
    }
    case "delta": {
      const m = Math.max(0.1, ...c.delta_s.map(Math.abs));
      return [-m, m];
    }
  }
}

/** ``[start, end)`` runs where an on/off channel is on, in distance (each run ends at the next point). */
export function onRuns(distance: readonly number[], on: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < distance.length; i++) {
    const d = distance[i] as number;
    if (on[i] && start === null) start = d;
    if (!on[i] && start !== null) {
      runs.push([start, d]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, distance[distance.length - 1] as number]);
  return runs;
}

/** Points of a step line (hold each value until the next point). */
export function stepPoints(distance: readonly number[], values: readonly number[]): { d: number; v: number }[] {
  const out: { d: number; v: number }[] = [];
  for (let i = 0; i < distance.length; i++) {
    const v = values[i] as number;
    if (i > 0) out.push({ d: distance[i] as number, v: values[i - 1] as number });
    out.push({ d: distance[i] as number, v });
  }
  return out;
}

// ------------------------------------------------------------------ crosshair
/** The index of the point nearest to distance ``d`` (binary search on the increasing axis). */
export function nearestIndex(distance: readonly number[], d: number): number {
  const n = distance.length;
  if (n === 0) return 0;
  if (!(d > (distance[0] as number))) return 0;
  if (d >= (distance[n - 1] as number)) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((distance[mid] as number) <= d) lo = mid;
    else hi = mid;
  }
  return d - (distance[lo] as number) <= (distance[hi] as number) - d ? lo : hi;
}

/** The crosshair index after a key press (null for other keys): arrows ±5 m, Shift+arrows ±50 m,
 * PageUp/PageDown ±250 m, Home/End the start and the finish line. */
export function crosshairKey(key: string, shift: boolean, index: number, distance: readonly number[]): number | null {
  const n = distance.length;
  if (n === 0) return null;
  const here = distance[Math.min(Math.max(index, 0), n - 1)] as number;
  const move = (m: number) => nearestIndex(distance, here + m);
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return move(shift ? 50 : 5);
    case "ArrowLeft":
    case "ArrowDown":
      return move(shift ? -50 : -5);
    case "PageUp":
      return move(250);
    case "PageDown":
      return move(-250);
    case "Home":
      return 0;
    case "End":
      return n - 1;
    default:
      return null;
  }
}

export interface CarReadout {
  code: string;
  lap: number;
  ownDistance: number;
  elapsed: number;
  speed: number;
  throttle: number;
  brake: boolean;
  gear: number;
  rpm: number;
  drs: boolean;
}

export interface Readout {
  index: number;
  distance: number;
  delta: number;
  a: CarReadout;
  b: CarReadout;
}

function carAt(car: TelemetryCar, i: number): CarReadout {
  return {
    code: car.driver_code,
    lap: car.lap,
    ownDistance: car.own_distance_m[i] as number,
    elapsed: car.elapsed_s[i] as number,
    speed: car.speed_kph[i] as number,
    throttle: car.throttle_pct[i] as number,
    brake: (car.brake[i] as number) > 0,
    gear: car.n_gear[i] as number,
    rpm: car.rpm[i] as number,
    drs: (car.drs[i] as number) > 0,
  };
}

/** Every value of both cars at crosshair index ``i`` (clamped to the axis). */
export function readoutAt(c: TelemetryCompare, i: number): Readout {
  const k = Math.min(Math.max(Math.round(i), 0), c.distance_m.length - 1);
  return { index: k, distance: c.distance_m[k] as number, delta: c.delta_s[k] as number, a: carAt(c.a, k), b: carAt(c.b, k) };
}

// ------------------------------------------------------------------ text
const metres = (m: number) => `${Math.round(m).toLocaleString("en-GB")} m`;
const kph = (v: number) => `${v.toFixed(1)} km/h`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Seconds with an explicit sign (U+2212 minus), 3 decimals; ``±0.000`` for zero. */
export function signedS(s: number): string {
  const v = Math.round(s * 1000) / 1000;
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(3)} s`;
}

/** The readout's accessible text (the crosshair slider's ``aria-valuetext``). */
export function readoutText(r: Readout): string {
  return `${metres(r.distance)}: ${r.a.code} ${kph(r.a.speed)}, ${r.b.code} ${kph(r.b.speed)}, delta ${signedS(r.delta)}`;
}

/** The ``n`` mini-sectors where A gains most (most negative change) and loses most (most positive),
 * ignoring changes smaller than 1 ms. */
export function gainsAndLosses(segments: readonly TelemetrySegment[], n = 3) {
  const gains = segments.filter((s) => s.delta_change_s <= -0.001).sort((x, y) => x.delta_change_s - y.delta_change_s);
  const losses = segments.filter((s) => s.delta_change_s >= 0.001).sort((x, y) => y.delta_change_s - x.delta_change_s);
  return { gains: gains.slice(0, n), losses: losses.slice(0, n) };
}

const range = (s: TelemetrySegment) =>
  `${Math.round(s.start_m).toLocaleString("en-GB")}–${Math.round(s.end_m).toLocaleString("en-GB")} m (${signedS(s.delta_change_s)})`;

/** A short label of a lap: "VER lap 12". */
export const carLabel = (car: { driver_code: string; lap: number }): string => `${car.driver_code} lap ${car.lap}`;

/** The text summary: lap times, top speeds, minimum corner speeds, full-throttle shares, where A
 * gains and loses time, and the delta at the line. One sentence per entry. */
export function telemetrySummary(c: TelemetryCompare): string[] {
  const A = carLabel(c.a);
  const B = carLabel(c.b);
  const sa = c.a.summary;
  const sb = c.b.summary;
  const out: string[] = [];
  const lt = (s: TelemetryLap) => (s.lap_time_s === null ? "no official lap time" : lapTime(s.lap_time_s));
  out.push(
    `Lap times: ${A} ${lt(sa)}, ${B} ${lt(sb)}${c.lap_time_delta_s === null ? "" : ` (${A} ${signedS(c.lap_time_delta_s)})`}.`,
  );
  if (sa.top_speed_kph !== null && sb.top_speed_kph !== null)
    out.push(
      `Top speed: ${A} ${kph(sa.top_speed_kph)}${sa.top_speed_at_m === null ? "" : ` at ${metres(sa.top_speed_at_m)}`}, ` +
        `${B} ${kph(sb.top_speed_kph)}${sb.top_speed_at_m === null ? "" : ` at ${metres(sb.top_speed_at_m)}`}.`,
    );
  if (sa.min_corner_speed_kph !== null && sb.min_corner_speed_kph !== null)
    out.push(`Slowest corner: ${A} ${kph(sa.min_corner_speed_kph)}, ${B} ${kph(sb.min_corner_speed_kph)}.`);
  if (sa.full_throttle_share !== null && sb.full_throttle_share !== null)
    out.push(`Full throttle: ${A} ${pct(sa.full_throttle_share)} of the lap, ${B} ${pct(sb.full_throttle_share)}.`);
  const { gains, losses } = gainsAndLosses(c.segments);
  out.push(gains.length ? `${A} gains most at ${gains.map(range).join(", ")}.` : `${A} gains time in no mini-sector.`);
  out.push(losses.length ? `${A} loses most at ${losses.map(range).join(", ")}.` : `${A} loses time in no mini-sector.`);
  const f = c.final_delta_s;
  out.push(
    Math.abs(f) < 0.0005
      ? "At the line they are level."
      : `At the line ${A} is ${Math.abs(f).toFixed(3)} s ${f > 0 ? "behind" : "ahead"}.`,
  );
  return out;
}

/** Notes shown above the chart: SYNTHETIC data, partial traces, pit or lap-1 laps. */
export function telemetryNotes(c: TelemetryCompare): string[] {
  const notes: string[] = [];
  if (c.is_synthetic) notes.push("SYNTHETIC: these traces come from a generated test fixture, not real telemetry.");
  for (const car of [c.a, c.b]) {
    const s = car.summary;
    const label = carLabel(car);
    if (s.coverage === "partial") notes.push(`${label} has gaps in its telemetry (a sample gap over 2 s, or a short trace).`);
    if (s.is_pit_in_lap || s.is_pit_out_lap) notes.push(`${label} is a pit lap: its slowest speeds are in the pit lane.`);
    if (car.lap === 1) notes.push(`${label} starts from the grid slot, so its distance axis is offset from a flying lap.`);
  }
  return notes;
}

// ------------------------------------------------------------------ picking
/** A lap option label: "12 · 1:37.810 (fastest)", with pit / deleted / partial marks. */
export function lapOption(l: TelemetryLap, fastest: number | null): string {
  const marks = [
    l.lap === fastest ? "fastest" : null,
    l.is_pit_in_lap ? "pit in" : null,
    l.is_pit_out_lap ? "pit out" : null,
    l.is_deleted ? "deleted" : null,
    l.coverage === "partial" ? "gaps" : null,
  ].filter((m): m is string => m !== null);
  const time = l.lap_time_s === null ? "no time" : lapTime(l.lap_time_s);
  return `${l.lap} · ${time}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

/** The lap to show: the chosen one when the driver has it, else the fastest, else the first. */
export function pickLap(laps: TelemetryLaps | null, chosen: number | null): number | null {
  if (!laps || laps.rows.length === 0) return null;
  if (chosen !== null && laps.rows.some((r) => r.lap === chosen)) return chosen;
  return laps.fastest_lap ?? (laps.rows[0] as TelemetryLap).lap;
}

export interface CarStyle {
  colour: string;
  dash: string;
  width: number;
  /** true when the car has no team colour and is drawn in the neutral text ink */
  neutral: boolean;
}

/** The neutral stroke of a car without a team colour: text ink, never a chart-line colour next to a team colour.
 * Measured against the 35 served team colours (2021–2024, ΔE OKLab × 100): text is under 15 from one of them in
 * dark (#ffffff, 5.5) and from none in light, where the grid neutral is under 15 from nine (DESIGN.md, Step 4B). */
export const NEUTRAL_STROKE = "var(--text)";
/** The dataviz floors between two series (ΔE, OKLab × 100): 15 with normal vision, 8 under protanopia or
 * deuteranopia. */
export const CLOSE_DELTA_E = 15;
export const CLOSE_DELTA_E_CVD = 8;

const HEX = /^#[0-9a-f]{6}$/i;

/** True when two strokes are hard to tell apart by colour in either theme: the same value, both neutral, or two
 * colours (a team colour, or the neutral ink of each theme) under ``CLOSE_DELTA_E`` apart with normal vision or
 * under ``CLOSE_DELTA_E_CVD`` with protanopia or deuteranopia. */
export function strokesClose(a: string, b: string): boolean {
  if (a === b) return true;
  const options = (c: string): string[] => (c === NEUTRAL_STROKE ? [dark.text, light.text] : HEX.test(c) ? [c] : []);
  const pa = options(a);
  const pb = options(b);
  if (pa.length === 0 || pb.length === 0) return false;
  // the same theme for both strokes: dark text against dark, light against light (a hex is the same in both)
  const pairs: [string, string][] =
    pa.length === 2 && pb.length === 2
      ? [[pa[0] as string, pb[0] as string], [pa[1] as string, pb[1] as string]]
      : pa.flatMap((x) => pb.map((y) => [x, y] as [string, string]));
  return pairs.some(
    ([x, y]) =>
      deltaE(x, y) < CLOSE_DELTA_E || deltaE(x, y, "protan") < CLOSE_DELTA_E_CVD || deltaE(x, y, "deutan") < CLOSE_DELTA_E_CVD,
  );
}

/** A is solid and B dashed (and thinner) whatever their colours, so teammates or the same driver on two laps stay
 * distinguishable. The colours are the team colours; a car without one is the neutral text ink (never
 * ``--line-0`` / ``--line-1``, which would sit next to the other car's team colour). ``closeColours`` says when the
 * line style, not the colour, tells them apart. */
export function carStyles(
  aTeam: { colour: string } | null,
  bTeam: { colour: string } | null,
): { a: CarStyle; b: CarStyle; closeColours: boolean } {
  const a = aTeam?.colour ?? NEUTRAL_STROKE;
  const b = bTeam?.colour ?? NEUTRAL_STROKE;
  return {
    a: { colour: a, dash: "", width: 2, neutral: aTeam === null },
    b: { colour: b, dash: "6 4", width: 1.75, neutral: bTeam === null },
    closeColours: strokesClose(a, b),
  };
}
