/** F37 regression from a recorded 10x replay of 2024 R5 (fixture: ``fixtures/f37_2024_5.json``, see
 * its ``_source``). The frames run through the real reducer exactly as the SSE stream framed them;
 * ``zset_after_batch`` is the Redis order sorted set read right after that batch was published. */
import { describe, expect, it } from "vitest";

import { initialState, raceReducer, type RaceState, towerRows } from "@/lib/reducer";

import fixture from "./fixtures/f37_2024_5.json";

interface Frame {
  raw: string;
  zset_after_batch?: string[];
}

const windowOf = (name: string): Frame[] => {
  const w = fixture.windows.find((x) => x.name === name);
  if (!w) throw new Error(`fixture window ${name} missing`);
  return w.frames as Frame[];
};

/** Replays a window; returns the state after every frame. */
function replay(frames: Frame[]): RaceState[] {
  const states: RaceState[] = [];
  let s = initialState(2024, 5);
  for (const f of frames) {
    s = raceReducer(s, { type: "event", raw: f.raw });
    states.push(s);
  }
  return states;
}

describe("F37 recording, 2024 R5", () => {
  it("parses every frame (nothing malformed, foreign or duplicated)", () => {
    for (const w of fixture.windows) {
      const last = replay(w.frames as Frame[]).at(-1) as RaceState;
      expect([last.malformed, last.foreign, last.duplicates]).toEqual([0, 0, 0]);
    }
  });

  it("opening at lap 10 mid-lap: PIA, LEC, RUS, SAI are P5-P8 and the order follows Redis", () => {
    const frames = windowOf("f37_open_mid_lap_10");
    const states = replay(frames);
    let compared = 0;
    frames.forEach((f, i) => {
      if (!f.zset_after_batch) return;
      compared += 1;
      expect(states[i]!.order).toEqual(f.zset_after_batch);
    });
    expect(compared).toBeGreaterThan(5);
    const rows = towerRows(states.at(-1) as RaceState);
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 8).map((r) => `P${r.position} ${r.driverId}`)).toEqual([
      "P1 max_verstappen",
      "P2 perez",
      "P3 norris",
      "P4 alonso",
      "P5 piastri",
      "P6 leclerc",
      "P7 russell",
      "P8 sainz",
    ]);
  });

  it("lap 1 from the start: the snapshot before KMAG/HAM's lap frames never lifts them above P18", () => {
    const frames = windowOf("reference_lap_1");
    const states = replay(frames);
    for (const s of states) {
      for (const id of ["kevin_magnussen", "hamilton", "sargeant"]) {
        const i = s.order.indexOf(id);
        if (i !== -1) expect(i).toBeGreaterThanOrEqual(17);
      }
    }
    const last = frames.findLastIndex((f) => f.zset_after_batch);
    expect(last).toBeGreaterThan(-1);
    expect(states[last]!.order).toEqual(frames[last]!.zset_after_batch);
  });

  it("the fixture keeps only the fields the ordering needs", () => {
    const lapKeys = ["compound", "driver_id", "event_id", "lap", "lap_time_s", "position", "race_time_s", "tyre_age"];
    for (const w of fixture.windows) {
      for (const f of w.frames as Frame[]) {
        const m = JSON.parse(f.raw) as { type: string; payload?: Record<string, unknown>; timing?: Record<string, object> };
        if (m.type === "lap") {
          expect(Object.keys(m.payload ?? {}).sort()).toEqual(lapKeys);
          expect([m.payload?.compound, m.payload?.tyre_age]).toEqual([null, null]);
        } else {
          expect(m.type).toBe("snapshot");
          for (const t of Object.values(m.timing ?? {})) expect(Object.keys(t)).toEqual(["lap"]);
        }
      }
    }
  });
});
