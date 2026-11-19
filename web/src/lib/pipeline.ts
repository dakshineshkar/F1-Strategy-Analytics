/** The live page's pipeline counters (display only, pure).
 *
 * The reducer's ``unknownDrivers`` counts, once per car, an event that arrived before any snapshot listed that
 * car. At a replay start the race's keys are cleared, so a car's first lap frame can arrive before the leader-lap
 * snapshot that lists it: the count then stays at that number for the whole page (10 in a full-lake replay of
 * 2024 R5) although every one of those cars was listed by the next snapshot. The panel shows the cars that are
 * still unlisted instead, so an arrival-order artefact resolves itself, and only an id that no snapshot of this
 * race ever held stays counted. The reducer is unchanged. */

import type { RaceState } from "./reducer";

/** Cars with a row that no snapshot has listed yet (``known`` false). */
export function unlistedCars(state: Pick<RaceState, "drivers">): number {
  return Object.values(state.drivers).filter((r) => !r.known).length;
}
