/** The pipeline panel's count of cars not yet in a snapshot (2026-11-19 screenshot review, item 3).
 *
 * The reducer's ``unknownDrivers`` counts, once per car, an event that arrived before any snapshot listed the car;
 * it never goes down, so a replay start left "10" on the panel for the whole race while a late joiner saw 0. The
 * panel now shows the cars that are still unlisted: the artefact resolves at the next snapshot. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Legend, LIVE_GROUPS } from "@/components/Legend";
import { glossary } from "@/lib/legend";
import { unlistedCars } from "@/lib/pipeline";
import { initialState, type RaceAction, raceReducer, type RaceState } from "@/lib/reducer";

import { lap, msg, snapshotMsg } from "./helpers";

const ev = (raw: string): RaceAction => ({ type: "event", raw });
const run = (actions: RaceAction[], from: RaceState = initialState(2024, 5)): RaceState => actions.reduce(raceReducer, from);

describe("cars not yet in a snapshot", () => {
  it("counts a car whose first lap frame came before its snapshot, and resolves it when the snapshot lists it", () => {
    // a replay start: the connect snapshot is empty, then leclerc's lap-1 frame arrives before the lap snapshot
    const before = run([ev(snapshotMsg([], 0)), ev(lap("b", 1, 90, 2))]);
    expect(before.unknownDrivers).toBe(1);
    expect(unlistedCars(before)).toBe(1);
    const after = run([ev(snapshotMsg(["a", "b", "c"], 1)), ev(lap("a", 1, 89, 1)), ev(lap("c", 1, 91, 3))], before);
    // the reducer's counter is cumulative (unchanged); the panel's count is what is still unlisted
    expect(after.unknownDrivers).toBe(1);
    expect(unlistedCars(after)).toBe(0);
  });

  it("a late joiner's first snapshot lists every car: 0", () => {
    expect(unlistedCars(run([ev(snapshotMsg(["a", "b", "c"], 45)), ev(lap("a", 46, 4400, 1))]))).toBe(0);
  });

  it("an id that no snapshot of the race holds stays counted (lap, pit and alert), once per car", () => {
    const s = run([
      ev(snapshotMsg(["a", "b"], 1)),
      ev(lap("ghost", 2, 181, 3)),
      ev(msg("pit_in", { driver_id: "phantom", lap: 2, race_time_s: 182 })),
      ev(lap("ghost", 3, 270, 3)),
      ev(snapshotMsg(["a", "b"], 3)),
    ]);
    expect(unlistedCars(s)).toBe(2);
  });

  it("is 0 on an empty page", () => {
    expect(unlistedCars(initialState(2024, 5))).toBe(0);
  });

  it("has a glossary entry, in the live legend, that says it is not a data error", () => {
    const e = glossary("unlisted");
    expect(e.group).toBe("pipeline");
    expect(e.term).toBe("Cars not yet in a snapshot");
    expect(e.text).toContain("not a data error");
    expect(LIVE_GROUPS).toContain("pipeline");
    expect(renderToStaticMarkup(createElement(Legend))).toContain("Cars not yet in a snapshot");
  });
});
