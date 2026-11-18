/** Replay helpers (pure): API errors and replay states as text, and which controls apply. */

import { ApiError, type Replay, type ReplaySpeed, type ReplayStatus } from "./api";

export type Speed = ReplaySpeed;
export const SPEEDS: readonly Speed[] = [1, 10, 60];

export function replayMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return err.message.includes("disabled") ? "Replay is disabled on the API (ENABLE_REPLAY=1)." : err.message;
    if (err.status === 409) return err.message;
    if (err.status === 503) return err.message.includes("old keys") ? err.message : "The clean zone is not available right now.";
    if (err.status === null) return "The API is not reachable.";
    return err.message;
  }
  return "Unexpected error.";
}

/** The replay of this race to show: the running one, else the most recent one. */
export function replayFor(status: ReplayStatus | null, season: number, round: number): Replay | null {
  if (!status) return null;
  const same = (r: Replay) => r.season === season && r.round === round;
  return status.running.find(same) ?? status.recent.find(same) ?? null;
}

/** Starting, running or paused: the replay still holds its processes and can be controlled. */
export function isActive(replay: Replay | null): boolean {
  return replay !== null && (replay.state === "starting" || replay.state === "running" || replay.state === "paused");
}

export function replayStatusText(current: Replay | null, anyRunning: boolean, enabled: boolean | null): string {
  if (enabled === false) return "Replay is disabled on the API.";
  if (current?.state === "starting") {
    return current.paused ? `Starting (paused, ${current.speed}×): waiting for the stream job…` : "Starting: waiting for the stream job…";
  }
  if (current?.state === "running") return `Running at ${current.speed}×.`;
  if (current?.state === "paused") {
    return current.lap === null ? `Paused (${current.speed}×).` : `Paused at lap ${current.lap} (${current.speed}×).`;
  }
  if (anyRunning) return "Another race is replaying.";
  if (current?.state === "finished") return "Finished.";
  if (current?.state === "stopped") {
    const where = current.lap === null ? "Stopped before the first lap" : `Stopped at lap ${current.lap}`;
    return current.note ? `${where} (${current.note}).` : `${where}.`;
  }
  if (current?.state === "failed") return `Failed: ${current.error ?? "unknown error"}`;
  return "Idle.";
}

/** The lap reached by an active replay, shown next to the status (not a live region: it changes
 * every lap, and only state changes are announced). */
export function replayLapText(current: Replay | null): string {
  if (!isActive(current) || current === null) return "";
  return current.lap === null ? "No lap sent yet." : `Lap ${current.lap} sent.`;
}

export interface ReplayControls {
  /** Start a new replay of this race. */
  canStart: boolean;
  /** Pause or resume (one button) this race's replay. */
  canPause: boolean;
  /** The label of that button. */
  pauseLabel: "Pause" | "Resume";
  canStop: boolean;
  /** The speed radios are usable (before a start, or to change a running replay's speed). */
  canChangeSpeed: boolean;
  /** The speed the radios show: the API's while this race replays, else the chosen one. */
  shownSpeed: Speed;
}

const asSpeed = (v: number, fallback: Speed): Speed => (SPEEDS as readonly number[]).includes(v) ? (v as Speed) : fallback;

/**
 * Which controls apply. ``anyRunning`` is true while any replay (this race's or another's) holds
 * the slot; ``pending`` while a request of this panel is in flight (nothing else is offered then).
 */
export function replayControls(
  current: Replay | null,
  anyRunning: boolean,
  enabled: boolean | null,
  pending: boolean,
  chosen: Speed,
): ReplayControls {
  const active = isActive(current);
  const usable = enabled !== false && !pending;
  return {
    canStart: usable && !active && !anyRunning,
    canPause: usable && active,
    pauseLabel: active && current?.paused ? "Resume" : "Pause",
    canStop: usable && active,
    canChangeSpeed: usable && (active || !anyRunning),
    shownSpeed: active && current ? asSpeed(current.speed, chosen) : chosen,
  };
}

/** Which run of this race the live view belongs to. The first status read only records the run
 * shown; each later new run id (a new replay started, from this page or elsewhere) bumps
 * ``generation``, so the live stream resets and reloads ``/state``: the API deleted the race's old
 * keys at that start, and the tower must not keep the earlier run's laps. */
export interface RunTracker {
  seen: boolean;
  runId: string | null;
  generation: number;
}

export const INITIAL_RUN: RunTracker = { seen: false, runId: null, generation: 0 };

export function trackRun(t: RunTracker, loaded: boolean, runId: string | null): RunTracker {
  if (!loaded) return t;
  if (!t.seen) return { seen: true, runId, generation: t.generation };
  if (runId !== null && runId !== t.runId) return { seen: true, runId, generation: t.generation + 1 };
  return t;
}
