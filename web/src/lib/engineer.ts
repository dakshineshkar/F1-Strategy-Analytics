/** Engineer view (Feature 3, display only): types and guards of
 * ``GET /api/races/{s}/{r}/engineer/{driverId}?lap=N`` (mirroring ``src/f1sa/api/models.py``), the
 * fetch with its error texts, and the pure helpers behind the panel (unit-tested). */

import { ApiError, racePath, request } from "./api";
import { isBool, isDriverId, isFiniteNumber, isInt, isObj, isStr } from "./guard";

export const KNOWN_COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"] as const;
export type KnownCompound = (typeof KNOWN_COMPOUNDS)[number];
export const CALL_IDS = ["undercut_window", "threat", "closing", "being_caught", "rejoin", "tyre_offset", "long_stint"] as const;
export type CallId = (typeof CALL_IDS)[number];

export interface TypicalStint {
  compound: KnownCompound | null;
  median_laps: number | null;
  n_stints: number;
  n_races: number;
  source: "circuit" | "all_circuits" | "none";
  is_synthetic: boolean;
}

export interface EngineerCar {
  driver_id: string;
  driver_code: string | null;
  position: number;
  lap: number;
  projected: boolean;
  compound: KnownCompound | null;
  tyre_life_laps: number | null;
  tyre_life_source: "real" | "estimated" | "none";
  tyre_life_delta_laps: number | null;
  stint_laps: number | null;
  typical_stint: TypicalStint;
  pace_last3_s: number | null;
  pace_delta_s: number | null;
  last_lap_time_s: number | null;
  in_pit: boolean;
  undercut_flag: boolean | null;
  undercut_prob: number | null;
  prob_recorded: boolean;
}

export interface EngineerPair {
  front_id: string;
  rear_id: string;
  gap_s: number;
  projected: boolean;
  trend_s_per_lap: number | null;
  trend_laps: number;
  gaps: { lap: number; gap_s: number }[];
  prob: number | null;
  prob_role: "focus_on_ahead" | "threat";
  prob_recorded: boolean;
  pair_matches: boolean | null;
}

export interface RejoinCar {
  driver_id: string;
  gap_s: number;
  projected: boolean;
}

export interface EngineerRejoin {
  pit_loss_s: number | null;
  pit_loss_source: "circuit_prior" | "global_prior" | "none";
  pit_loss_text: string;
  position: number | null;
  ahead_id: string | null;
  behind_id: string | null;
  gap_ahead_s: number | null;
  gap_behind_s: number | null;
  in_traffic: boolean | null;
  reliable: boolean;
  reasons: string[];
  field: RejoinCar[];
  left_out: number;
}

export interface EngineerCall {
  id: CallId;
  severity: "info" | "warn";
  text: string;
}

export interface Neutralised {
  status: "green" | "sc" | "vsc" | "red" | "neutralised" | "unknown";
  source: "track_status" | "estimated" | "none";
  message: string | null;
  message_lap: number | null;
}

export interface Engineer {
  season: number;
  round: number;
  lap: number;
  current_lap: number;
  history_from_lap: number;
  focus_id: string;
  neutralised: Neutralised;
  ahead: EngineerCar | null;
  focus: EngineerCar;
  behind: EngineerCar | null;
  pair_ahead: EngineerPair | null;
  pair_behind: EngineerPair | null;
  rejoin: EngineerRejoin;
  calls: EngineerCall[];
  disclaimer: string;
}

// ------------------------------------------------------------------ guards
type Check = (v: unknown) => boolean;
const opt =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);
const oneOf =
  (vals: readonly string[]): Check =>
  (v) =>
    isStr(v) && vals.includes(v);
const nonNeg: Check = (v) => isInt(v) && v >= 0;
const pos: Check = (v) => isInt(v) && v >= 1;
const num: Check = isFiniteNumber;
const prob: Check = (v) => isFiniteNumber(v) && v >= 0 && v <= 1;
const compound = opt(oneOf(KNOWN_COMPOUNDS));
const strList: Check = (v) => Array.isArray(v) && v.every(isStr);

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

function list<T>(row: (v: unknown) => T | undefined): (v: unknown) => T[] | undefined {
  return (v) => {
    if (!Array.isArray(v)) return undefined;
    const out = v.map(row);
    return out.some((x) => x === undefined) ? undefined : (out as T[]);
  };
}

const ok = <T,>(g: (v: unknown) => T | undefined): Check => (v) => g(v) !== undefined;
const nullableOk = <T,>(g: (v: unknown) => T | undefined): Check => (v) => v === null || g(v) !== undefined;

export const toTypicalStint = shape<TypicalStint>({
  compound,
  median_laps: opt(num),
  n_stints: nonNeg,
  n_races: nonNeg,
  source: oneOf(["circuit", "all_circuits", "none"]),
  is_synthetic: isBool,
});

export const toEngineerCar = (v: unknown): EngineerCar | undefined => {
  const c = shape<EngineerCar>({
    driver_id: isDriverId,
    driver_code: opt(isStr),
    position: pos,
    lap: pos,
    projected: isBool,
    compound,
    tyre_life_laps: opt(isInt),
    tyre_life_source: oneOf(["real", "estimated", "none"]),
    tyre_life_delta_laps: opt(isInt),
    stint_laps: opt(isInt),
    typical_stint: ok(toTypicalStint),
    pace_last3_s: opt(num),
    pace_delta_s: opt(num),
    last_lap_time_s: opt(num),
    in_pit: isBool,
    undercut_flag: opt(isBool),
    undercut_prob: opt(prob),
    prob_recorded: isBool,
  })(v);
  return c ? { ...c, typical_stint: toTypicalStint(c.typical_stint) as TypicalStint } : undefined;
};

const toGapPoint = shape<{ lap: number; gap_s: number }>({ lap: pos, gap_s: num });

export const toEngineerPair = (v: unknown): EngineerPair | undefined => {
  const p = shape<EngineerPair>({
    front_id: isDriverId,
    rear_id: isDriverId,
    gap_s: num,
    projected: isBool,
    trend_s_per_lap: opt(num),
    trend_laps: nonNeg,
    gaps: ok(list(toGapPoint)),
    prob: opt(prob),
    prob_role: oneOf(["focus_on_ahead", "threat"]),
    prob_recorded: isBool,
    pair_matches: opt(isBool),
  })(v);
  return p ? { ...p, gaps: list(toGapPoint)(p.gaps) as EngineerPair["gaps"] } : undefined;
};

const toRejoinCar = shape<RejoinCar>({ driver_id: isDriverId, gap_s: num, projected: isBool });

export const toRejoin = (v: unknown): EngineerRejoin | undefined => {
  const r = shape<EngineerRejoin>({
    pit_loss_s: opt(num),
    pit_loss_source: oneOf(["circuit_prior", "global_prior", "none"]),
    pit_loss_text: isStr,
    position: opt(pos),
    ahead_id: opt(isDriverId),
    behind_id: opt(isDriverId),
    gap_ahead_s: opt(num),
    gap_behind_s: opt(num),
    in_traffic: opt(isBool),
    reliable: isBool,
    reasons: strList,
    field: ok(list(toRejoinCar)),
    left_out: nonNeg,
  })(v);
  return r ? { ...r, field: list(toRejoinCar)(r.field) as RejoinCar[] } : undefined;
};

export const toCall = shape<EngineerCall>({ id: oneOf(CALL_IDS), severity: oneOf(["info", "warn"]), text: isStr });

export const toNeutralised = shape<Neutralised>({
  status: oneOf(["green", "sc", "vsc", "red", "neutralised", "unknown"]),
  source: oneOf(["track_status", "estimated", "none"]),
  message: opt(isStr),
  message_lap: opt(isInt),
});

export function toEngineer(v: unknown): Engineer | undefined {
  if (!isObj(v)) return undefined;
  const head = shape<Pick<Engineer, "season" | "round" | "lap" | "current_lap" | "history_from_lap" | "focus_id" | "disclaimer">>({
    season: isInt,
    round: isInt,
    lap: pos,
    current_lap: pos,
    history_from_lap: pos,
    focus_id: isDriverId,
    disclaimer: isStr,
  })(v);
  const neutralised = toNeutralised(v.neutralised);
  const focus = toEngineerCar(v.focus);
  const rejoin = toRejoin(v.rejoin);
  const calls = list(toCall)(v.calls);
  if (!head || !neutralised || !focus || !rejoin || !calls) return undefined;
  const opts = [v.ahead, v.behind].map((x) => (x === null ? null : toEngineerCar(x)));
  const pairs = [v.pair_ahead, v.pair_behind].map((x) => (x === null ? null : toEngineerPair(x)));
  if ([...opts, ...pairs].some((x) => x === undefined)) return undefined;
  if (!nullableOk(toEngineerCar)(v.ahead) || !nullableOk(toEngineerCar)(v.behind)) return undefined;
  return {
    ...head,
    neutralised,
    focus,
    rejoin,
    calls,
    ahead: opts[0] as EngineerCar | null,
    behind: opts[1] as EngineerCar | null,
    pair_ahead: pairs[0] as EngineerPair | null,
    pair_behind: pairs[1] as EngineerPair | null,
  };
}

// ------------------------------------------------------------------ fetch
export function fetchEngineer(season: number, round: number, driverId: string, signal?: AbortSignal): Promise<Engineer> {
  return request(`${racePath(season, round)}/engineer/${encodeURIComponent(driverId)}`, toEngineer, signal ? { signal } : {});
}

/** A short, actionable message for the panel. */
export function engineerMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "The engineer view is not available.";
  if (err.status === null) return "The API is not reachable.";
  if (err.status === 409) return `${err.message}. Waiting for laps from the replay.`;
  if (err.status === 503) return `The lake or Redis is not available: ${err.message}`;
  return err.message;
}

// ------------------------------------------------------------------ text helpers
export const signed = (v: number, digits = 1): string => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;

export const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** "closing 0.35 s/lap" / "opening 0.20 s/lap" / "steady" (rear car's view; null = too few laps). */
export function trendText(trend: number | null, laps: number): string {
  if (trend === null) return `trend needs 3 laps (${laps} so far)`;
  if (Math.abs(trend) < 0.05) return `steady over ${laps} laps`;
  return `${trend < 0 ? "closing" : "opening"} ${Math.abs(trend).toFixed(2)} s/lap over ${laps} laps`;
}

export function probText(p: number | null, recorded: boolean): string {
  if (!recorded) return "not recorded for this lap";
  return p === null ? "not evaluated" : pct(p);
}

export function tyreText(c: EngineerCar): string {
  if (c.tyre_life_laps === null) return "tyre life unknown";
  return `${c.tyre_life_laps} laps${c.tyre_life_source === "estimated" ? " (est.)" : ""}`;
}

export function stintText(c: EngineerCar): string {
  const t = c.typical_stint;
  const now = c.stint_laps === null ? "—" : `${c.stint_laps} laps`;
  if (t.median_laps === null) return `${now} (no stint history for this compound)`;
  const where = t.source === "circuit" ? "here" : "at earlier circuits";
  return `${now} of a typical ${t.median_laps} ${where} (${t.n_stints} stints, ${t.n_races} races${t.is_synthetic ? ", synthetic" : ""})`;
}

export const NEUTRAL_TEXT: Record<Neutralised["status"], string> = {
  green: "Green",
  sc: "Safety car",
  vsc: "Virtual safety car",
  red: "Red flag",
  neutralised: "Neutralised (estimated from lap times)",
  unknown: "Track status unknown",
};

// ------------------------------------------------------------------ geometry
/** Sparkline points (x, y) in a ``width`` × ``height`` box for the pair's gaps (higher = bigger gap). */
export function sparkline(gaps: readonly { lap: number; gap_s: number }[], width: number, height: number, pad = 2): { x: number; y: number; lap: number; gap_s: number }[] {
  if (gaps.length === 0) return [];
  const laps = gaps.map((g) => g.lap);
  const vals = gaps.map((g) => g.gap_s);
  const [l0, l1] = [Math.min(...laps), Math.max(...laps)];
  const [v0, v1] = [Math.min(...vals), Math.max(...vals)];
  const x = (lap: number) => (l1 === l0 ? width / 2 : pad + ((lap - l0) / (l1 - l0)) * (width - 2 * pad));
  const y = (v: number) => (v1 === v0 ? height / 2 : height - pad - ((v - v0) / (v1 - v0)) * (height - 2 * pad));
  return gaps.map((g) => ({ x: Math.round(x(g.lap) * 100) / 100, y: Math.round(y(g.gap_s) * 100) / 100, lap: g.lap, gap_s: g.gap_s }));
}

export interface RejoinMark {
  driverId: string;
  pct: number;
  projected: boolean;
}

/** The rejoin bar: each car's gap to the focus as a percentage of the window [−5 s, loss + 10 s];
 * cars outside the window are left out; ``slot`` is the focus's rejoin point. */
export function rejoinBar(r: EngineerRejoin): { marks: RejoinMark[]; slot: number | null; window: [number, number] } {
  const lo = -5;
  const hi = (r.pit_loss_s ?? 20) + 10;
  const at = (gap: number) => Math.round(((gap - lo) / (hi - lo)) * 1000) / 10;
  const marks = r.field.filter((c) => c.gap_s >= lo && c.gap_s <= hi).map((c) => ({ driverId: c.driver_id, pct: at(c.gap_s), projected: c.projected }));
  return { marks, slot: r.pit_loss_s === null ? null : at(r.pit_loss_s), window: [lo, hi] };
}

/** Calls whose id was not in the previous lap's list (announced once in the live region). */
export function newCalls(prev: readonly EngineerCall[] | null, next: readonly EngineerCall[]): EngineerCall[] {
  if (prev === null) return [];
  const seen = new Set(prev.map((c) => `${c.id}`));
  return next.filter((c) => !seen.has(c.id));
}

// ------------------------------------------------------------------ the focus lock (per browser)
export const FOCUS_KEY = "f1sa.engineer.focus";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The locked focus driver, or null (no storage, blocked storage or nothing saved). */
export function loadFocus(store: StorageLike | null = storage()): string | null {
  try {
    const v = store?.getItem(FOCUS_KEY) ?? null;
    return v !== null && isDriverId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Save (or clear, with null) the locked driver; a blocked storage is ignored. */
export function saveFocus(driverId: string | null, store: StorageLike | null = storage()): void {
  try {
    if (store) store.setItem(FOCUS_KEY, driverId ?? "");
  } catch {
    // private mode or storage disabled: the lock lasts for this page only
  }
}

/** The focus to show: the lock if that car is in the race, else P1. */
export const pickFocus = (locked: string | null, order: readonly string[]): string | null =>
  locked !== null && order.includes(locked) ? locked : (order[0] ?? null);
