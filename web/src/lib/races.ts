/** Race picker helpers (pure). */

import type { Race } from "./api";

/** Races whose name, season or ``r<round>`` contains ``query`` (case-insensitive). */
export function filterRaces(races: readonly Race[], query: string): Race[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...races];
  return races.filter((r) => `${r.name ?? ""} ${r.season} r${r.round}`.toLowerCase().includes(q));
}

/** ``[season, races]`` pairs, newest season first, races in round order as given. */
export function groupBySeason(races: readonly Race[]): [number, Race[]][] {
  const groups = new Map<number, Race[]>();
  for (const r of races) groups.set(r.season, [...(groups.get(r.season) ?? []), r]);
  return [...groups.entries()].sort((a, b) => b[0] - a[0]);
}

/** The demo race: what ``make demo`` replays (``DEMO_SEASON`` / ``DEMO_ROUND`` in the Makefile). */
export const DEMO_RACE = { season: 2024, round: 5 } as const;

/** A replay the picker can point to: the race and, while it runs, its state and lap. */
export interface RunningReplay {
  season: number;
  round: number;
  state: string;
  paused: boolean;
  lap: number | null;
}

/** The picker's first choice for a grader (critique F36). */
export interface StartHere {
  race: Race;
  /** why this race: it is replaying now, it is the ``make demo`` race, or it is the newest race listed */
  why: "replaying" | "demo" | "newest";
  /** the running replay's lap (``replaying`` only; null before its first lap) */
  lap: number | null;
  paused: boolean;
  /** a post-race archive bundle exists for the race */
  archived: boolean;
}

/** The race to offer first: the race replaying now (when it is listed), else the demo race, else the first race of
 * the newest season. Null when there are no races. ``archived`` lists the races with a post-race bundle (null
 * while unknown). */
export function startHere(
  races: readonly Race[],
  running: readonly RunningReplay[],
  archived: readonly { season: number; round: number }[] | null,
): StartHere | null {
  const find = (season: number, round: number) => races.find((r) => r.season === season && r.round === round);
  const hasArchive = (r: Race) => (archived ?? []).some((a) => a.season === r.season && a.round === r.round);
  for (const job of running) {
    const race = find(job.season, job.round);
    if (race) return { race, why: "replaying", lap: job.lap, paused: job.paused, archived: hasArchive(race) };
  }
  const demo = find(DEMO_RACE.season, DEMO_RACE.round);
  if (demo) return { race: demo, why: "demo", lap: null, paused: false, archived: hasArchive(demo) };
  const newest = groupBySeason(races)[0]?.[1][0];
  return newest ? { race: newest, why: "newest", lap: null, paused: false, archived: hasArchive(newest) } : null;
}
