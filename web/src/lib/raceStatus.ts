/** The race-status banner (Feature 5, display only): GREEN / SC / VSC / RED FLAG at leader lap N,
 * from information up to lap N only. Live it comes from ``GET /api/races/{s}/{r}/status?lap=N``;
 * post-race from the bundle's ``status`` (schema v2), built by the same server function. With race
 * control in the lake the source is ``track_status`` (the leader's track-status codes and the latest
 * key race-control message with lap ≤ N); otherwise (the sample) it is ``estimated`` from lap times,
 * which cannot tell SC from VSC (``neutralised``). The lap event's batch flags are never used. */

import { racePath, request } from "./api";
import { isInt, isObj, isStr, nullable } from "./guard";

export const RACE_STATUSES = ["green", "sc", "vsc", "red", "neutralised", "unknown"] as const;
export type RaceStatusKind = (typeof RACE_STATUSES)[number];
export type RaceStatusSource = "track_status" | "estimated" | "none";

export interface RaceStatus {
  lap: number;
  status: RaceStatusKind;
  source: RaceStatusSource;
  message: string | null;
  messageLap: number | null;
}

export const STATUS_LABEL: Record<RaceStatusKind, string> = {
  green: "GREEN",
  sc: "SC",
  vsc: "VSC",
  red: "RED FLAG",
  neutralised: "SC / VSC",
  unknown: "UNKNOWN",
};

/** What the banner's text code means in words (screen readers and the title). */
export const STATUS_WORDS: Record<RaceStatusKind, string> = {
  green: "green flag, racing",
  sc: "safety car",
  vsc: "virtual safety car",
  red: "red flag, session stopped",
  neutralised: "neutralised (safety car or virtual safety car, estimated)",
  unknown: "status not known yet",
};

export const SOURCE_TEXT: Record<RaceStatusSource, string> = {
  track_status: "from the track-status feed and race control (laps up to now)",
  estimated: "estimated from lap times (no race-control feed for this race)",
  none: "not enough laps yet to estimate",
};

export function toRaceStatus(v: unknown): RaceStatus | undefined {
  if (!isObj(v) || !isInt(v.lap) || v.lap < 1) return undefined;
  if (!isStr(v.status) || !(RACE_STATUSES as readonly string[]).includes(v.status)) return undefined;
  if (v.source !== "track_status" && v.source !== "estimated" && v.source !== "none") return undefined;
  const message = nullable(v.message, isStr);
  const messageLap = nullable(v.message_lap, isInt);
  if (message === undefined || messageLap === undefined) return undefined;
  return { lap: v.lap, status: v.status as RaceStatusKind, source: v.source, message, messageLap };
}

/** The polite announcement for a new status, or null when the status did not change (a new lap or
 * message with the same status is not announced). The first known status is announced only when it
 * is not green (a race that starts green has nothing to report); "unknown" is never announced. */
export function statusAnnouncement(previous: RaceStatus | null, next: RaceStatus | null): string | null {
  if (next === null || next.status === "unknown") return null;
  const before = previous === null || previous.status === "unknown" ? null : previous.status;
  if (before === next.status) return null;
  if (before === null && next.status === "green") return null;
  return `Race status: ${STATUS_WORDS[next.status]}, lap ${next.lap}.`;
}

/** ``GET /api/races/{s}/{r}/status?lap=N`` (the leader's latest lap when ``lap`` is omitted). */
export function fetchRaceStatus(season: number, round: number, lap: number | null, signal?: AbortSignal): Promise<RaceStatus> {
  const q = lap === null ? "" : `?lap=${lap}`;
  return request(`${racePath(season, round)}/status${q}`, toRaceStatus, signal ? { signal } : {});
}
