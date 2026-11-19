/** Typed client for the Step 13 API. Every response is checked at runtime, so a bad payload is an
 * ``ApiError`` instead of a crash. Types mirror ``src/f1sa/api/models.py``. */

import { toCompare, toLapsDoc, toPitStopsDoc, toPositionsDoc, toRaceControlDoc, toStintsDoc } from "./analysis";
import { toTelemetryCompare, toTelemetryLaps } from "./telemetry";
import { API_URL } from "./config";
import { toEntrants } from "./entrants";
import { isBool, isDriverId, isFiniteNumber, isInt, isObj, isStr, nullable } from "./guard";
import { type TimingHash, toTimingHash } from "./timing";

export const COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"] as const;
export type Compound = (typeof COMPOUNDS)[number];
export const isCompound = (v: unknown): v is Compound =>
  isStr(v) && (COMPOUNDS as readonly string[]).includes(v);

export interface Race {
  season: number;
  round: number;
  name: string | null;
  laps: number;
  synthetic: boolean;
}

/** The 9 fields of the Redis driver hash (``""`` arrives as null). */
export interface DriverState {
  position: number;
  gap_ahead_s: number | null;
  gap_leader_s: number | null;
  tyre_compound: Compound;
  tyre_age_laps: number | null;
  last_lap_time_s: number | null;
  undercut_flag: boolean;
  undercut_prob: number | null;
  updated_at: string;
}

/** The additive, display-only tyre hash ``race:{s}:{r}:tyre:{driverId}``: the real (TracingInsights)
 * tyre life at ``lap``. Never part of the 9-field driver hash. */
export interface TyreLife {
  lap: number;
  tyre_life_laps: number | null;
  tyre_life_at_start_laps: number | null;
}

export interface RaceSnapshot {
  season: number;
  round: number;
  drivers: Record<string, DriverState>;
  order: { driver_id: string; position: number }[];
  /** Optional: missing in older API responses and for cars without a tyre hash. */
  tyres: Record<string, TyreLife>;
  /** Feature 5, optional: the additive timing hash per car (missing in older APIs and v1 bundles). */
  timing: Record<string, TimingHash>;
}

export interface Lake {
  scheme: "file" | "hdfs";
  mode: "sample" | "full" | null;
  synthetic: boolean | null;
}

/** The scoring model, from ``checks.model`` (display only: the model id the race view labels its
 * probabilities with). Null when the API reports no model or an older API omits it. */
export interface HealthModel {
  model_version: string;
  feature_set: string | null;
  g: number | null;
  k: number | null;
  /** F10, additive: the sample deployment model is scoring (a smoke test). ``null`` from an older API. */
  smoke_test: boolean | null;
  /** F10: the lake the model was trained on; ``null`` from an older API. */
  trained_on: "sample" | "full" | null;
  /** F10: the same value as ``model_version``; ``null`` from an older API. */
  model_id: string | null;
  /** F10: the metadata's SMOKE TEST stamp text, or null. */
  stamp: string | null;
}

export interface Health {
  status: "ok" | "degraded";
  lake: Lake;
  model: HealthModel | null;
}

export type ReplayState = "starting" | "running" | "paused" | "stopped" | "finished" | "failed";
export type ReplaySpeed = 1 | 10 | 60;

export interface Replay {
  season: number;
  round: number;
  /** The speed in force (the latest one set). */
  speed: number;
  run_id: string;
  state: ReplayState;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Feature 7 (an older API omits them: read as not paused, no lap, no note). */
  paused: boolean;
  /** The highest lap of a lap event the producer has sent. */
  lap: number | null;
  /** Why a replay was stopped without a request (the pause cap). */
  note: string | null;
  paused_at: string | null;
}

export interface ReplayStatus {
  enabled: boolean;
  max_running: number;
  running: Replay[];
  recent: Replay[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ------------------------------------------------------------------ guards (exported for tests)
export function toRace(v: unknown): Race | undefined {
  if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !isInt(v.laps) || !isBool(v.synthetic)) {
    return undefined;
  }
  const name = nullable(v.name, isStr);
  if (name === undefined) return undefined;
  return { season: v.season, round: v.round, name, laps: v.laps, synthetic: v.synthetic };
}

export function toRaces(v: unknown): Race[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Race[] = [];
  for (const item of v) {
    const race = toRace(item);
    if (race === undefined) return undefined;
    out.push(race);
  }
  return out;
}

export function toDriverState(v: unknown): DriverState | undefined {
  if (!isObj(v) || !isInt(v.position) || !isCompound(v.tyre_compound) || !isBool(v.undercut_flag)) {
    return undefined;
  }
  if (!isStr(v.updated_at)) return undefined;
  const gapAhead = nullable(v.gap_ahead_s, isFiniteNumber);
  const gapLeader = nullable(v.gap_leader_s, isFiniteNumber);
  const tyreAge = nullable(v.tyre_age_laps, isInt);
  const lastLap = nullable(v.last_lap_time_s, isFiniteNumber);
  const prob = nullable(v.undercut_prob, isFiniteNumber);
  if ([gapAhead, gapLeader, tyreAge, lastLap, prob].some((x) => x === undefined)) return undefined;
  return {
    position: v.position,
    gap_ahead_s: gapAhead ?? null,
    gap_leader_s: gapLeader ?? null,
    tyre_compound: v.tyre_compound,
    tyre_age_laps: tyreAge ?? null,
    last_lap_time_s: lastLap ?? null,
    undercut_flag: v.undercut_flag,
    undercut_prob: prob ?? null,
    updated_at: v.updated_at,
  };
}

export function toTyreLife(v: unknown): TyreLife | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1) return undefined;
  const life = nullable(v.tyre_life_laps, isInt);
  const atStart = nullable(v.tyre_life_at_start_laps, isInt);
  if (life === undefined || atStart === undefined) return undefined;
  if ((life !== null && life < 1) || (atStart !== null && atStart < 0)) return undefined;
  return { lap: v.lap, tyre_life_laps: life, tyre_life_at_start_laps: atStart };
}

export function toSnapshot(v: unknown): RaceSnapshot | undefined {
  if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !isObj(v.drivers)) return undefined;
  if (!Array.isArray(v.order)) return undefined;
  const drivers: Record<string, DriverState> = {};
  for (const [id, raw] of Object.entries(v.drivers)) {
    const d = toDriverState(raw);
    if (!isDriverId(id) || d === undefined) return undefined;
    drivers[id] = d;
  }
  const order: RaceSnapshot["order"] = [];
  for (const o of v.order) {
    if (!isObj(o) || !isDriverId(o.driver_id) || !isInt(o.position)) return undefined;
    order.push({ driver_id: o.driver_id, position: o.position });
  }
  // display only: a malformed tyre entry is dropped, never the snapshot
  const tyres: Record<string, TyreLife> = {};
  if (isObj(v.tyres)) {
    for (const [id, raw] of Object.entries(v.tyres)) {
      const t = toTyreLife(raw);
      if (isDriverId(id) && t !== undefined) tyres[id] = t;
    }
  }
  const timing: Record<string, TimingHash> = {};
  if (isObj(v.timing)) {
    for (const [id, raw] of Object.entries(v.timing)) {
      const t = toTimingHash(raw);
      if (isDriverId(id) && t !== undefined) timing[id] = t;
    }
  }
  return { season: v.season, round: v.round, drivers, order, tyres, timing };
}

export function toHealth(v: unknown): Health | undefined {
  if (!isObj(v) || (v.status !== "ok" && v.status !== "degraded") || !isObj(v.lake)) {
    return undefined;
  }
  const { scheme, mode, synthetic } = v.lake;
  if (scheme !== "file" && scheme !== "hdfs") return undefined;
  if (mode !== "sample" && mode !== "full" && mode !== null) return undefined;
  if (synthetic !== null && !isBool(synthetic)) return undefined;
  return { status: v.status, lake: { scheme, mode, synthetic }, model: toHealthModel(v.checks) };
}

/** ``checks.model`` when it names a model; anything missing or malformed is "no model" (the health check
 * stays usable for the lake banner). */
export function toHealthModel(checks: unknown): HealthModel | null {
  if (!isObj(checks) || !isObj(checks.model)) return null;
  const m = checks.model;
  if (!isStr(m.model_version) || m.model_version === "") return null;
  const num = (x: unknown): number | null => (isFiniteNumber(x) ? x : null);
  return {
    model_version: m.model_version,
    feature_set: isStr(m.feature_set) ? m.feature_set : null,
    g: num(m.g),
    k: num(m.k),
    smoke_test: isBool(m.smoke_test) ? m.smoke_test : null,
    trained_on: m.trained_on === "sample" || m.trained_on === "full" ? m.trained_on : null,
    model_id: isStr(m.model_id) && m.model_id !== "" ? m.model_id : null,
    stamp: isStr(m.stamp) && m.stamp !== "" ? m.stamp : null,
  };
}

const REPLAY_STATES: readonly ReplayState[] = ["starting", "running", "paused", "stopped", "finished", "failed"];

/** An optional field: its default when absent, ``undefined`` (invalid) when present but wrong. */
function optional<T>(v: unknown, fallback: T, check: (x: unknown) => x is T): T | undefined {
  if (v === undefined) return fallback;
  return check(v) ? v : undefined;
}

export function toReplay(v: unknown): Replay | undefined {
  if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !isInt(v.speed) || !isStr(v.run_id)) {
    return undefined;
  }
  if (!isStr(v.state) || !(REPLAY_STATES as readonly string[]).includes(v.state)) return undefined;
  const error = nullable(v.error, isStr);
  const started = nullable(v.started_at, isStr);
  const ended = nullable(v.ended_at, isStr);
  if (error === undefined || started === undefined || ended === undefined) return undefined;
  const paused = optional(v.paused, false, isBool);
  const lap = v.lap === undefined ? null : nullable(v.lap, isInt);
  const note = v.note === undefined ? null : nullable(v.note, isStr);
  const pausedAt = v.paused_at === undefined ? null : nullable(v.paused_at, isStr);
  if (paused === undefined || lap === undefined || note === undefined || pausedAt === undefined) {
    return undefined;
  }
  return {
    season: v.season,
    round: v.round,
    speed: v.speed,
    run_id: v.run_id,
    state: v.state as ReplayState,
    error,
    started_at: started,
    ended_at: ended,
    paused,
    lap,
    note,
    paused_at: pausedAt,
  };
}

export function toReplayStatus(v: unknown): ReplayStatus | undefined {
  if (!isObj(v) || !isBool(v.enabled) || !isInt(v.max_running)) return undefined;
  if (!Array.isArray(v.running) || !Array.isArray(v.recent)) return undefined;
  const running = v.running.map(toReplay);
  const recent = v.recent.map(toReplay);
  if (running.includes(undefined) || recent.includes(undefined)) return undefined;
  return {
    enabled: v.enabled,
    max_running: v.max_running,
    running: running as Replay[],
    recent: recent as Replay[],
  };
}

// ------------------------------------------------------------------ client
function detailOf(body: unknown): string | null {
  return isObj(body) && isStr(body.detail) ? body.detail : null;
}

export async function request<T>(
  path: string,
  parse: (v: unknown) => T | undefined,
  init: RequestInit & { okStatuses?: number[] } = {},
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError("API not reachable", null);
  }
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const ok = init.okStatuses ?? [200];
  if (!ok.includes(resp.status)) {
    throw new ApiError(detailOf(body) ?? `HTTP ${resp.status}`, resp.status);
  }
  const parsed = parse(body);
  if (parsed === undefined) throw new ApiError("unexpected response from the API", resp.status);
  return parsed;
}

export const racePath = (season: number, round: number): string => `/api/races/${season}/${round}`;

export const api = {
  races: (signal?: AbortSignal) => request("/api/races", toRaces, signal ? { signal } : {}),
  /** Health answers 503 with the same body when a dependency is down; both are fine here. */
  health: (signal?: AbortSignal) =>
    request("/api/health", toHealth, { okStatuses: [200, 503], ...(signal ? { signal } : {}) }),
  state: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/state`, toSnapshot, signal ? { signal } : {}),
  /** Display-only entrants (team names, colours, car numbers); 404 when the lake has none. */
  entrants: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/entrants`, toEntrants, signal ? { signal } : {}),
  /** Display-only post-race analysis views (Feature 2); 404 when the lake has none for the race. */
  analysisLaps: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/analysis/laps`, toLapsDoc, signal ? { signal } : {}),
  analysisStints: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/analysis/stints`, toStintsDoc, signal ? { signal } : {}),
  analysisPitStops: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/analysis/pitstops`, toPitStopsDoc, signal ? { signal } : {}),
  analysisRaceControl: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/analysis/race-control`, toRaceControlDoc, signal ? { signal } : {}),
  analysisPositions: (season: number, round: number, signal?: AbortSignal) =>
    request(`${racePath(season, round)}/analysis/positions`, toPositionsDoc, signal ? { signal } : {}),
  compare: (season: number, round: number, a: string, b: string, signal?: AbortSignal) =>
    request(
      `${racePath(season, round)}/analysis/compare?${new URLSearchParams({ a, b }).toString()}`,
      toCompare,
      signal ? { signal } : {},
    ),
  /** Display-only telemetry traces (Feature 6, 2024 only; any other season is a 404). */
  telemetryLaps: (season: number, round: number, driver: string, signal?: AbortSignal) =>
    request(
      `${racePath(season, round)}/telemetry/laps?${new URLSearchParams({ driver }).toString()}`,
      toTelemetryLaps,
      signal ? { signal } : {},
    ),
  telemetryCompare: (
    season: number,
    round: number,
    a: { code: string; lap: number },
    b: { code: string; lap: number },
    signal?: AbortSignal,
  ) =>
    request(
      `${racePath(season, round)}/telemetry/compare?${new URLSearchParams({
        a: a.code,
        alap: String(a.lap),
        b: b.code,
        blap: String(b.lap),
      }).toString()}`,
      toTelemetryCompare,
      signal ? { signal } : {},
    ),
  replays: (signal?: AbortSignal) => request("/api/replays", toReplayStatus, signal ? { signal } : {}),
  startReplay: (season: number, round: number, speed: ReplaySpeed) =>
    request(`${racePath(season, round)}/replay`, toReplay, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed }),
      okStatuses: [202],
    }),
  /** Replay controls (Feature 7); each is a 409 when no replay of the race is running. */
  stopReplay: (season: number, round: number) =>
    request(`${racePath(season, round)}/replay/stop`, toReplay, { method: "POST" }),
  pauseReplay: (season: number, round: number) =>
    request(`${racePath(season, round)}/replay/pause`, toReplay, { method: "POST" }),
  resumeReplay: (season: number, round: number) =>
    request(`${racePath(season, round)}/replay/resume`, toReplay, { method: "POST" }),
  setReplaySpeed: (season: number, round: number, speed: ReplaySpeed) =>
    request(`${racePath(season, round)}/replay/speed`, toReplay, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed }),
    }),
  postLatency: async (eventId: string, uiRenderedAtMs: number): Promise<number> => {
    try {
      const resp = await fetch(`${API_URL}/api/debug/latency`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, ui_rendered_at_ms: Math.round(uiRenderedAtMs) }),
      });
      return resp.status;
    } catch {
      return 0;
    }
  },
  eventsUrl: (season: number, round: number) => `${API_URL}${racePath(season, round)}/events`,
};
