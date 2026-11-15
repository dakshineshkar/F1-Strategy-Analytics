/** How the dashboard shows a car's tyre age (display only).
 *
 * ``real``: the TracingInsights tyre life (laps on the set including earlier use, such as
 * qualifying); ``used`` when the set already had laps when its stint began.
 * ``estimated``: no real value, so the inferred stint age (``tyre_age_laps``), which in full mode
 * assumes every stint starts on a new set (synthetic in sample mode).
 * ``unknown``: neither value. */

import type { DriverRow } from "./reducer";

export type TyreAgeKind = "real" | "estimated" | "unknown";

export interface TyreAgeView {
  kind: TyreAgeKind;
  laps: number | null;
  used: boolean;
  /** Laps already on the set when the stint began (real values only). */
  atStart: number | null;
  /** Full sentence for screen readers and the tooltip. */
  description: string;
}

export const ESTIMATED_NOTE = "estimated: inferred stint age, assumes a new set";

function lapsText(n: number): string {
  return `${n} ${n === 1 ? "lap" : "laps"}`;
}

export function tyreAgeView(
  row: Pick<DriverRow, "tyreLifeLaps" | "tyreLifeAtStartLaps" | "tyreAgeLaps">,
): TyreAgeView {
  if (row.tyreLifeLaps !== null) {
    const atStart = row.tyreLifeAtStartLaps;
    const used = atStart !== null && atStart > 0;
    return {
      kind: "real",
      laps: row.tyreLifeLaps,
      used,
      atStart,
      description: used
        ? `${lapsText(row.tyreLifeLaps)} on a used set (${lapsText(atStart)} before this stint)`
        : `${lapsText(row.tyreLifeLaps)} on the set`,
    };
  }
  if (row.tyreAgeLaps !== null) {
    return {
      kind: "estimated",
      laps: row.tyreAgeLaps,
      used: false,
      atStart: null,
      description: `${lapsText(row.tyreAgeLaps)}, ${ESTIMATED_NOTE}`,
    };
  }
  return { kind: "unknown", laps: null, used: false, atStart: null, description: "tyre age unknown" };
}
