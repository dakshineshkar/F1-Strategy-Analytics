/** Post-race analysis (Feature 2, display only): types and runtime guards of the
 * ``/api/races/{s}/{r}/analysis/*`` responses (mirroring ``src/f1sa/api/models.py``), and the pure
 * data shaping behind every chart of the "Race analysis" tab (unit-tested). One bad row rejects
 * the whole response, as for the entrants. */

import { isBool, isDriverId, isFiniteNumber, isInt, isObj, isStr } from "./guard";
import { median } from "./plot";

// ------------------------------------------------------------------ types
export const KNOWN_COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"] as const;
export type KnownCompound = (typeof KNOWN_COMPOUNDS)[number];
export const TYRE_SOURCES = ["tracinginsights", "synthetic", "none"] as const;
export const QUICK_LAP_EXCLUSIONS = ["no_time", "lap_1", "pit_in", "pit_out", "neutralised", "deleted", "slow_107"] as const;
export type QuickLapExclusion = (typeof QUICK_LAP_EXCLUSIONS)[number];
export const RC_KINDS = [
  "sc_deployed",
  "sc_ending",
  "vsc_deployed",
  "vsc_ending",
  "red_flag",
  "penalty",
  "investigation",
  "track_limits",
  "chequered",
  "other",
] as const;
export type RaceControlKind = (typeof RC_KINDS)[number];

export interface Coverage {
  n_drivers: number;
  n_laps: number;
  n_lap_rows: number;
  tyre_source: (typeof TYRE_SOURCES)[number];
  is_synthetic: boolean;
  has_sectors: boolean;
  has_speed_traps: boolean;
  deleted_known: boolean;
  neutralised_source: "track_status" | "heuristic" | "mixed";
  n_race_control: number;
  n_pitstops: number;
  n_quick_laps: number;
  n_ti_only_laps_dropped: number;
}

export interface AnalysisLap {
  driver_id: string;
  driver_code: string | null;
  lap: number;
  position: number | null;
  lap_time_s: number | null;
  cumulative_time_s: number | null;
  gap_to_leader_s: number | null;
  sector1_s: number | null;
  sector2_s: number | null;
  sector3_s: number | null;
  speed_i1_kph: number | null;
  speed_i2_kph: number | null;
  speed_fl_kph: number | null;
  speed_st_kph: number | null;
  stint: number | null;
  compound: KnownCompound | null;
  tyre_life_laps: number | null;
  compound_source: (typeof TYRE_SOURCES)[number];
  is_synthetic: boolean;
  is_pit_in_lap: boolean | null;
  is_pit_out_lap: boolean | null;
  is_deleted: boolean | null;
  deleted_reason: string | null;
  track_status: string | null;
  is_sc_lap: boolean | null;
  is_vsc_lap: boolean | null;
  is_red_flag_lap: boolean | null;
  is_neutralised_lap: boolean | null;
  neutralised_source: "track_status" | "heuristic";
  is_quick_lap: boolean;
  quick_lap_exclusion: QuickLapExclusion | null;
}

export interface Stint {
  driver_id: string;
  driver_code: string | null;
  stint: number;
  compound: KnownCompound | null;
  start_lap: number;
  end_lap: number;
  laps: number;
  tyre_life_start: number | null;
  tyre_life_end: number | null;
  used_set: boolean | null;
  ends_in_pit: boolean;
  n_quick_laps: number;
  deg_slope_s_per_lap: number | null;
  deg_intercept_s: number | null;
  median_quick_lap_s: number | null;
  fit_status: "ok" | "too_few_laps" | "no_tyre_life";
  compound_source: (typeof TYRE_SOURCES)[number];
  is_synthetic: boolean;
}

export interface PitStop {
  driver_id: string;
  driver_code: string | null;
  stop: number;
  lap: number;
  time_of_day: string | null;
  duration_s: number | null;
  is_long_stop: boolean | null;
  under_neutralisation: boolean | null;
  compound_before: KnownCompound | null;
  compound_after: KnownCompound | null;
  tyre_life_before: number | null;
  position_before: number | null;
  position_after: number | null;
}

export interface RaceControlMsg {
  seq: number;
  lap: number | null;
  time_utc: string | null;
  category: string | null;
  message: string | null;
  status: string | null;
  flag: string | null;
  scope: string | null;
  driver_id: string | null;
  driver_code: string | null;
  kind: RaceControlKind;
  is_key: boolean;
}

export interface PositionSeries {
  driver_id: string;
  driver_code: string | null;
  grid: number | null;
  positions: { lap: number; position: number }[];
}

export interface CompareLap {
  lap: number;
  a_lap_time_s: number | null;
  b_lap_time_s: number | null;
  delta_s: number | null;
  gap_s: number | null;
  sector1_delta_s: number | null;
  sector2_delta_s: number | null;
  sector3_delta_s: number | null;
  a_position: number | null;
  b_position: number | null;
  a_compound: KnownCompound | null;
  b_compound: KnownCompound | null;
  a_pit: boolean;
  b_pit: boolean;
  neutralised: boolean;
}

export interface AnalysisDoc<T> {
  season: number;
  round: number;
  coverage: Coverage;
  rows: T[];
}

export interface CompareDriver {
  driver_id: string;
  driver_code: string;
}

export interface Compare extends AnalysisDoc<CompareLap> {
  a: CompareDriver;
  b: CompareDriver;
}

// ------------------------------------------------------------------ guards
type Check = (v: unknown) => boolean;
const opt =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    isStr(v) && values.includes(v);
const nonNegInt: Check = (v) => isInt(v) && v >= 0;
const posInt: Check = (v) => isInt(v) && v >= 1;
const num: Check = isFiniteNumber;
const CODE = /^[A-Z]{3}$/;
const isCode: Check = (v) => isStr(v) && CODE.test(v);
const compound = opt(oneOf(KNOWN_COMPOUNDS));

/** A guard for objects with exactly these checked fields (extra fields are dropped). */
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

export const toCoverage = shape<Coverage>({
  n_drivers: nonNegInt,
  n_laps: nonNegInt,
  n_lap_rows: nonNegInt,
  tyre_source: oneOf(TYRE_SOURCES),
  is_synthetic: isBool,
  has_sectors: isBool,
  has_speed_traps: isBool,
  deleted_known: isBool,
  neutralised_source: oneOf(["track_status", "heuristic", "mixed"]),
  n_race_control: nonNegInt,
  n_pitstops: nonNegInt,
  n_quick_laps: nonNegInt,
  n_ti_only_laps_dropped: nonNegInt,
});

export const toAnalysisLap = shape<AnalysisLap>({
  driver_id: isDriverId,
  driver_code: opt(isStr),
  lap: posInt,
  position: opt(posInt),
  lap_time_s: opt(num),
  cumulative_time_s: opt(num),
  gap_to_leader_s: opt(num),
  sector1_s: opt(num),
  sector2_s: opt(num),
  sector3_s: opt(num),
  speed_i1_kph: opt(num),
  speed_i2_kph: opt(num),
  speed_fl_kph: opt(num),
  speed_st_kph: opt(num),
  stint: opt(posInt),
  compound,
  tyre_life_laps: opt(nonNegInt),
  compound_source: oneOf(TYRE_SOURCES),
  is_synthetic: isBool,
  is_pit_in_lap: opt(isBool),
  is_pit_out_lap: opt(isBool),
  is_deleted: opt(isBool),
  deleted_reason: opt(isStr),
  track_status: opt(isStr),
  is_sc_lap: opt(isBool),
  is_vsc_lap: opt(isBool),
  is_red_flag_lap: opt(isBool),
  is_neutralised_lap: opt(isBool),
  neutralised_source: oneOf(["track_status", "heuristic"]),
  is_quick_lap: isBool,
  quick_lap_exclusion: opt(oneOf(QUICK_LAP_EXCLUSIONS)),
});

export const toStint = shape<Stint>({
  driver_id: isDriverId,
  driver_code: opt(isStr),
  stint: posInt,
  compound,
  start_lap: posInt,
  end_lap: posInt,
  laps: posInt,
  tyre_life_start: opt(isInt),
  tyre_life_end: opt(isInt),
  used_set: opt(isBool),
  ends_in_pit: isBool,
  n_quick_laps: nonNegInt,
  deg_slope_s_per_lap: opt(num),
  deg_intercept_s: opt(num),
  median_quick_lap_s: opt(num),
  fit_status: oneOf(["ok", "too_few_laps", "no_tyre_life"]),
  compound_source: oneOf(TYRE_SOURCES),
  is_synthetic: isBool,
});

export const toPitStop = shape<PitStop>({
  driver_id: isDriverId,
  driver_code: opt(isStr),
  stop: posInt,
  lap: posInt,
  time_of_day: opt(isStr),
  duration_s: opt(num),
  is_long_stop: opt(isBool),
  under_neutralisation: opt(isBool),
  compound_before: compound,
  compound_after: compound,
  tyre_life_before: opt(isInt),
  position_before: opt(isInt),
  position_after: opt(isInt),
});

export const toRaceControlMsg = shape<RaceControlMsg>({
  seq: nonNegInt,
  lap: opt(isInt),
  time_utc: opt(isStr),
  category: opt(isStr),
  message: opt(isStr),
  status: opt(isStr),
  flag: opt(isStr),
  scope: opt(isStr),
  driver_id: opt(isDriverId),
  driver_code: opt(isStr),
  kind: oneOf(RC_KINDS),
  is_key: isBool,
});

const toPositionPoint = shape<{ lap: number; position: number }>({ lap: posInt, position: posInt });

export function toPositionSeries(v: unknown): PositionSeries | undefined {
  const head = shape<Omit<PositionSeries, "positions"> & { positions: unknown }>({
    driver_id: isDriverId,
    driver_code: opt(isStr),
    grid: opt(nonNegInt),
    positions: Array.isArray,
  })(v);
  if (!head || !Array.isArray(head.positions)) return undefined;
  const points = head.positions.map(toPositionPoint);
  if (points.some((p) => p === undefined)) return undefined;
  return { ...head, positions: points as { lap: number; position: number }[] };
}

export const toCompareLap = shape<CompareLap>({
  lap: posInt,
  a_lap_time_s: opt(num),
  b_lap_time_s: opt(num),
  delta_s: opt(num),
  gap_s: opt(num),
  sector1_delta_s: opt(num),
  sector2_delta_s: opt(num),
  sector3_delta_s: opt(num),
  a_position: opt(isInt),
  b_position: opt(isInt),
  a_compound: compound,
  b_compound: compound,
  a_pit: isBool,
  b_pit: isBool,
  neutralised: isBool,
});

const toCompareDriver = shape<CompareDriver>({ driver_id: isDriverId, driver_code: isCode });

/** A guard for ``{season, round, coverage, rows}`` with every row checked by ``row``. */
export function docGuard<T>(row: (v: unknown) => T | undefined): (v: unknown) => AnalysisDoc<T> | undefined {
  return (v) => {
    if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !Array.isArray(v.rows)) return undefined;
    const coverage = toCoverage(v.coverage);
    if (!coverage) return undefined;
    const rows = v.rows.map(row);
    if (rows.some((r) => r === undefined)) return undefined;
    return { season: v.season, round: v.round, coverage, rows: rows as T[] };
  };
}

export const toLapsDoc = docGuard(toAnalysisLap);
export const toStintsDoc = docGuard(toStint);
export const toPitStopsDoc = docGuard(toPitStop);
export const toRaceControlDoc = docGuard(toRaceControlMsg);
export const toPositionsDoc = docGuard(toPositionSeries);

export function toCompare(v: unknown): Compare | undefined {
  const doc = docGuard(toCompareLap)(v);
  if (!doc || !isObj(v)) return undefined;
  const a = toCompareDriver(v.a);
  const b = toCompareDriver(v.b);
  return a && b ? { ...doc, a, b } : undefined;
}

// ------------------------------------------------------------------ tabs and the URL
export const VIEWS = [
  { id: "strategy", label: "Tyre strategy" },
  { id: "laps", label: "Lap times" },
  { id: "deg", label: "Tyre degradation" },
  { id: "positions", label: "Positions" },
  { id: "compare", label: "Compare" },
  { id: "pits", label: "Pit stops" },
  { id: "control", label: "Race control" },
  { id: "telemetry", label: "Telemetry" },
] as const;
export type ViewId = (typeof VIEWS)[number]["id"];
export const isViewId = (v: unknown): v is ViewId => isStr(v) && VIEWS.some((x) => x.id === v);

/** WAI-ARIA tabs: the tab index a key moves to (arrows wrap; Home/End), or null for other keys. */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface AnalysisQuery {
  view: ViewId;
  lap: number | null;
  a: string | null;
  b: string | null;
  driver: string | null;
  /** The Telemetry view's picks (Feature 6): driver A + lap and driver B + lap. */
  ta: string | null;
  talap: number | null;
  tb: string | null;
  tblap: number | null;
}

/** The tab state kept in the URL (``?view=…&lap=…&a=…&b=…&driver=…``); invalid values are dropped. */
export function parseAnalysisQuery(q: Record<string, string | string[] | undefined>): AnalysisQuery {
  const one = (k: string): string | null => {
    const v = q[k];
    return typeof v === "string" ? v : null;
  };
  const lapOf = (k: string): number | null => {
    const text = one(k);
    return text !== null && /^[1-9][0-9]{0,2}$/.test(text) ? Number(text) : null;
  };
  const lap = lapOf("lap");
  const code = (k: string) => {
    const v = one(k);
    return v !== null && CODE.test(v) ? v : null;
  };
  const view = one("view");
  return {
    view: isViewId(view) ? view : "strategy",
    lap,
    a: code("a"),
    b: code("b"),
    driver: code("driver"),
    ta: code("ta"),
    talap: lapOf("talap"),
    tb: code("tb"),
    tblap: lapOf("tblap"),
  };
}

export function analysisSearch(q: Partial<AnalysisQuery> & { view: ViewId }): string {
  const p = new URLSearchParams({ view: q.view });
  if (q.lap) p.set("lap", String(q.lap));
  if (q.a) p.set("a", q.a);
  if (q.b) p.set("b", q.b);
  if (q.driver) p.set("driver", q.driver);
  if (q.ta) p.set("ta", q.ta);
  if (q.talap) p.set("talap", String(q.talap));
  if (q.tb) p.set("tb", q.tb);
  if (q.tblap) p.set("tblap", String(q.tblap));
  return `?${p.toString()}`;
}

// ------------------------------------------------------------------ labels
export const COMPOUND_LETTER: Record<KnownCompound, string> = {
  SOFT: "S",
  MEDIUM: "M",
  HARD: "H",
  INTERMEDIATE: "I",
  WET: "W",
};
export const COMPOUND_NAME: Record<KnownCompound, string> = {
  SOFT: "Soft",
  MEDIUM: "Medium",
  HARD: "Hard",
  INTERMEDIATE: "Intermediate",
  WET: "Wet",
};
export type CompoundKey = "soft" | "medium" | "hard" | "inter" | "wet" | "unknown";
export function compoundKey(c: KnownCompound | null): CompoundKey {
  if (c === null) return "unknown";
  return c === "INTERMEDIATE" ? "inter" : (c.toLowerCase() as CompoundKey);
}
export const compoundLetter = (c: KnownCompound | null): string => (c === null ? "?" : COMPOUND_LETTER[c]);
export const compoundName = (c: KnownCompound | null): string => (c === null ? "Unknown" : COMPOUND_NAME[c]);

export const EXCLUSION_TEXT: Record<QuickLapExclusion, string> = {
  no_time: "no lap time",
  lap_1: "lap 1 (standing start)",
  pit_in: "pit-in lap",
  pit_out: "pit-out lap",
  neutralised: "SC, VSC or red flag",
  deleted: "deleted lap (track limits)",
  slow_107: "slower than 107% of the stint's fastest",
};

export const RC_KIND_LABEL: Record<RaceControlKind, string> = {
  sc_deployed: "SC",
  sc_ending: "SC in",
  vsc_deployed: "VSC",
  vsc_ending: "VSC ending",
  red_flag: "Red flag",
  penalty: "Penalty",
  investigation: "Investigation",
  track_limits: "Track limits",
  chequered: "Chequered",
  other: "Info",
};

/** "+0.083 s/lap" (always signed, 3 decimals). */
export function slopeText(slope: number): string {
  const v = Math.round(slope * 1000) / 1000;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)} s/lap`;
}

/** "+1.234" / "−0.500" (seconds, signed, 3 decimals). */
export function signed(s: number): string {
  const v = Math.round(s * 1000) / 1000;
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(3)}`;
}

/** Plain-text notes on what this lake does not have for the race (shown above the views). */
export function coverageNotes(c: Coverage): string[] {
  const notes: string[] = [];
  if (c.is_synthetic) notes.push("SYNTHETIC: compounds and tyre ages here are generated, not real tyre data.");
  else if (c.tyre_source === "none") notes.push("No tyre data for this race in the lake.");
  if (!c.has_sectors) notes.push("No sector times in this lake.");
  if (!c.deleted_known) notes.push("Deleted laps are unknown in this lake.");
  if (c.neutralised_source === "heuristic")
    notes.push("Neutralised laps are estimated from lap times (no race-control data): SC and VSC cannot be told apart.");
  if (c.n_race_control === 0) notes.push("No race-control messages in this lake.");
  return notes;
}

// ------------------------------------------------------------------ shaping
/** Driver ids in finishing order (the positions response is already in that order). */
export const finishOrder = (positions: readonly PositionSeries[]): string[] => positions.map((p) => p.driver_id);

/** driver id -> code, from any rows that carry both. */
export function codeIndex(rows: readonly { driver_id: string; driver_code: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) if (r.driver_code && !out.has(r.driver_id)) out.set(r.driver_id, r.driver_code);
  return out;
}

export interface StrategyStint {
  stint: number;
  compound: KnownCompound | null;
  start: number;
  end: number;
  used: boolean;
}

export interface StrategyRow {
  driverId: string;
  stints: StrategyStint[];
  pitLaps: number[];
}

/** One row per driver in ``order`` (drivers without stints are kept with none), stints by number,
 * pit laps from the stops. */
export function strategyRows(stints: readonly Stint[], pits: readonly PitStop[], order: readonly string[]): StrategyRow[] {
  const ids = [...order, ...stints.map((s) => s.driver_id).filter((id) => !order.includes(id))];
  return [...new Set(ids)].map((driverId) => ({
    driverId,
    stints: stints
      .filter((s) => s.driver_id === driverId)
      .sort((a, b) => a.stint - b.stint)
      .map((s) => ({ stint: s.stint, compound: s.compound, start: s.start_lap, end: s.end_lap, used: s.used_set === true })),
    pitLaps: pits
      .filter((p) => p.driver_id === driverId)
      .map((p) => p.lap)
      .sort((a, b) => a - b),
  }));
}

export type NeutralKind = "SC" | "VSC" | "RED" | "NEUTRALISED";

export interface NeutralRange {
  from: number;
  to: number;
  kind: NeutralKind;
}

function neutralKind(l: AnalysisLap): NeutralKind | null {
  if (l.is_red_flag_lap) return "RED";
  if (l.is_sc_lap) return "SC";
  if (l.is_vsc_lap) return "VSC";
  if (l.is_neutralised_lap) return "NEUTRALISED";
  return null;
}

/** Consecutive laps of the leader (position 1 at the end of the lap) under SC, VSC, a red flag, or
 * (heuristic lakes) estimated neutralisation, merged into ranges. */
export function neutralRanges(laps: readonly AnalysisLap[]): NeutralRange[] {
  const leader = new Map<number, AnalysisLap>();
  for (const l of laps) if (l.position === 1) leader.set(l.lap, l);
  const out: NeutralRange[] = [];
  for (const lap of [...leader.keys()].sort((a, b) => a - b)) {
    const kind = neutralKind(leader.get(lap) as AnalysisLap);
    if (kind === null) continue;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === lap - 1) last.to = lap;
    else out.push({ from: lap, to: lap, kind });
  }
  return out;
}

export interface LapPoint {
  lap: number;
  time: number;
  compound: KnownCompound | null;
  pit: "in" | "out" | null;
  neutralised: boolean;
}

/** Each chosen driver's timed laps. */
export function lapSeries(laps: readonly AnalysisLap[], driverIds: readonly string[]): { driverId: string; points: LapPoint[] }[] {
  return driverIds.map((driverId) => ({
    driverId,
    points: laps
      .filter((l) => l.driver_id === driverId && l.lap_time_s !== null)
      .sort((a, b) => a.lap - b.lap)
      .map((l) => ({
        lap: l.lap,
        time: l.lap_time_s as number,
        compound: l.compound,
        pit: l.is_pit_in_lap ? "in" : l.is_pit_out_lap ? "out" : null,
        neutralised: neutralKind(l) !== null,
      })),
  }));
}

/** The lap-time axis: from the fastest lap to at most 12% above the median, so SC and pit laps do
 * not flatten the racing laps; ``above`` counts the points pinned to the top edge. */
export function lapTimeDomain(times: readonly number[]): { lo: number; hi: number; above: number } {
  if (times.length === 0) return { lo: 0, hi: 1, above: 0 };
  const lo = Math.min(...times);
  const max = Math.max(...times);
  const cap = (median(times) ?? max) * 1.12;
  const hi = Math.max(lo + 1, Math.min(max, cap));
  return { lo: Math.floor(lo * 2) / 2, hi: Math.ceil(hi * 2) / 2, above: times.filter((t) => t > hi).length };
}

export interface DegStint {
  stint: number;
  compound: KnownCompound | null;
  points: { life: number; time: number; lap: number }[];
  fit: { slope: number; intercept: number; x0: number; x1: number } | null;
  status: Stint["fit_status"];
  nQuick: number;
}

export interface Degradation {
  stints: DegStint[];
  excluded: { reason: QuickLapExclusion; laps: number[] }[];
}

/** The chosen driver's quick laps per stint (lap time vs tyre life) with the stored fit, and the
 * excluded laps grouped by reason (in the job's priority order). */
export function degradation(laps: readonly AnalysisLap[], stints: readonly Stint[], driverId: string): Degradation {
  const mine = laps.filter((l) => l.driver_id === driverId);
  const out: DegStint[] = stints
    .filter((s) => s.driver_id === driverId)
    .sort((a, b) => a.stint - b.stint)
    .map((s) => {
      const points = mine
        .filter((l) => l.stint === s.stint && l.is_quick_lap && l.lap_time_s !== null && l.tyre_life_laps !== null)
        .map((l) => ({ life: l.tyre_life_laps as number, time: l.lap_time_s as number, lap: l.lap }))
        .sort((a, b) => a.life - b.life);
      const fit =
        s.fit_status === "ok" && s.deg_slope_s_per_lap !== null && s.deg_intercept_s !== null && points.length > 0
          ? {
              slope: s.deg_slope_s_per_lap,
              intercept: s.deg_intercept_s,
              x0: (points[0] as { life: number }).life,
              x1: (points[points.length - 1] as { life: number }).life,
            }
          : null;
      return { stint: s.stint, compound: s.compound, points, fit, status: s.fit_status, nQuick: s.n_quick_laps };
    });
  const excluded = QUICK_LAP_EXCLUSIONS.map((reason) => ({
    reason,
    laps: mine
      .filter((l) => l.quick_lap_exclusion === reason)
      .map((l) => l.lap)
      .sort((a, b) => a - b),
  })).filter((e) => e.laps.length > 0);
  return { stints: out, excluded };
}

/** Compact lap list: "1, 6–7, 10". */
export function lapList(laps: readonly number[]): string {
  const sorted = [...new Set(laps)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const lap of [...sorted, Number.NaN]) {
    if (start !== null && prev !== null && lap === prev + 1) {
      prev = lap;
      continue;
    }
    if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = lap;
    prev = lap;
  }
  return parts.join(", ");
}

export interface PositionLine {
  driverId: string;
  points: { lap: number; position: number }[];
  pitLaneStart: boolean;
}

/** Position by lap per driver, with the grid slot as lap 0 (a pit-lane start, grid 0, is drawn at
 * the back of the field; an unknown grid slot has no lap 0). */
export function positionLines(series: readonly PositionSeries[]): PositionLine[] {
  const field = Math.max(series.length, ...series.flatMap((s) => s.positions.map((p) => p.position)));
  return series.map((s) => {
    const start = s.grid === null ? [] : [{ lap: 0, position: s.grid > 0 ? s.grid : field }];
    return { driverId: s.driver_id, points: [...start, ...s.positions], pitLaneStart: s.grid === 0 };
  });
}

/** Line style per driver: the team colour, solid for the first teammate (by driver id) and dashed
 * for the second, so colour is never the only cue. */
export function teamStyles(
  ids: readonly string[],
  teamOf: (id: string) => { team: string; colour: string } | null,
): Map<string, { colour: string | null; dash: string }> {
  const seen = new Map<string, number>();
  const out = new Map<string, { colour: string | null; dash: string }>();
  for (const id of [...ids].sort()) {
    const t = teamOf(id);
    const n = t ? (seen.get(t.team) ?? 0) : 0;
    if (t) seen.set(t.team, n + 1);
    out.set(id, { colour: t ? t.colour : null, dash: n === 0 ? "" : "6 4" });
  }
  return out;
}

export interface CompareSummary {
  laps: number;
  aFaster: number;
  bFaster: number;
  medianDelta: number | null;
  finalGap: number | null;
  finalLap: number | null;
}

/** Laps where both have a time: how often each was faster, the median delta, and the last gap. */
export function compareSummary(rows: readonly CompareLap[]): CompareSummary {
  const deltas = rows.map((r) => r.delta_s).filter((d): d is number => d !== null);
  const withGap = rows.filter((r) => r.gap_s !== null);
  const last = withGap[withGap.length - 1];
  return {
    laps: deltas.length,
    aFaster: deltas.filter((d) => d < 0).length,
    bFaster: deltas.filter((d) => d > 0).length,
    medianDelta: median(deltas),
    finalGap: last ? last.gap_s : null,
    finalLap: last ? last.lap : null,
  };
}

/** Sum of each sector's delta over the laps where both drivers have that sector. */
export function sectorTotals(rows: readonly CompareLap[]): { sector: 1 | 2 | 3; total: number; laps: number }[] {
  return ([1, 2, 3] as const).map((sector) => {
    const vals = rows
      .map((r) => (sector === 1 ? r.sector1_delta_s : sector === 2 ? r.sector2_delta_s : r.sector3_delta_s))
      .filter((v): v is number => v !== null);
    return { sector, total: Math.round(vals.reduce((a, b) => a + b, 0) * 1000) / 1000, laps: vals.length };
  });
}

/** The race-control list: key events only (SC, VSC, red flag, penalties) unless ``all``. */
export const raceControlRows = (rows: readonly RaceControlMsg[], all: boolean): RaceControlMsg[] =>
  rows.filter((r) => all || r.is_key);
