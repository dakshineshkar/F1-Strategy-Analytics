/** Feature 5 timing-tower helpers (pure, display only): the race's best so far, the PB / OB marks,
 * the columns with their presets, and the per-browser preferences (visible columns, pinned car).
 *
 * **No hindsight.** Each car's personal bests (PB) are computed by the producer over that car's own
 * laps up to its latest lap, so every PB is about a lap that has already happened. The overall
 * best so far (OB) is the best PB of the cars on the tower: it changes only when a car completes a
 * lap, never because of a later lap. */

import { DASH } from "./format";
import { isDriverId } from "./guard";
import type { DriverRow } from "./reducer";

export const SECTORS = [0, 1, 2] as const;
export type SectorIndex = (typeof SECTORS)[number];

export interface Best {
  value: number;
  driverId: string;
}

export interface BestSoFar {
  sectors: readonly [Best | null, Best | null, Best | null];
  speedTrap: Best | null;
}

/** The race's best S1 / S2 / S3 (minimum) and speed trap (maximum) so far, from the cars' bests.
 * A tie keeps the driver that comes first in ``rows`` (the tower order). */
export function bestSoFar(rows: readonly DriverRow[]): BestSoFar {
  const sectors: (Best | null)[] = [null, null, null];
  let trap: Best | null = null;
  for (const r of rows) {
    for (const i of SECTORS) {
      const v = r.timing.pbSectors[i];
      const cur = sectors[i] ?? null;
      if (v !== null && (cur === null || v < cur.value)) sectors[i] = { value: v, driverId: r.driverId };
    }
    const t = r.timing.pbSpeedTrapKph;
    if (t !== null && (trap === null || t > trap.value)) trap = { value: t, driverId: r.driverId };
  }
  return { sectors: [sectors[0] ?? null, sectors[1] ?? null, sectors[2] ?? null], speedTrap: trap };
}

export type Mark = "OB" | "PB" | null;

/** PB / OB tags start on this lap: on lap 1 every car's first sector time is trivially its own best and one of
 * them is the overall best, so twenty tags would say nothing. */
export const MARKS_FROM_LAP = 2;

/** The lap the car's timing values belong to (the timing hash's lap, else the car's latest lap). */
const marksShown = (row: Pick<DriverRow, "timingLap" | "lap">): boolean => (row.timingLap ?? row.lap ?? 0) >= MARKS_FROM_LAP;

/** "OB" when the car's last-lap value equals the race's best so far, "PB" when it equals its own
 * best so far (it set or equalled it on that lap), else null. OB beats PB. None before lap 2. */
export function sectorMark(row: DriverRow, i: SectorIndex, best: BestSoFar): Mark {
  const v = row.timing.sectors[i];
  if (v === null || !marksShown(row)) return null;
  if (best.sectors[i] !== null && v === best.sectors[i]?.value) return "OB";
  return v === row.timing.pbSectors[i] ? "PB" : null;
}

export function trapMark(row: DriverRow, best: BestSoFar): Mark {
  const v = row.timing.speedTrapKph;
  if (v === null || !marksShown(row)) return null;
  if (best.speedTrap !== null && v === best.speedTrap.value) return "OB";
  return v === row.timing.pbSpeedTrapKph ? "PB" : null;
}

export const MARK_WORDS: Record<Exclude<Mark, null>, string> = {
  OB: "overall best so far",
  PB: "personal best so far",
};

export const sectorTime = (s: number | null): string => (s === null ? DASH : s.toFixed(3));
export const speed = (kph: number | null): string => (kph === null ? DASH : kph.toFixed(0));

/** True when no car on the tower has a sector time or speed trap (e.g. the sample, no TI). */
export const noSectorData = (rows: readonly DriverRow[]): boolean =>
  rows.every((r) => r.timing.sectors.every((x) => x === null) && r.timing.speedTrapKph === null);

// ------------------------------------------------------------------ columns and presets
/** Canonical column order. Undercut % sits next to the driver, so the call's number is never the column a
 * narrow screen scrolls away (critique F01). */
export const COLUMNS = [
  { id: "undercut", label: "Undercut" },
  { id: "int", label: "Int" },
  { id: "gap", label: "Gap" },
  { id: "last", label: "Last lap" },
  { id: "s1", label: "S1" },
  { id: "s2", label: "S2" },
  { id: "s3", label: "S3" },
  { id: "trap", label: "Trap" },
  { id: "pits", label: "Pits" },
  { id: "tyre", label: "Tyre" },
  { id: "age", label: "Age" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);
/** Position and driver are always shown (the row's identity). */
export const FIXED_COLUMNS = ["Pos", "Driver"] as const;

export const PRESETS = {
  minimal: ["undercut", "gap", "last", "tyre"],
  full: COLUMN_IDS,
} as const satisfies Record<string, readonly ColumnId[]>;
export type PresetId = keyof typeof PRESETS;
export const PRESET_LABEL: Record<PresetId, string> = { minimal: "Minimal", full: "Full" };
export const DEFAULT_COLUMNS: readonly ColumnId[] = PRESETS.full;

const isColumnId = (v: unknown): v is ColumnId => typeof v === "string" && (COLUMN_IDS as readonly string[]).includes(v);

/** ``visible`` in the canonical column order, without duplicates or unknown ids. */
export function normaliseColumns(visible: readonly string[]): ColumnId[] {
  const set = new Set(visible.filter(isColumnId));
  return COLUMN_IDS.filter((id) => set.has(id));
}

/** The preset that shows exactly ``visible``, or null ("Custom"). */
export function presetOf(visible: readonly ColumnId[]): PresetId | null {
  const key = normaliseColumns(visible).join();
  for (const id of Object.keys(PRESETS) as PresetId[]) if (PRESETS[id].join() === key) return id;
  return null;
}

export function toggleColumn(visible: readonly ColumnId[], id: ColumnId, on: boolean): ColumnId[] {
  return normaliseColumns(on ? [...visible, id] : visible.filter((x) => x !== id));
}

// ------------------------------------------------------------------ per-browser preferences
export const COLUMNS_KEY = "f1sa.tower.columns";
export const PIN_KEY = "f1sa.tower.pin";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The saved visible columns, or the default (nothing saved, blocked storage or a bad value). An
 * empty saved list is valid: only Pos and Driver are shown. */
export function loadColumns(store: StorageLike | null = browserStorage()): ColumnId[] {
  try {
    const raw = store?.getItem(COLUMNS_KEY) ?? null;
    if (raw === null) return [...DEFAULT_COLUMNS];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? normaliseColumns(v) : [...DEFAULT_COLUMNS];
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}

export function saveColumns(visible: readonly ColumnId[], store: StorageLike | null = browserStorage()): void {
  try {
    store?.setItem(COLUMNS_KEY, JSON.stringify(normaliseColumns(visible)));
  } catch {
    // private mode or storage disabled: the choice lasts for this page only
  }
}

/** The pinned car, or null. */
export function loadPin(store: StorageLike | null = browserStorage()): string | null {
  try {
    const v = store?.getItem(PIN_KEY) ?? null;
    return v !== null && isDriverId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Save (or clear, with null) the pinned car; one car at a time. */
export function savePin(driverId: string | null, store: StorageLike | null = browserStorage()): void {
  try {
    store?.setItem(PIN_KEY, driverId ?? "");
  } catch {
    // blocked storage: the pin lasts for this page only
  }
}

/** Pressing a row's pin: pin that car, or unpin it when it is the pinned one. */
export const togglePin = (pinned: string | null, driverId: string): string | null =>
  pinned === driverId ? null : driverId;
