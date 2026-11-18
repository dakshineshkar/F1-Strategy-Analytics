/** Post-race archive (Feature 4, display only): the bundle guard and the pure helpers of the
 * post-race mode.
 *
 * A bundle (``GET /api/archive/{s}/{r}``, schema v1) holds, per leader lap N, the messages the stream
 * published in that lap's micro-batch and the Redis state at the end of lap N (the 9 driver-hash
 * fields, the order zset and the tyre hash). The view at lap N is built by the **unchanged** live
 * reducer: reset, then for each lap ≤ N its messages (exactly as the SSE stream frames them) and its
 * snapshot. So the tower, gaps, tyres and alert groups are what a live dashboard connected from the
 * start shows at the end of that lap; nothing is recomputed here. Announcements are cleared (the
 * archive never speaks from the alert feed's live region). */

import { type RaceControlMsg, toRaceControlMsg } from "./analysis";
import { type DriverState, type RaceSnapshot, toDriverState, type TyreLife, toTyreLife } from "./api";
import { type Entrant, toEntrant } from "./entrants";
import { isBool, isDriverId, isFiniteNumber, isInt, isObj, isStr, nullable, UUID } from "./guard";
import { initialState, raceReducer, type RaceState } from "./reducer";

export const ARCHIVE_SCHEMA_VERSION = 1;
export const PLAY_SPEEDS = [1, 10, 60] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];
/** A lap's playback length when the leader's lap time is unknown (race seconds). */
export const FALLBACK_LAP_S = 90;
const MESSAGE_TYPES = ["lap", "pit_in", "pit_out", "undercut_alert", "session_end"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];

export interface ArchiveSnapshot {
  lap: number;
  drivers: Record<string, DriverState>;
  order: { driver_id: string; position: number }[];
  tyres: Record<string, TyreLife>;
}

export interface ArchiveMessage {
  /** Leader lap of the micro-batch that published it. */
  lap: number;
  eventId: string;
  type: MessageType;
  /** The SSE data line of the message (the published JSON plus ``event_id``). */
  raw: string;
  payload: Record<string, unknown>;
}

export interface ArchiveTrackLap {
  lap: number;
  sc: boolean | null;
  vsc: boolean | null;
  red: boolean | null;
  neutralised: boolean | null;
  source: "track_status" | "heuristic";
}

export interface ArchiveMeta {
  season: number;
  round: number;
  raceName: string | null;
  laps: number;
  synthetic: boolean;
  source: "sample" | "lake";
  modelVersion: string;
  scorerSha256: string;
  clock: string;
}

export interface ArchiveBundle {
  meta: ArchiveMeta;
  entrants: Entrant[];
  snapshots: ArchiveSnapshot[];
  messages: ArchiveMessage[];
  track: ArchiveTrackLap[];
  raceControl: RaceControlMsg[];
}

export interface ArchiveRace {
  season: number;
  round: number;
  raceName: string | null;
  laps: number;
  synthetic: boolean;
  modelVersion: string;
  sizeBytes: number;
}

// ------------------------------------------------------------------ guards
function toArchiveSnapshot(v: unknown): ArchiveSnapshot | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1 || !isObj(v.drivers) || !Array.isArray(v.order)) return undefined;
  const drivers: Record<string, DriverState> = {};
  for (const [id, raw] of Object.entries(v.drivers)) {
    const d = toDriverState(raw);
    if (!isDriverId(id) || d === undefined) return undefined;
    drivers[id] = d;
  }
  const order: ArchiveSnapshot["order"] = [];
  for (const o of v.order) {
    if (!isObj(o) || !isDriverId(o.driver_id) || !isInt(o.position)) return undefined;
    order.push({ driver_id: o.driver_id, position: o.position });
  }
  const tyres: Record<string, TyreLife> = {};
  if (!isObj(v.tyres)) return undefined;
  for (const [id, raw] of Object.entries(v.tyres)) {
    const t = toTyreLife(raw);
    if (!isDriverId(id) || t === undefined) return undefined;
    tyres[id] = t;
  }
  return { lap: v.lap, drivers, order, tyres };
}

function toArchiveMessage(v: unknown, season: number, round: number): ArchiveMessage | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1 || !isStr(v.event_id) || !UUID.test(v.event_id)) return undefined;
  const m = v.message;
  if (!isObj(m) || !isStr(m.type) || !(MESSAGE_TYPES as readonly string[]).includes(m.type)) return undefined;
  if (m.season !== season || m.round !== round || !isObj(m.payload)) return undefined;
  return {
    lap: v.lap,
    eventId: v.event_id,
    type: m.type as MessageType,
    raw: JSON.stringify({ ...m, event_id: v.event_id }),
    payload: m.payload,
  };
}

function toTrackLap(v: unknown): ArchiveTrackLap | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1) return undefined;
  const flags = [v.is_sc_lap, v.is_vsc_lap, v.is_red_flag_lap, v.is_neutralised_lap].map((x) => nullable(x, isBool));
  if (flags.includes(undefined)) return undefined;
  if (v.neutralised_source !== "track_status" && v.neutralised_source !== "heuristic") return undefined;
  const [sc, vsc, red, neutralised] = flags as (boolean | null)[];
  return {
    lap: v.lap,
    sc: sc ?? null,
    vsc: vsc ?? null,
    red: red ?? null,
    neutralised: neutralised ?? null,
    source: v.neutralised_source,
  };
}

function toMeta(v: unknown): ArchiveMeta | undefined {
  if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !isInt(v.laps) || v.laps < 1) return undefined;
  if (!isBool(v.synthetic) || (v.source !== "sample" && v.source !== "lake") || !isStr(v.clock)) return undefined;
  const name = nullable(v.race_name, isStr);
  const model = v.model;
  if (name === undefined || !isObj(model) || !isStr(model.version) || !isStr(model.scorer_sha256)) return undefined;
  return {
    season: v.season,
    round: v.round,
    raceName: name,
    laps: v.laps,
    synthetic: v.synthetic,
    source: v.source,
    modelVersion: model.version,
    scorerSha256: model.scorer_sha256,
    clock: v.clock,
  };
}

function all<T>(v: unknown, guard: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(guard);
  return out.includes(undefined) ? undefined : (out as T[]);
}

/** A whole bundle, or ``undefined`` if any part breaks schema v1 (one bad row rejects it). */
export function toArchiveBundle(v: unknown): ArchiveBundle | undefined {
  if (!isObj(v) || v.schema_version !== ARCHIVE_SCHEMA_VERSION) return undefined;
  const meta = toMeta(v.meta);
  if (meta === undefined) return undefined;
  const snapshots = all(v.snapshots, toArchiveSnapshot);
  const messages = all(v.messages, (x) => toArchiveMessage(x, meta.season, meta.round));
  const entrants = all(v.entrants, toEntrant);
  const track = all(v.track, toTrackLap);
  const raceControl = all(v.race_control, toRaceControlMsg);
  if (!snapshots || !messages || !entrants || !track || !raceControl || snapshots.length === 0) return undefined;
  const laps = snapshots.map((s) => s.lap);
  if (laps.some((l, i) => i > 0 && l <= (laps[i - 1] as number)) || laps[laps.length - 1] !== meta.laps) return undefined;
  const known = new Set(laps);
  if (messages.some((m, i) => !known.has(m.lap) || (i > 0 && m.lap < (messages[i - 1] as ArchiveMessage).lap))) {
    return undefined;
  }
  return { meta, entrants, snapshots, messages, track, raceControl };
}

export function toArchiveList(v: unknown): ArchiveRace[] | undefined {
  if (!isObj(v) || !Array.isArray(v.races)) return undefined;
  const out: ArchiveRace[] = [];
  for (const r of v.races) {
    if (!isObj(r) || !isInt(r.season) || !isInt(r.round) || !isInt(r.laps) || !isBool(r.synthetic)) return undefined;
    const name = nullable(r.race_name, isStr);
    if (name === undefined || !isStr(r.model_version) || !isInt(r.size_bytes)) return undefined;
    out.push({
      season: r.season,
      round: r.round,
      raceName: name,
      laps: r.laps,
      synthetic: r.synthetic,
      modelVersion: r.model_version,
      sizeBytes: r.size_bytes,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the view at a lap
export const snapshotLaps = (b: ArchiveBundle): number[] => b.snapshots.map((s) => s.lap);

/** The snapshot lap shown for ``lap``: the latest one at or before it (the first one below it). */
export function clampLap(b: ArchiveBundle, lap: number): number {
  const laps = snapshotLaps(b);
  let out = laps[0] as number;
  for (const l of laps) if (l <= lap) out = l;
  return out;
}

function toSnapshotData(b: ArchiveBundle, s: ArchiveSnapshot): RaceSnapshot {
  return { season: b.meta.season, round: b.meta.round, drivers: s.drivers, order: s.order, tyres: s.tyres };
}

/** ``state`` (the view at the end of lap ``fromLap``, or a fresh state with ``fromLap`` 0) moved to
 * the end of lap ``toLap``: every micro-batch of the laps in (fromLap, toLap], each lap's messages
 * through the live reducer and then that lap's snapshot. */
export function advance(state: RaceState, b: ArchiveBundle, fromLap: number, toLap: number): RaceState {
  // the guard ensures messages are sorted by lap and every message lap is a snapshot lap
  let s = state;
  let i = 0;
  for (const snap of b.snapshots) {
    if (snap.lap > toLap) break;
    const start = i;
    while (i < b.messages.length && (b.messages[i] as ArchiveMessage).lap === snap.lap) i += 1;
    if (snap.lap <= fromLap) continue;
    for (const m of b.messages.slice(start, i)) s = raceReducer(s, { type: "event", raw: m.raw });
    s = raceReducer(s, { type: "snapshot", data: toSnapshotData(b, snap) });
  }
  return s.announcements.length ? { ...s, announcements: [] } : s;
}

/** The view at the end of ``lap`` (clamped to the bundle's laps), from scratch. */
export function stateAtLap(b: ArchiveBundle, lap: number): RaceState {
  return advance(initialState(b.meta.season, b.meta.round), b, 0, clampLap(b, lap));
}

/** Incremental seeking: forward from the cached lap, from scratch when going back. */
export function seek(cache: { lap: number; state: RaceState } | null, b: ArchiveBundle, lap: number) {
  const to = clampLap(b, lap);
  if (cache !== null && cache.state.season === b.meta.season && cache.state.round === b.meta.round && to >= cache.lap) {
    return { lap: to, state: to === cache.lap ? cache.state : advance(cache.state, b, cache.lap, to) };
  }
  return { lap: to, state: stateAtLap(b, to) };
}

export const lapValueText = (lap: number, total: number): string => `Lap ${lap} of ${total}`;

// ------------------------------------------------------------------ markers
export type MarkerKind = "pit" | "sc" | "vsc" | "red" | "neutral" | "alert";
export const MARKER_CODE: Record<MarkerKind, string> = {
  pit: "P",
  sc: "SC",
  vsc: "VSC",
  red: "R",
  neutral: "N",
  alert: "A",
};
export const MARKER_LANES: readonly { id: "pits" | "flags" | "alerts"; label: string; kinds: MarkerKind[] }[] = [
  { id: "flags", label: "Flags", kinds: ["sc", "vsc", "red", "neutral"] },
  { id: "pits", label: "Pits", kinds: ["pit"] },
  { id: "alerts", label: "Alerts", kinds: ["alert"] },
];

export interface Marker {
  lap: number;
  kind: MarkerKind;
  code: string;
  /** Accessible name, e.g. "Lap 22: safety car. Jump to lap 22". */
  label: string;
  count: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Event markers per lap: pit stops (the micro-batch's lap), the start of each SC / VSC / red-flag
 * period (or of a lap-time-estimated neutralisation when the lake has no race-control data), and the
 * alerts the live feed announces (attempts and probability crossings). Lap order, then lane order. */
export function markers(b: ArchiveBundle, codeOf: (driverId: string) => string = (d) => d): Marker[] {
  const out: Marker[] = [];
  const add = (lap: number, kind: MarkerKind, what: string, count: number) =>
    out.push({ lap, kind, code: MARKER_CODE[kind], label: `Lap ${lap}: ${what}. Jump to lap ${lap}`, count });
  const flagNames: Record<"sc" | "vsc" | "red" | "neutral", string> = {
    sc: "safety car",
    vsc: "virtual safety car",
    red: "red flag",
    neutral: "neutralised (estimated from lap times)",
  };
  const prev: Record<string, boolean> = {};
  for (const t of b.track) {
    const on = {
      sc: t.sc === true,
      vsc: t.vsc === true,
      red: t.red === true,
      neutral: t.neutralised === true && t.sc === null && t.vsc === null,
    };
    for (const k of ["sc", "vsc", "red", "neutral"] as const) {
      if (on[k] && !prev[k]) add(t.lap, k, flagNames[k], 1);
      prev[k] = on[k];
    }
  }
  const byLap = (type: MessageType, keep: (p: Record<string, unknown>) => boolean) => {
    const m = new Map<number, Record<string, unknown>[]>();
    for (const x of b.messages) if (x.type === type && keep(x.payload)) m.set(x.lap, [...(m.get(x.lap) ?? []), x.payload]);
    return m;
  };
  for (const [lap, ps] of byLap("pit_in", () => true)) {
    const who = ps.map((p) => (isStr(p.driver_id) ? codeOf(p.driver_id) : "?")).join(", ");
    add(lap, "pit", `${plural(ps.length, "pit stop", "pit stops")} (${who})`, ps.length);
  }
  const announced = (p: Record<string, unknown>) => p.reason === "attempt" || p.trigger === "probability_crossed";
  for (const [lap, ps] of byLap("undercut_alert", announced)) {
    const attempts = ps.filter((p) => p.reason === "attempt").length;
    const crossed = ps.length - attempts;
    const parts = [attempts ? plural(attempts, "undercut attempt", "undercut attempts") : "", crossed ? plural(crossed, "probability crossing", "probability crossings") : ""];
    add(lap, "alert", parts.filter(Boolean).join(" and "), ps.length);
  }
  const lane = (k: MarkerKind) => MARKER_LANES.findIndex((l) => l.kinds.includes(k));
  return out.sort((x, y) => x.lap - y.lap || lane(x.kind) - lane(y.kind));
}

/** Rows for markers on a track ``width`` px wide (greedy, no two buttons overlap in a row). */
export function markerRows(laps: readonly number[], first: number, last: number, width: number, markerPx: number): number[] {
  const ends: number[] = [];
  return laps.map((lap) => {
    const x = last > first ? ((lap - first) / (last - first)) * width : 0;
    let row = ends.findIndex((end) => x - markerPx / 2 >= end + 2);
    if (row === -1) {
      row = ends.length;
      ends.push(0);
    }
    ends[row] = x + markerPx / 2;
    return row;
  });
}

export const lapPercent = (lap: number, first: number, last: number): number =>
  last > first ? ((lap - first) / (last - first)) * 100 : 0;

// ------------------------------------------------------------------ playback
export interface Playback {
  lap: number;
  playing: boolean;
  speed: PlaySpeed;
}

export type PlaybackAction =
  | { type: "toggle" }
  | { type: "pause" }
  | { type: "step"; by: -1 | 1 }
  | { type: "seek"; lap: number }
  | { type: "tick" }
  | { type: "speed"; speed: PlaySpeed };

/** Client-side playback over the bundle's snapshot laps ``laps`` (sorted, non-empty). */
export function playback(state: Playback, action: PlaybackAction, laps: readonly number[]): Playback {
  const first = laps[0] as number;
  const last = laps[laps.length - 1] as number;
  const at = (lap: number) => {
    let out = first;
    for (const l of laps) if (l <= lap) out = l;
    return out;
  };
  const idx = laps.indexOf(at(state.lap));
  switch (action.type) {
    case "toggle":
      if (state.playing) return { ...state, playing: false };
      return { ...state, playing: true, lap: at(state.lap) >= last ? first : at(state.lap) };
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "step": {
      const next = laps[Math.min(Math.max(idx + action.by, 0), laps.length - 1)] as number;
      return { ...state, lap: next, playing: false };
    }
    case "seek":
      return { ...state, lap: at(Math.min(Math.max(action.lap, first), last)), playing: false };
    case "tick": {
      if (!state.playing) return state;
      const next = laps[idx + 1];
      return next === undefined ? { ...state, playing: false } : { ...state, lap: next, playing: next < last };
    }
    case "speed":
      return state.speed === action.speed ? state : { ...state, speed: action.speed };
  }
}

/** Wall-clock milliseconds until playback leaves ``lap``: the next lap's leader lap time (from its
 * snapshot) at ``speed``, or ``FALLBACK_LAP_S`` when unknown. */
export function lapDurationMs(b: ArchiveBundle, lap: number, speed: PlaySpeed): number {
  const next = b.snapshots.find((s) => s.lap > lap);
  const leader = next?.order.find((o) => o.position === 1)?.driver_id;
  const t = leader !== undefined ? next?.drivers[leader]?.last_lap_time_s : null;
  const seconds = isFiniteNumber(t) && t > 0 ? t : FALLBACK_LAP_S;
  return Math.max(Math.round((seconds * 1000) / speed), 50);
}

// ------------------------------------------------------------------ URL state
export type RaceMode = "live" | "archive";

export interface RaceQuery {
  mode: RaceMode;
  lap: number | null;
}

export function parseRaceQuery(q: Record<string, string | string[] | undefined>): RaceQuery {
  const mode = q.mode === "archive" ? "archive" : "live";
  const lap = typeof q.lap === "string" && /^[1-9][0-9]{0,2}$/.test(q.lap) ? Number(q.lap) : null;
  return { mode, lap: mode === "archive" ? lap : null };
}

export function raceSearch(q: RaceQuery): string {
  if (q.mode === "live") return "";
  const p = new URLSearchParams({ mode: "archive" });
  if (q.lap !== null) p.set("lap", String(q.lap));
  return `?${p.toString()}`;
}

/** Race-control messages up to the end of ``lap`` (those without a lap are shown from lap 1). */
export const raceControlUpTo = (b: ArchiveBundle, lap: number): RaceControlMsg[] =>
  b.raceControl.filter((m) => (m.lap ?? 1) <= lap);

// ------------------------------------------------------------------ playback + view in one reducer
export interface ArchiveView {
  pb: Playback;
  /** The live reducer's state at the end of ``lap`` (always ``pb.lap``). */
  view: { lap: number; state: RaceState };
}

export function initialArchiveView(b: ArchiveBundle, lap: number | null, speed: PlaySpeed = 60): ArchiveView {
  const at = clampLap(b, lap ?? (b.snapshots[0] as ArchiveSnapshot).lap);
  return { pb: { lap: at, playing: false, speed }, view: { lap: at, state: stateAtLap(b, at) } };
}

/** One playback action, with the view moved to the new lap (forward incrementally, back from
 * scratch). Pure: the same bundle, state and action always give the same result. */
export function archiveStep(s: ArchiveView, a: PlaybackAction, b: ArchiveBundle): ArchiveView {
  const pb = playback(s.pb, a, snapshotLaps(b));
  if (pb === s.pb) return s;
  return { pb, view: pb.lap === s.view.lap ? s.view : seek(s.view, b, pb.lap) };
}
