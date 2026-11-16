/** Display-only per-race entrants (``GET /api/races/{s}/{r}/entrants``, ``src/f1sa/api/entrants.py``):
 * real codes, car numbers, the season's team name, a short badge code, the team colour and the
 * F1-style nationality code. Nothing here feeds the race state, the alerts or the what-if. */

import { isDriverId, isInt, isObj, isStr, nullable } from "./guard";

export const HEX = /^#[0-9A-F]{6}$/;
export const TEAM_CODE = /^[A-Z]{2,3}$/;
export const NATIONALITY_CODE = /^[A-Z]{3}$/;
export const COLOUR_SOURCE = /^(ti_race|ti_neighbour_round_([1-9][0-9]?)|project_palette)$/;

export interface Entrant {
  driver_id: string;
  code: string | null;
  given_name: string | null;
  family_name: string | null;
  car_number: number | null;
  /** Starting slot; 0 = pit lane. */
  grid: number | null;
  constructor_id: string;
  team_name: string;
  team_code: string;
  team_lineage_id: string;
  team_colour_hex: string;
  /** Black or white, whichever contrasts more with the team colour (>= 4.5:1, chosen by the API). */
  team_text_hex: "#000000" | "#FFFFFF";
  colour_source: string;
  nationality: string | null;
  nationality_code: string | null;
}

export interface Entrants {
  season: number;
  round: number;
  entrants: Entrant[];
}

const optStr = (v: unknown): string | null | undefined => nullable(v, isStr);
const optInt = (v: unknown): number | null | undefined => nullable(v, isInt);
const matches = (re: RegExp) => (v: unknown): v is string => isStr(v) && re.test(v);

export function toEntrant(v: unknown): Entrant | undefined {
  if (!isObj(v) || !isDriverId(v.driver_id) || !isStr(v.constructor_id) || !isStr(v.team_name)) {
    return undefined;
  }
  if (!matches(TEAM_CODE)(v.team_code) || !isStr(v.team_lineage_id)) return undefined;
  if (!matches(HEX)(v.team_colour_hex) || !matches(COLOUR_SOURCE)(v.colour_source)) return undefined;
  if (v.team_text_hex !== "#000000" && v.team_text_hex !== "#FFFFFF") return undefined;
  const code = optStr(v.code);
  const given = optStr(v.given_name);
  const family = optStr(v.family_name);
  const nationality = optStr(v.nationality);
  const nat = nullable(v.nationality_code, matches(NATIONALITY_CODE));
  const number = optInt(v.car_number);
  const grid = optInt(v.grid);
  if ([code, given, family, nationality, nat, number, grid].some((x) => x === undefined)) return undefined;
  return {
    driver_id: v.driver_id,
    code: code ?? null,
    given_name: given ?? null,
    family_name: family ?? null,
    car_number: number ?? null,
    grid: grid ?? null,
    constructor_id: v.constructor_id,
    team_name: v.team_name,
    team_code: v.team_code,
    team_lineage_id: v.team_lineage_id,
    team_colour_hex: v.team_colour_hex,
    team_text_hex: v.team_text_hex,
    colour_source: v.colour_source,
    nationality: nationality ?? null,
    nationality_code: nat ?? null,
  };
}

/** The whole response, or ``undefined`` if any row is malformed or a driver id repeats. */
export function toEntrants(v: unknown): Entrants | undefined {
  if (!isObj(v) || !isInt(v.season) || !isInt(v.round) || !Array.isArray(v.entrants)) return undefined;
  const out: Entrant[] = [];
  const seen = new Set<string>();
  for (const item of v.entrants) {
    const e = toEntrant(item);
    if (e === undefined || seen.has(e.driver_id)) return undefined;
    seen.add(e.driver_id);
    out.push(e);
  }
  return { season: v.season, round: v.round, entrants: out };
}

export type EntrantIndex = Record<string, Entrant>;

export function indexEntrants(list: readonly Entrant[]): EntrantIndex {
  return Object.fromEntries(list.map((e) => [e.driver_id, e]));
}

/** The other drivers of the same team in this race (a seat change never links two seasons). */
export function teammates(index: EntrantIndex, driverId: string): Entrant[] {
  const me = index[driverId];
  if (me === undefined) return [];
  return Object.values(index)
    .filter((e) => e.constructor_id === me.constructor_id && e.driver_id !== driverId)
    .sort((a, b) => a.driver_id.localeCompare(b.driver_id));
}

/** ``Charles Leclerc``; falls back to whatever part is known. */
export function fullName(e: Entrant): string {
  return [e.given_name, e.family_name].filter((p): p is string => p !== null && p !== "").join(" ") || e.driver_id;
}

/** Grid slots 1..N first, then pit-lane starts (0) and unknown slots, then car number (the API
 * already sends this order; kept here so a view never depends on it). */
export function byGrid(a: Entrant, b: Entrant): number {
  const slot = (e: Entrant) => (e.grid !== null && e.grid > 0 ? e.grid : Number.POSITIVE_INFINITY);
  return (
    slot(a) - slot(b) ||
    (a.car_number ?? 1000) - (b.car_number ?? 1000) ||
    a.driver_id.localeCompare(b.driver_id)
  );
}

export function gridLabel(grid: number | null): string {
  if (grid === null) return "—";
  return grid === 0 ? "Pit lane" : String(grid);
}

/** Where the badge colour comes from, in words (never only a colour). */
export function colourSourceText(source: string): string {
  if (source === "ti_race") return "colour from this race's timing data";
  const m = COLOUR_SOURCE.exec(source);
  if (m?.[2] !== undefined) return `colour from round ${m[2]} (this race's timing data has none)`;
  return "project palette colour (no timing data for this team)";
}

/** The tower tooltip: ``Ferrari · teammate: Carlos Sainz (SAI)``. */
export function teamTitle(index: EntrantIndex, driverId: string): string | null {
  const me = index[driverId];
  if (me === undefined) return null;
  const mates = teammates(index, driverId).map((t) => `${fullName(t)}${t.code ? ` (${t.code})` : ""}`);
  return mates.length > 0 ? `${me.team_name} · teammate: ${mates.join(", ")}` : me.team_name;
}

/** The tower row class while ``hovered`` is under the pointer: the hovered row and its teammates
 * get an outline (a shape, not only a colour); other rows nothing. */
export function teamHighlight(
  index: EntrantIndex,
  hovered: string | null,
  rowId: string,
): "is-team-hover" | "is-teammate" | undefined {
  if (hovered === null) return undefined;
  if (hovered === rowId) return index[rowId] === undefined ? undefined : "is-team-hover";
  const a = index[hovered];
  const b = index[rowId];
  return a !== undefined && b !== undefined && a.constructor_id === b.constructor_id ? "is-teammate" : undefined;
}
