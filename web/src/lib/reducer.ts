/** The one race reducer: a pure function from (state, action) to state. Components only render it.
 *
 * Sources of truth:
 * - **Snapshot**: the 9 hash fields, the order sorted set and the additive tyre / timing hashes
 *   from Redis. It is pushed by the API on
 *   the SSE stream (an ``event: snapshot`` after connect and once per leader lap, never polled),
 *   and loaded from ``GET /state`` on a reconnect. It replaces the tower values (stale
 *   ``undercut_flag`` / ``undercut_prob`` included) and the order, and keeps the client-built lap
 *   history and alert groups (Pub/Sub has no history, so they cannot be reloaded).
 *   The connect snapshot (F09) also brings the alerts the API received before this page subscribed
 *   (``recentAlerts``): each joins its pair's group marked ``history``, deduplicated by ``event_id``
 *   with the live alerts, and never touches the rows (the hashes already hold the flags).
 * - **SSE events** between snapshots:
 *   - `lap` updates the driver's latest lap, compound, tyre age and last lap time. Gaps come from
 *     ``race_time_s`` at the same lap number, the ``timing_gaps`` definition the stream job uses:
 *     the leader is the car with Jolpica position 1, and the car ahead has position − 1.
 *   - The order follows the stream job's live rank (``live_state.live_order``): laps completed
 *     desc, then crossing time, then Jolpica position. A page that opens (or reconnects) mid-lap
 *     knows the crossing times only of the laps it saw arrive, so the snapshot's order sorted set
 *     ranks every crossing the snapshot already holds (F37): within one lap number those cars come
 *     first, in zset order, and the cars whose crossing arrived after the snapshot follow by
 *     crossing time. The car's lap in the snapshot is the lap of its timing (else tyre) hash.
 *   - `pit_in` / `pit_out` mark the car in the pit lane, `undercut_alert` updates the
 *     (attacker, defender) group, and `session_end` closes the race.
 *
 * Robustness: malformed messages, other races' messages and duplicate event ids change nothing but
 * counters. A lap older than the driver's latest one goes into the history only, so the tower never
 * regresses. An unknown driver gets a row. Nothing in here throws on input. */

import { announcementFor } from "./announce";
import type { Compound, RaceSnapshot } from "./api";
import { type AlertEvent, type LapEvent, parseEvent, type PitEvent, type RaceEvent } from "./events";
import { NO_TIMING, type TimingHash, type TimingValues } from "./timing";

export const HISTORY_LAPS = 20;
export const MAX_SEEN_IDS = 5000;
export const MAX_ANNOUNCEMENTS = 5;

export type Connection = "connecting" | "connected" | "reconnecting" | "closed";

export interface DriverRow {
  driverId: string;
  position: number | null;
  gapAheadS: number | null;
  gapLeaderS: number | null;
  lastLapTimeS: number | null;
  compound: Compound;
  /** Inferred stint age (the model's value; assumes a new set in full mode). */
  tyreAgeLaps: number | null;
  /** Real tyre life (TracingInsights; display only), the lap it belongs to, and the laps already on
   * the set when the stint began. Null when unknown. */
  tyreLifeLaps: number | null;
  tyreLifeAtStartLaps: number | null;
  tyreLifeLap: number | null;
  undercutFlag: boolean;
  undercutProb: number | null;
  /** Latest lap seen on the stream (null until the first lap event). */
  lap: number | null;
  raceTimeS: number | null;
  jolpicaPosition: number | null;
  inPit: boolean;
  /** Pit stops so far: the stream's count (lap payload / timing hash) when known, else the
   * ``pit_in`` events seen since the page connected. */
  stops: number;
  lastPitLap: number | null;
  /** Feature 5 tower values of the car's lap ``timingLap`` (display only). */
  timing: TimingValues;
  timingLap: number | null;
  /** True once the driver appeared in a snapshot. */
  known: boolean;
  /** The car's index in the latest snapshot's order sorted set when that snapshot holds the car's
   * latest crossing (``lap``); null when that crossing arrived after the snapshot, or without a
   * lap. Ranks the cars whose crossing time this page never saw (F37). */
  snapshotRank: number | null;
}

export interface LapPoint {
  raceTimeS: number;
  position: number | null;
  lapTimeS: number | null;
}

export interface AlertGroup {
  key: string;
  attackerId: string;
  defenderId: string;
  reason: AlertEvent["reason"];
  trigger: AlertEvent["trigger"];
  prob: number;
  threshold: number;
  decisionLap: number;
  gapS: number;
  count: number;
  /** Increases with every alert, so the feed can sort newest first. */
  seq: number;
  /** F09: the group's latest alert came from a connect snapshot's history, not live: ``before_open`` (the
   * page's first snapshot: received by the API before this page opened) or ``while_away`` (a reconnect's
   * snapshot: received while the page was disconnected). Never "new". Null or absent for a live alert. */
  history?: AlertHistory | null;
}

export type AlertHistory = "before_open" | "while_away";

export interface Announcement {
  id: string;
  text: string;
}

export interface RaceState {
  season: number;
  round: number;
  drivers: Record<string, DriverRow>;
  order: string[];
  /** lap -> driver -> crossing, for the gap chart (the last ``HISTORY_LAPS`` laps). */
  history: Record<number, Record<string, LapPoint>>;
  maxLap: number;
  alerts: Record<string, AlertGroup>;
  alertSeq: number;
  announcements: Announcement[];
  connection: Connection;
  sessionEnded: boolean;
  malformed: number;
  foreign: number;
  duplicates: number;
  unknownDrivers: number;
  seen: string[];
  lastEvent: { id: string; type: RaceEvent["type"] } | null;
  snapshots: number;
}

export type RaceAction =
  | { type: "snapshot"; data: RaceSnapshot }
  | { type: "event"; raw: string }
  | { type: "connection"; status: Connection }
  | { type: "reset"; season: number; round: number };

export function initialState(season: number, round: number): RaceState {
  return {
    season,
    round,
    drivers: {},
    order: [],
    history: {},
    maxLap: 0,
    alerts: {},
    alertSeq: 0,
    announcements: [],
    connection: "connecting",
    sessionEnded: false,
    malformed: 0,
    foreign: 0,
    duplicates: 0,
    unknownDrivers: 0,
    seen: [],
    lastEvent: null,
    snapshots: 0,
  };
}

function emptyRow(driverId: string): DriverRow {
  return {
    driverId,
    position: null,
    gapAheadS: null,
    gapLeaderS: null,
    lastLapTimeS: null,
    compound: "UNKNOWN",
    tyreAgeLaps: null,
    tyreLifeLaps: null,
    tyreLifeAtStartLaps: null,
    tyreLifeLap: null,
    undercutFlag: false,
    undercutProb: null,
    lap: null,
    raceTimeS: null,
    jolpicaPosition: null,
    inPit: false,
    stops: 0,
    lastPitLap: null,
    timing: NO_TIMING,
    timingLap: null,
    known: false,
    snapshotRank: null,
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Positions 1..n from ``order``, written into the rows. */
function withPositions(drivers: Record<string, DriverRow>, order: string[]): Record<string, DriverRow> {
  const out: Record<string, DriverRow> = { ...drivers };
  order.forEach((id, i) => {
    const row = out[id];
    if (row && row.position !== i + 1) out[id] = { ...row, position: i + 1 };
  });
  return out;
}

/** The stream job's live rank for drivers with a lap; the others keep their previous order.
 *
 * Key: laps completed desc (a lapped car ranks by laps first); within one lap number the crossings
 * the latest snapshot holds (``snapshotRank`` set) before the ones that arrived after it, which
 * happened later; the former by zset rank, the latter by crossing time, then Jolpica position. */
export function liveOrder(drivers: Record<string, DriverRow>, previous: string[]): string[] {
  const timed = Object.values(drivers).filter((d) => d.lap !== null);
  timed.sort(
    (a, b) =>
      (b.lap ?? 0) - (a.lap ?? 0) ||
      Number(a.snapshotRank === null) - Number(b.snapshotRank === null) ||
      (a.snapshotRank !== null && b.snapshotRank !== null
        ? a.snapshotRank - b.snapshotRank
        : (a.raceTimeS ?? 0) - (b.raceTimeS ?? 0) ||
          (a.jolpicaPosition ?? 1e6) - (b.jolpicaPosition ?? 1e6)) ||
      a.driverId.localeCompare(b.driverId),
  );
  const ranked = timed.map((d) => d.driverId);
  const rankedSet = new Set(ranked);
  const rest = [
    ...previous.filter((id) => !rankedSet.has(id) && id in drivers),
    ...Object.keys(drivers)
      .filter((id) => !rankedSet.has(id) && !previous.includes(id))
      .sort(),
  ];
  return [...ranked, ...rest];
}

/** Gap to the leader and to the car ahead at ``lap`` (same lap number), from the history. */
export function gapsAt(
  history: RaceState["history"],
  lap: number,
  driverId: string,
): { leader: number | null; ahead: number | null } {
  const atLap = history[lap];
  const me = atLap?.[driverId];
  if (!atLap || !me) return { leader: null, ahead: null };
  const points = Object.values(atLap);
  const leader = points.find((p) => p.position === 1);
  const ahead =
    me.position !== null && me.position > 1
      ? points.find((p) => p.position === (me.position as number) - 1)
      : undefined;
  return {
    leader: leader ? round3(me.raceTimeS - leader.raceTimeS) : me.position === 1 ? 0 : null,
    ahead: me.position === 1 ? null : ahead ? round3(me.raceTimeS - ahead.raceTimeS) : null,
  };
}

function trimHistory(history: RaceState["history"], maxLap: number): RaceState["history"] {
  const minLap = maxLap - HISTORY_LAPS + 1;
  const out: RaceState["history"] = {};
  for (const [k, v] of Object.entries(history)) {
    if (Number(k) >= minLap) out[Number(k)] = v;
  }
  return out;
}

function ensureRow(state: RaceState, driverId: string): { row: DriverRow; unknown: boolean } {
  const row = state.drivers[driverId];
  return row ? { row, unknown: false } : { row: emptyRow(driverId), unknown: true };
}

function applyLap(state: RaceState, e: LapEvent): RaceState {
  const point: LapPoint = { raceTimeS: e.raceTimeS, position: e.position, lapTimeS: e.lapTimeS };
  const maxLap = Math.max(state.maxLap, e.lap);
  const history = trimHistory(
    { ...state.history, [e.lap]: { ...(state.history[e.lap] ?? {}), [e.driverId]: point } },
    maxLap,
  );
  const { row, unknown } = ensureRow(state, e.driverId);
  const drivers: Record<string, DriverRow> = { ...state.drivers };
  if (row.lap === null || e.lap >= row.lap) {
    drivers[e.driverId] = {
      ...row,
      lap: e.lap,
      raceTimeS: e.raceTimeS,
      jolpicaPosition: e.position,
      lastLapTimeS: e.lapTimeS,
      compound: e.compound,
      tyreAgeLaps: e.tyreAge,
      tyreLifeLaps: e.tyreLifeLaps,
      tyreLifeAtStartLaps: e.tyreLifeAtStartLaps,
      tyreLifeLap: e.lap,
      timing: e.timing,
      timingLap: e.lap,
      stops: e.timing.pitStops ?? row.stops,
      // the same lap as the snapshot's: the snapshot holds this crossing, its zset rank stays
      snapshotRank: row.lap !== null && e.lap === row.lap ? row.snapshotRank : null,
    };
  } else {
    drivers[e.driverId] = row; // an older lap: history only, the tower never regresses
  }
  // Recompute the gaps of every car whose latest lap is this lap (a late leader event fixes them).
  for (const [id, r] of Object.entries(drivers)) {
    if (r.lap !== e.lap) continue;
    const g = gapsAt(history, e.lap, id);
    drivers[id] = {
      ...r,
      gapLeaderS: g.leader ?? r.gapLeaderS,
      gapAheadS: r.jolpicaPosition === 1 ? null : (g.ahead ?? r.gapAheadS),
    };
  }
  const order = liveOrder(drivers, state.order);
  return {
    ...state,
    history,
    maxLap,
    drivers: withPositions(drivers, order),
    order,
    unknownDrivers: state.unknownDrivers + (unknown ? 1 : 0),
  };
}

function applyPit(state: RaceState, e: PitEvent): RaceState {
  const { row, unknown } = ensureRow(state, e.driverId);
  const next: DriverRow =
    e.type === "pit_in"
      ? { ...row, inPit: true, lastPitLap: e.lap, stops: row.stops + 1 }
      : { ...row, inPit: false };
  const drivers = { ...state.drivers, [e.driverId]: next };
  const order = unknown ? liveOrder(drivers, state.order) : state.order;
  return {
    ...state,
    drivers: unknown ? withPositions(drivers, order) : drivers,
    order,
    unknownDrivers: state.unknownDrivers + (unknown ? 1 : 0),
  };
}

export const alertKey = (attackerId: string, defenderId: string): string =>
  `${attackerId}>${defenderId}`;

function applyAlert(state: RaceState, e: AlertEvent): RaceState {
  const key = alertKey(e.attackerId, e.defenderId);
  const seq = state.alertSeq + 1;
  const previous = state.alerts[key];
  const group: AlertGroup = {
    key,
    attackerId: e.attackerId,
    defenderId: e.defenderId,
    reason: e.reason,
    trigger: e.trigger,
    prob: e.prob,
    threshold: e.threshold,
    decisionLap: e.decisionLap,
    gapS: e.gapS,
    count: (previous?.count ?? 0) + 1,
    seq,
    history: null,
  };
  const { row, unknown } = ensureRow(state, e.attackerId);
  let drivers: Record<string, DriverRow> = {
    ...state.drivers,
    [e.attackerId]: { ...row, undercutFlag: true, undercutProb: e.prob },
  };
  let order = state.order;
  if (unknown) {
    order = liveOrder(drivers, state.order);
    drivers = withPositions(drivers, order);
  }
  const text = announcementFor(e);
  const announcements = text
    ? [...state.announcements, { id: e.eventId, text }].slice(-MAX_ANNOUNCEMENTS)
    : state.announcements;
  return {
    ...state,
    alerts: { ...state.alerts, [key]: group },
    alertSeq: seq,
    drivers,
    order,
    announcements,
    unknownDrivers: state.unknownDrivers + (unknown ? 1 : 0),
  };
}

/** F09: one alert from the connect snapshot's history. It only updates its pair's group (count, seq, the
 * decision lap and gap of the alert): the snapshot's driver hashes already hold the current flags, so the
 * rows are not touched, nothing is announced (it is not news), and no row is created for an unknown car. */
function applyHistoryAlert(state: RaceState, e: AlertEvent, kind: AlertHistory): RaceState {
  const key = alertKey(e.attackerId, e.defenderId);
  const seq = state.alertSeq + 1;
  const previous = state.alerts[key];
  const group: AlertGroup = {
    key,
    attackerId: e.attackerId,
    defenderId: e.defenderId,
    reason: e.reason,
    trigger: e.trigger,
    prob: e.prob,
    threshold: e.threshold,
    decisionLap: e.decisionLap,
    gapS: e.gapS,
    count: (previous?.count ?? 0) + 1,
    seq,
    history: kind,
  };
  return { ...state, alerts: { ...state.alerts, [key]: group }, alertSeq: seq };
}

/** F09: the connect snapshot's alert history, oldest first, after the snapshot's state. Deduplicated by
 * ``event_id`` against every event this page applied (``seen``), so an alert that also arrives live, or
 * again in the history of a later reconnect's snapshot, is counted once. */
function applyRecentAlerts(state: RaceState, alerts: readonly AlertEvent[], kind: AlertHistory): RaceState {
  let next = state;
  for (const e of alerts) {
    if (e.season !== state.season || e.round !== state.round || next.seen.includes(e.eventId)) continue;
    next = { ...applyHistoryAlert(next, e, kind), seen: remember(next.seen, e.eventId) };
  }
  return next;
}

function timingValues(t: TimingHash): TimingValues {
  const { sectors, pbSectors, speedTrapKph, pbSpeedTrapKph, pitStops } = t;
  return { sectors, pbSectors, speedTrapKph, pbSpeedTrapKph, pitStops };
}

function applySnapshot(state: RaceState, data: RaceSnapshot): RaceState {
  if (data.season !== state.season || data.round !== state.round) {
    return { ...state, foreign: state.foreign + 1 };
  }
  // ranks of an older snapshot are never compared with this one's
  const drivers: Record<string, DriverRow> = {};
  for (const [id, r] of Object.entries(state.drivers)) {
    drivers[id] = r.snapshotRank === null ? r : { ...r, snapshotRank: null };
  }
  for (const [id, h] of Object.entries(data.drivers)) {
    const row = drivers[id] ?? emptyRow(id);
    // the tyre hash carries its lap: never let an older one replace what a newer lap event set
    const t = data.tyres[id];
    const tyre =
      t !== undefined && (row.tyreLifeLap === null || t.lap >= row.tyreLifeLap)
        ? { tyreLifeLaps: t.tyre_life_laps, tyreLifeAtStartLaps: t.tyre_life_at_start_laps, tyreLifeLap: t.lap }
        : {};
    // the timing hash likewise (Feature 5): its lap guards against an older value
    const tm = data.timing[id];
    const timing =
      tm !== undefined && (row.timingLap === null || tm.lap >= row.timingLap)
        ? { timing: timingValues(tm), timingLap: tm.lap, stops: tm.pitStops ?? row.stops }
        : {};
    drivers[id] = {
      ...row,
      ...tyre,
      ...timing,
      known: true,
      gapAheadS: h.gap_ahead_s,
      gapLeaderS: h.gap_leader_s,
      lastLapTimeS: h.last_lap_time_s,
      compound: h.tyre_compound,
      tyreAgeLaps: h.tyre_age_laps,
      undercutFlag: h.undercut_flag,
      undercutProb: h.undercut_prob,
    };
  }
  // The order sorted set is authoritative; drivers it does not (yet) hold follow in their old order.
  const zset = [...data.order].sort((a, b) => a.position - b.position).map((o) => o.driver_id);
  for (const id of zset) if (!(id in drivers)) drivers[id] = { ...emptyRow(id), known: true };
  // F37: the car's latest lap per the snapshot (timing hash, else tyre hash). A newer lap than this
  // page saw has no crossing time here; the same lap is a crossing the snapshot holds. Either way
  // the zset ranks it. An older lap, or no hash, leaves the row as it is.
  zset.forEach((id, idx) => {
    const row = drivers[id] as DriverRow;
    const hashLap = data.timing[id]?.lap ?? data.tyres[id]?.lap;
    if (hashLap === undefined) return;
    if (row.lap === null || hashLap > row.lap) {
      drivers[id] = { ...row, lap: hashLap, raceTimeS: null, jolpicaPosition: null, snapshotRank: idx };
    } else if (hashLap === row.lap) {
      drivers[id] = { ...row, snapshotRank: idx };
    }
  });
  const inZset = new Set(zset);
  const rest = [
    ...state.order.filter((id) => !inZset.has(id) && id in drivers),
    ...Object.keys(drivers)
      .filter((id) => !inZset.has(id) && !state.order.includes(id))
      .sort(),
  ];
  const order = [...zset, ...rest];
  return {
    ...state,
    drivers: withPositions(drivers, order),
    order,
    snapshots: state.snapshots + 1,
  };
}

function remember(seen: string[], id: string): string[] {
  const next = [...seen, id];
  return next.length > MAX_SEEN_IDS ? next.slice(next.length - MAX_SEEN_IDS) : next;
}

function applyEvent(state: RaceState, raw: string): RaceState {
  const e = parseEvent(raw);
  if (e === null) return { ...state, malformed: state.malformed + 1 };
  if (e.season !== state.season || e.round !== state.round) {
    return { ...state, foreign: state.foreign + 1 };
  }
  if (state.sessionEnded) return { ...state, foreign: state.foreign + 1 };
  // Snapshots replace state; their ids repeat across connections, so they are not deduplicated. The
  // connect snapshot's alert history (F09) is, item by item.
  if (e.type === "snapshot") {
    // the page's first snapshot holds what came before it opened; a later one, what it missed while away
    const kind: AlertHistory = state.snapshots === 0 ? "before_open" : "while_away";
    const next = applyRecentAlerts(applySnapshot(state, e.data), e.recentAlerts, kind);
    return e.recentDropped > 0 ? { ...next, malformed: next.malformed + e.recentDropped } : next;
  }
  if (state.seen.includes(e.eventId)) return { ...state, duplicates: state.duplicates + 1 };
  let next: RaceState;
  switch (e.type) {
    case "lap":
      next = applyLap(state, e);
      break;
    case "pit_in":
    case "pit_out":
      next = applyPit(state, e);
      break;
    case "undercut_alert":
      next = applyAlert(state, e);
      break;
    case "session_end":
      next = { ...state, sessionEnded: true, connection: "closed" };
      break;
  }
  return { ...next, seen: remember(state.seen, e.eventId), lastEvent: { id: e.eventId, type: e.type } };
}

export function raceReducer(state: RaceState, action: RaceAction): RaceState {
  switch (action.type) {
    case "snapshot":
      return applySnapshot(state, action.data);
    case "event":
      return applyEvent(state, action.raw);
    case "connection":
      if (state.sessionEnded) return state.connection === "closed" ? state : { ...state, connection: "closed" };
      return state.connection === action.status ? state : { ...state, connection: action.status };
    case "reset":
      return initialState(action.season, action.round);
  }
}

/** Tower rows in display order (unknown ids in ``order`` are skipped). */
export function towerRows(state: RaceState): DriverRow[] {
  return state.order.map((id) => state.drivers[id]).filter((r): r is DriverRow => r !== undefined);
}

/** Alert groups, newest first. */
export function alertGroups(state: RaceState): AlertGroup[] {
  return Object.values(state.alerts).sort((a, b) => b.seq - a.seq);
}

/** Laps a car is down on the leader. A car is ``k`` laps down when the leader completed lap
 * ``car.lap + k`` before the car completed ``car.lap``: being a lap number behind while the
 * leader has just crossed the line first is not "lapped". Uses the crossings in the history. */
export function lapsDown(state: RaceState, driverId: string): number {
  const row = state.drivers[driverId];
  const leaderId = state.order.find((id) => state.drivers[id]?.lap !== null);
  if (!row || row.lap === null || row.raceTimeS === null || !leaderId || leaderId === driverId) return 0;
  let k = 0;
  for (;;) {
    const leaderCrossing = state.history[row.lap + k + 1]?.[leaderId];
    if (!leaderCrossing || leaderCrossing.raceTimeS >= row.raceTimeS) return k;
    k += 1;
  }
}
