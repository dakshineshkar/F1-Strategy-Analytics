/** Feature 5 timing-tower extras: parsing, the reducer, causal bests and PB / OB marks, presets,
 * per-browser persistence, the pin, and the rendered tower. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimingTower } from "@/components/TimingTower";
import { TowerColumns } from "@/components/TowerPanel";
import { toSnapshot } from "@/lib/api";
import { type ArchiveBundle, stateAtLap, toArchiveBundle } from "@/lib/archive";
import { parseEvent } from "@/lib/events";
import { initialState, raceReducer, type RaceState, towerRows } from "@/lib/reducer";
import { NO_TIMING } from "@/lib/timing";
import {
  bestSoFar,
  COLUMN_IDS,
  COLUMNS_KEY,
  DEFAULT_COLUMNS,
  loadColumns,
  loadPin,
  MARKS_FROM_LAP,
  normaliseColumns,
  PIN_KEY,
  PRESETS,
  presetOf,
  saveColumns,
  savePin,
  sectorMark,
  type StorageLike,
  toggleColumn,
  togglePin,
  trapMark,
} from "@/lib/tower";

import { driver, lap, msg, snapshot, uuid } from "./helpers";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tower = (s1: number | null, pb1: unknown, more: Record<string, unknown> = {}) => ({
  sector1_s: s1,
  sector2_s: 30.0,
  sector3_s: 25.0,
  speed_trap_kph: 310,
  pb_sector1_s: pb1,
  pb_sector2_s: 30.0,
  pb_sector3_s: 24.5,
  pb_speed_trap_kph: 312,
  pit_stops: 0,
  ...more,
});

const run = (lines: string[], s: RaceState = initialState(2024, 5)): RaceState =>
  lines.reduce((acc, raw) => raceReducer(acc, { type: "event", raw }), s);

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
const blocked: StorageLike = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

// ------------------------------------------------------------------ parsing
describe("parsing (display only: a bad value is unknown, never a dropped lap)", () => {
  it("reads the lap payload's tower fields", () => {
    const e = parseEvent(lap("max_verstappen", 3, 270, 1, tower(28.4, 28.1, { pit_stops: 1 })));
    expect(e?.type).toBe("lap");
    if (e?.type !== "lap") return;
    expect(e.timing).toEqual({
      sectors: [28.4, 30, 25],
      pbSectors: [28.1, 30, 24.5],
      speedTrapKph: 310,
      pbSpeedTrapKph: 312,
      pitStops: 1,
    });
  });

  it("an older payload without the fields, or bad values, gives unknown values", () => {
    const old = parseEvent(lap("max_verstappen", 3, 270, 1));
    expect(old?.type === "lap" && old.timing).toEqual(NO_TIMING);
    const bad = parseEvent(lap("max_verstappen", 3, 270, 1, tower(-1, "x", { pit_stops: 1.5, speed_trap_kph: 0 })));
    expect(bad?.type === "lap" && bad.timing).toMatchObject({ sectors: [null, 30, 25], pbSectors: [null, 30, 24.5], speedTrapKph: null, pitStops: null });
  });

  it("the snapshot's timing map: optional, and a bad entry is dropped, never the snapshot", () => {
    const base = snapshot(["max_verstappen", "lando_norris"]);
    const parsed = toSnapshot({
      ...base,
      timing: { max_verstappen: { lap: 4, ...tower(28.0, 28.0) }, lando_norris: { lap: 0 }, "Bad Id": { lap: 3 } },
    });
    expect(Object.keys(parsed?.timing ?? {})).toEqual(["max_verstappen"]);
    expect(parsed?.timing.max_verstappen).toMatchObject({ lap: 4, sectors: [28, 30, 25], pitStops: 0 });
    const older: Record<string, unknown> = { ...base };
    delete older.timing;
    expect(toSnapshot(older)?.timing).toEqual({});
  });
});

// ------------------------------------------------------------------ reducer
describe("reducer", () => {
  it("a lap event sets the tower values and the stop count; an older lap never regresses them", () => {
    let s = run([lap("max_verstappen", 5, 450, 1, tower(28.4, 28.1, { pit_stops: 1 }))]);
    expect(s.drivers.max_verstappen).toMatchObject({ timingLap: 5, stops: 1 });
    expect(s.drivers.max_verstappen?.timing.sectors[0]).toBe(28.4);
    s = run([lap("max_verstappen", 4, 360, 1, tower(29.9, 29.9, { pit_stops: 0 }))], s);
    expect(s.drivers.max_verstappen).toMatchObject({ timingLap: 5, stops: 1 });
  });

  it("without a count on the payload the stops come from the pit_in events", () => {
    const s = run([
      lap("lando_norris", 1, 91, 2),
      msg("pit_in", { driver_id: "lando_norris", lap: 2, race_time_s: 180 }),
      lap("lando_norris", 2, 200, 2),
    ]);
    expect(s.drivers.lando_norris?.stops).toBe(1);
  });

  it("a snapshot's timing hash applies unless a newer lap event set the values", () => {
    let s = run([lap("max_verstappen", 6, 540, 1, tower(28.2, 28.0, { pit_stops: 2 }))]);
    const older = toSnapshot({
      ...snapshot(["max_verstappen"]),
      timing: { max_verstappen: { lap: 5, ...tower(28.9, 28.9, { pit_stops: 1 }) } },
    });
    if (older === undefined) throw new Error("snapshot rejected");
    s = raceReducer(s, { type: "snapshot", data: older });
    expect(s.drivers.max_verstappen).toMatchObject({ timingLap: 6, stops: 2 });
    const reconnect = raceReducer(initialState(2024, 5), { type: "snapshot", data: older });
    expect(reconnect.drivers.max_verstappen).toMatchObject({ timingLap: 5, stops: 1 }); // after a reload
    expect(reconnect.drivers.max_verstappen?.timing).not.toHaveProperty("lap");
  });
});

// ------------------------------------------------------------------ bests and marks
describe("best so far and the PB / OB marks", () => {
  const rows = () =>
    towerRows(
      run([
        lap("max_verstappen", 3, 270, 1, tower(28.4, 28.1)), // slower than its own best: no S1 mark
        lap("lando_norris", 3, 271, 2, tower(28.2, 28.2, { speed_trap_kph: 315, pb_speed_trap_kph: 315 })),
        lap("oscar_piastri", 3, 272, 3, tower(null, null, { speed_trap_kph: null, pb_speed_trap_kph: null })),
      ]),
    );

  it("OB is the best personal best of the cars (minimum sector, maximum trap)", () => {
    const best = bestSoFar(rows());
    expect(best.sectors[0]).toEqual({ value: 28.1, driverId: "max_verstappen" });
    expect(best.sectors[2]).toEqual({ value: 24.5, driverId: "max_verstappen" }); // a tie keeps the first car
    expect(best.speedTrap).toEqual({ value: 315, driverId: "lando_norris" });
    expect(bestSoFar([]).sectors).toEqual([null, null, null]);
  });

  it("marks: OB beats PB; a value that is neither gets none; unknown gets none", () => {
    const r = rows();
    const best = bestSoFar(r);
    const [ver, nor, pia] = r as [(typeof r)[0], (typeof r)[0], (typeof r)[0]];
    expect(sectorMark(ver, 0, best)).toBeNull(); // 28.4 vs its own 28.1
    expect(sectorMark(nor, 0, best)).toBe("PB"); // its own best, not the race's (28.1)
    expect(sectorMark(ver, 1, best)).toBe("OB"); // 30.0 is everyone's best: OB wins
    expect(sectorMark(ver, 2, best)).toBeNull(); // 25.0 vs 24.5
    expect(trapMark(nor, best)).toBe("OB");
    expect(trapMark(ver, best)).toBeNull(); // 310 vs its own 312
    expect(sectorMark(pia, 0, best)).toBeNull();
    expect(trapMark(pia, best)).toBeNull();
  });

  it("no PB / OB on lap 1 (every first time is trivially a best); they start on lap 2", () => {
    expect(MARKS_FROM_LAP).toBe(2);
    const first = towerRows(
      run([
        lap("max_verstappen", 1, 95, 1, tower(28.1, 28.1, { speed_trap_kph: 315, pb_speed_trap_kph: 315 })),
        lap("lando_norris", 1, 96, 2, tower(28.3, 28.3)),
      ]),
    );
    const best = bestSoFar(first);
    for (const r of first) {
      for (const i of [0, 1, 2] as const) expect(sectorMark(r, i, best)).toBeNull();
      expect(trapMark(r, best)).toBeNull();
    }
    expect(renderToStaticMarkup(createElement(TimingTower, { rows: first, lapsDown: () => 0 }))).not.toContain("tag mark");
    const second = towerRows(run([lap("max_verstappen", 2, 190, 1, tower(28.0, 28.0))]));
    expect(sectorMark(second[0]!, 0, bestSoFar(second))).toBe("OB");
  });
});

// ------------------------------------------------------------------ causality on the archive path
function message(lapN: number, type: string, payload: Record<string, unknown>): Doc {
  return { lap: lapN, event_id: uuid(), message: { type, season: 2024, round: 5, event_ts: null, published_at: "x", payload } };
}

/** Three cars over ``n`` laps; car 2 gets faster every lap, so the OB moves to it later. */
function bundleDoc(n: number): Doc {
  const ids = ["max_verstappen", "lando_norris", "oscar_piastri"];
  const best: Record<string, number> = {};
  const messages: Doc[] = [];
  const snapshots: Doc[] = [];
  for (let l = 1; l <= n; l += 1) {
    const timing: Doc = {};
    ids.forEach((id, i) => {
      const s1 = i === 1 ? 29 - l * 0.3 : 28.5 + i * 0.1;
      best[id] = Math.min(best[id] ?? Infinity, s1);
      const t = tower(s1, best[id] as number, { pit_stops: 0 });
      messages.push(message(l, "lap", { event_id: uuid(), driver_id: id, lap: l, race_time_s: l * 90 + i, position: i + 1, lap_time_s: 90, compound: "MEDIUM", tyre_age: l, ...t }));
      timing[id] = { lap: l, ...t, updated_at: "x" };
    });
    if (l === n) messages.push(message(l, "session_end", {}));
    snapshots.push({
      lap: l,
      drivers: Object.fromEntries(ids.map((id, i) => [id, driver(i + 1)])),
      order: ids.map((driver_id, i) => ({ driver_id, position: i + 1 })),
      tyres: {},
      timing,
    });
  }
  return {
    schema_version: 2,
    meta: { season: 2024, round: 5, race_name: null, laps: n, synthetic: true, source: "sample", clock: "simulated", model: { version: "m", scorer_sha256: "a".repeat(64) } },
    entrants: [],
    snapshots,
    messages,
    decisions: [],
    track: [],
    race_control: [],
    status: snapshots.map((s) => ({ lap: s.lap, status: "green", source: "estimated", message: null, message_lap: null })),
  };
}

describe("no hindsight on the post-race path", () => {
  it("the marks and the best so far at lap N are unchanged when later laps exist", () => {
    const full = toArchiveBundle(bundleDoc(8)) as ArchiveBundle;
    for (let n = 1; n <= 5; n += 1) {
      const cut = toArchiveBundle(bundleDoc(n)) as ArchiveBundle;
      expect(cut).toBeDefined();
      const a = towerRows(stateAtLap(full, n));
      const b = towerRows(stateAtLap(cut, n));
      expect(bestSoFar(a)).toEqual(bestSoFar(b));
      expect(a.map((r) => [sectorMark(r, 0, bestSoFar(a)), r.timing])).toEqual(b.map((r) => [sectorMark(r, 0, bestSoFar(b)), r.timing]));
    }
    // and the OB really moves later: lando takes it from lap 2 on
    expect(bestSoFar(towerRows(stateAtLap(full, 1))).sectors[0]?.driverId).toBe("max_verstappen");
    expect(bestSoFar(towerRows(stateAtLap(full, 5))).sectors[0]?.driverId).toBe("lando_norris");
  });
});

// ------------------------------------------------------------------ columns, presets, persistence
describe("columns and presets", () => {
  it("Minimal and Full, custom otherwise, canonical order without duplicates", () => {
    expect(PRESETS.full).toEqual(COLUMN_IDS);
    expect(DEFAULT_COLUMNS).toEqual(PRESETS.full);
    expect(presetOf(["undercut", "tyre", "gap", "last"])).toBe("minimal");
    expect(presetOf(COLUMN_IDS)).toBe("full");
    expect(presetOf(["gap"])).toBeNull();
    expect(normaliseColumns(["s1", "gap", "s1", "nope"])).toEqual(["gap", "s1"]);
    // canonical order: Undercut sits next to the driver (redesign, critique F01)
    expect(toggleColumn(PRESETS.minimal, "s1", true)).toEqual(["undercut", "gap", "last", "s1", "tyre"]);
    expect(toggleColumn(PRESETS.minimal, "gap", false)).toEqual(["undercut", "last", "tyre"]);
  });

  it("are kept per browser; nothing saved, a bad value or blocked storage gives the default", () => {
    const store = new MemoryStorage();
    expect(loadColumns(store)).toEqual([...DEFAULT_COLUMNS]);
    saveColumns(["s3", "gap", "s3"], store);
    expect(store.data.get(COLUMNS_KEY)).toBe('["gap","s3"]');
    expect(loadColumns(store)).toEqual(["gap", "s3"]);
    saveColumns([], store);
    expect(loadColumns(store)).toEqual([]); // only Pos, Pin and Driver
    store.setItem(COLUMNS_KEY, "{not json");
    expect(loadColumns(store)).toEqual([...DEFAULT_COLUMNS]);
    store.setItem(COLUMNS_KEY, '{"a":1}');
    expect(loadColumns(store)).toEqual([...DEFAULT_COLUMNS]);
    expect(loadColumns(blocked)).toEqual([...DEFAULT_COLUMNS]);
    expect(() => saveColumns(["gap"], blocked)).not.toThrow();
    expect(loadColumns(null)).toEqual([...DEFAULT_COLUMNS]);
  });

  it("the Columns control: a disclosure with a preset radio group and one checkbox per column", () => {
    const m = renderToStaticMarkup(createElement(TowerColumns, { visible: PRESETS.minimal, onChange: () => undefined }));
    expect(m).toContain('aria-expanded="false"');
    expect(m).toMatch(/aria-controls="[^"]+-panel"/);
    expect(m).toContain("Columns: Minimal");
    expect(m).toContain("hidden");
    expect((m.match(/type="radio"/g) ?? []).length).toBe(2);
    expect((m.match(/type="checkbox"/g) ?? []).length).toBe(COLUMN_IDS.length);
    expect(m).toContain("<legend>Preset</legend>");
    const custom = renderToStaticMarkup(createElement(TowerColumns, { visible: ["gap"], onChange: () => undefined }));
    expect(custom).toContain("Columns: Custom");
  });
});

describe("the pin (one car, per browser)", () => {
  it("toggles one car at a time and survives a reload", () => {
    expect(togglePin(null, "max_verstappen")).toBe("max_verstappen");
    expect(togglePin("max_verstappen", "lando_norris")).toBe("lando_norris");
    expect(togglePin("lando_norris", "lando_norris")).toBeNull();
    const store = new MemoryStorage();
    expect(loadPin(store)).toBeNull();
    savePin("lando_norris", store);
    expect(store.data.get(PIN_KEY)).toBe("lando_norris");
    expect(loadPin(store)).toBe("lando_norris");
    savePin(null, store);
    expect(loadPin(store)).toBeNull();
    store.setItem(PIN_KEY, "Bad Id");
    expect(loadPin(store)).toBeNull();
    expect(loadPin(blocked)).toBeNull();
    expect(() => savePin("x", blocked)).not.toThrow();
  });
});

// ------------------------------------------------------------------ the rendered tower
describe("the rendered tower", () => {
  const rowsWith = () =>
    towerRows(
      run([
        lap("max_verstappen", 3, 270, 1, tower(28.1, 28.1, { pit_stops: 1 })),
        lap("lando_norris", 3, 271, 2, tower(28.3, 28.2, { pit_stops: 0 })),
      ]),
    );
  const html = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(TimingTower, { rows: rowsWith(), lapsDown: () => 0, ...props }));

  it("shows S1 / S2 / S3, Trap and Pits with text tags and the best-so-far line", () => {
    const m = html({});
    for (const h of ["S1", "S2", "S3", "Trap", "Pits"]) expect(m).toMatch(new RegExp(`<th scope="col" class="c-[a-z]+">${h}`));
    expect(m).toContain('data-col="s1">28.100<span class="tag mark mark-ob" aria-describedby="tip-pbob">OB<span class="visually-hidden">, overall best so far</span>');
    expect(m).toContain('data-col="pits">1</td>');
    expect(m).toContain("Best so far");
    expect(m).toContain("S1 28.100 VER");
    expect(m).toContain("Trap 312 km/h VER");
  });

  it("hides the columns that are not visible (Pos, Pin and Driver always stay)", () => {
    const m = html({ visible: PRESETS.minimal });
    expect(m).not.toContain('<th scope="col" class="c-sec">S1</th>');
    expect(m).not.toContain('data-col="pits"');
    expect(m).toContain('<span class="visually-hidden">Pin</span>');
    expect(m).toContain("Driver");
    expect(m).toContain("Last lap");
  });

  it("the pin: a toggle button per row; the pinned row is marked in text and by class", () => {
    const m = html({ pinned: "lando_norris", onPin: () => undefined });
    expect(m).toContain('aria-pressed="true" aria-label="Pin NOR"');
    expect(m).toContain('aria-pressed="false" aria-label="Pin VER"');
    expect(m).toMatch(/<tr data-driver="lando_norris" data-flip="lando_norris" class="is-pinned">/);
    expect(m).toContain('<span class="visually-hidden">, pinned</span>');
    expect((m.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });

  it("without sector data (the sample) and for a v1 bundle it says so", () => {
    const plain = towerRows(run([lap("max_verstappen", 3, 270, 1)]));
    const m = renderToStaticMarkup(createElement(TimingTower, { rows: plain, lapsDown: () => 0 }));
    expect(m).toContain("No sector or speed-trap data for this race (the sample race has none); pit counts are real.");
    const v1 = renderToStaticMarkup(createElement(TimingTower, { rows: plain, lapsDown: () => 0, extrasNote: "v1 note" }));
    expect(v1).toContain("v1 note");
  });
});
