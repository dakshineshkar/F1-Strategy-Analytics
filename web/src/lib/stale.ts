/** Cars that stopped sending timing (display only, pure).
 *
 * The client receives no "retired" signal: the driver, tyre and timing hashes, the lap / pit / alert events,
 * the entrants and the engineer view carry none, and race control is in the full-race analysis only (using it
 * live would show the future). So a car is **stale** when the leader has completed ``STALE_LAPS`` or more laps
 * since that car's last crossing, after allowing for the laps the car is down: a lapped car that is still
 * racing keeps crossing the line and is never stale.
 *
 * A stale car keeps its row (never deleted), sorted to the bottom, and its last values stay in the Redis hash,
 * including an ``undercut_flag`` from its last decision (2024 R5: Bottas after lap 19). The race view excludes
 * stale cars from the call and the pairs flagged now. Nothing here feeds the model, the rule, the live features
 * or the what-if, and the reducer is unchanged. */

import { type DriverRow, lapsDown, type RaceState, towerRows } from "./reducer";

/** Leader laps since a car's last crossing (beyond the laps it is down) before it counts as stale. */
export const STALE_LAPS = 2;

/** The leader: the first car in the order with a lap (the reducer's ``lapsDown`` uses the same rule). */
function leaderOf(state: RaceState): DriverRow | null {
  const id = state.order.find((d) => state.drivers[d]?.lap !== null && state.drivers[d]?.lap !== undefined);
  return id === undefined ? null : (state.drivers[id] ?? null);
}

/** The leader's lap: the reducer's ``maxLap`` (lap events), or, for a page that has only a snapshot so far (a
 * late join, before the next crossing), the highest lap the snapshot gave the cars. 0 before lap 1. */
export function leaderLap(state: RaceState): number {
  let lap = state.maxLap;
  for (const r of Object.values(state.drivers)) if (r.lap !== null && r.lap > lap) lap = r.lap;
  return lap;
}

/** Laps the car is down on the leader: the reducer's ``lapsDown`` (from the crossings this page received),
 * or, when that history is missing (a page opened mid-race), the car's gap to the leader in whole leader lap
 * times. A gap to the leader is measured at the same lap number, so a car one lap down has a gap of at least
 * one lap time. */
export function lapsBehind(state: RaceState, driverId: string): number {
  const fromHistory = lapsDown(state, driverId);
  const row = state.drivers[driverId];
  const leader = leaderOf(state);
  const lapS = leader?.lastLapTimeS ?? null;
  if (row === undefined || row.gapLeaderS === null || lapS === null || lapS <= 0) return fromHistory;
  return Math.max(fromHistory, Math.floor(row.gapLeaderS / lapS));
}

/** The car's last lap when it is stale (the leader completed ``STALE_LAPS`` or more laps since that car's
 * last crossing, beyond the laps it is down), else null. The leader and a car without a lap are never stale. */
export function staleSince(state: RaceState, driverId: string): number | null {
  const row = state.drivers[driverId];
  const leader = leaderOf(state);
  if (row === undefined || row.lap === null || leader === null || leader.driverId === driverId) return null;
  return leaderLap(state) - row.lap - lapsBehind(state, driverId) >= STALE_LAPS ? row.lap : null;
}

/** Every stale car's id. */
export function staleIds(state: RaceState): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(state.drivers)) if (staleSince(state, id) !== null) out.add(id);
  return out;
}

/** The tower's rows: the order, with the stale cars moved to the bottom in their own order. No row is
 * dropped. */
export function displayRows(state: RaceState, stale: ReadonlySet<string> = staleIds(state)): DriverRow[] {
  const rows = towerRows(state);
  return [...rows.filter((r) => !stale.has(r.driverId)), ...rows.filter((r) => stale.has(r.driverId))];
}

export interface LapProgress {
  /** the leader's lap */
  lap: number;
  /** running cars that have crossed the line on that lap (the leader included) */
  crossed: number;
  /** cars on the tower that are not stale */
  running: number;
}

/** How far the field is through the leader's lap ("lap 20 · 2 of 20 crossed"), or null before lap 1. */
export function lapProgress(state: RaceState, stale: ReadonlySet<string> = staleIds(state)): LapProgress | null {
  const rows = towerRows(state).filter((r) => !stale.has(r.driverId));
  const lap = Math.max(0, ...rows.map((r) => r.lap ?? 0));
  if (lap < 1) return null;
  return { lap, crossed: rows.filter((r) => r.lap === lap).length, running: rows.length };
}
