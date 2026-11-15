import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimingTower } from "@/components/TimingTower";
import { TyrePanel } from "@/components/TyrePanel";
import { toSnapshot } from "@/lib/api";
import { parseEvent } from "@/lib/events";
import { initialState, raceReducer as reduce, type DriverRow } from "@/lib/reducer";
import { ESTIMATED_NOTE, tyreAgeView } from "@/lib/tyre";

import { lap, snapshot } from "./helpers";

const life = (tyreLifeLaps: number | null, tyreLifeAtStartLaps: number | null, tyreAgeLaps: number | null) => ({
  tyreLifeLaps,
  tyreLifeAtStartLaps,
  tyreAgeLaps,
});

describe("tyreAgeView", () => {
  it("prefers the real tyre life and marks a used set", () => {
    expect(tyreAgeView(life(16, 3, 13))).toEqual({
      kind: "real",
      laps: 16,
      used: true,
      atStart: 3,
      description: "16 laps on a used set (3 laps before this stint)",
    });
    expect(tyreAgeView(life(1, 0, 1))).toMatchObject({ kind: "real", laps: 1, used: false, description: "1 lap on the set" });
    expect(tyreAgeView(life(5, null, 5))).toMatchObject({ kind: "real", used: false });
  });
  it("falls back to the inferred age, marked estimated", () => {
    expect(tyreAgeView(life(null, null, 13))).toEqual({
      kind: "estimated",
      laps: 13,
      used: false,
      atStart: null,
      description: `13 laps, ${ESTIMATED_NOTE}`,
    });
    expect(tyreAgeView(life(null, 3, 7)).kind).toBe("estimated"); // a start value without life is not real
  });
  it("is unknown with neither value", () => {
    expect(tyreAgeView(life(null, null, null))).toMatchObject({ kind: "unknown", laps: null });
  });
});

function parsedLap(...args: Parameters<typeof lap>) {
  const e = parseEvent(lap(...args));
  if (e === null || e.type !== "lap") throw new Error("not a lap event");
  return e;
}

describe("lap events and snapshots carry the real tyre life", () => {
  it("parses the display-only fields and treats anything invalid as unknown", () => {
    expect(parsedLap("a", 5, 450, 1, { tyre_life_laps: 8, tyre_life_at_start_laps: 3 })).toMatchObject({
      tyreAge: 5,
      tyreLifeLaps: 8,
      tyreLifeAtStartLaps: 3,
    });
    expect(parsedLap("a", 5, 450, 1)).toMatchObject({ tyreLifeLaps: null, tyreLifeAtStartLaps: null });
    // a bad display value never drops the lap
    expect(parsedLap("a", 5, 450, 1, { tyre_life_laps: "8", tyre_life_at_start_laps: -1 })).toMatchObject({
      lap: 5,
      tyreLifeLaps: null,
      tyreLifeAtStartLaps: null,
    });
  });

  it("toSnapshot keeps valid tyre entries and drops malformed ones, never the snapshot", () => {
    const raw = {
      ...snapshot(["a", "b"]),
      tyres: {
        a: { lap: 30, tyre_life_laps: 16, tyre_life_at_start_laps: 3, updated_at: "x" },
        b: { lap: 0, tyre_life_laps: 1, tyre_life_at_start_laps: 0, updated_at: "x" },
        "Not An Id": { lap: 3, tyre_life_laps: 1, tyre_life_at_start_laps: 0 },
      },
    };
    expect(toSnapshot(raw)?.tyres).toEqual({ a: { lap: 30, tyre_life_laps: 16, tyre_life_at_start_laps: 3 } });
    const older: Record<string, unknown> = { ...snapshot(["a"]) };
    delete older.tyres;
    expect(toSnapshot(older)?.tyres).toEqual({});
  });

  it("the reducer takes the newest of lap event and snapshot, keeping the inferred age apart", () => {
    let s = initialState(2024, 5);
    s = reduce(s, { type: "event", raw: lap("a", 30, 2700, 1, { tyre_age: 13, tyre_life_laps: 16, tyre_life_at_start_laps: 3 }) });
    expect(s.drivers.a).toMatchObject({ tyreAgeLaps: 13, tyreLifeLaps: 16, tyreLifeAtStartLaps: 3, tyreLifeLap: 30 });
    // an older tyre hash in a snapshot never regresses the value; the hash age still updates
    const older = snapshot(["a"], { tyres: { a: { lap: 29, tyre_life_laps: 15, tyre_life_at_start_laps: 3 } } });
    s = reduce(s, { type: "snapshot", data: older });
    expect(s.drivers.a).toMatchObject({ tyreLifeLaps: 16, tyreLifeLap: 30, tyreAgeLaps: 12 });
    // a newer one (e.g. after a reconnect) replaces it, including an unknown value
    const newer = snapshot(["a"], { tyres: { a: { lap: 31, tyre_life_laps: null, tyre_life_at_start_laps: null } } });
    s = reduce(s, { type: "snapshot", data: newer });
    expect(s.drivers.a).toMatchObject({ tyreLifeLaps: null, tyreLifeLap: 31 });
    expect(tyreAgeView(s.drivers.a!).kind).toBe("estimated");
    // a snapshot without a tyre map (sample mode, older API) keeps what the lap events set
    s = reduce(s, { type: "event", raw: lap("a", 32, 2880, 1, { tyre_life_laps: 2, tyre_life_at_start_laps: 0 }) });
    s = reduce(s, { type: "snapshot", data: snapshot(["a"]) });
    expect(s.drivers.a).toMatchObject({ tyreLifeLaps: 2, tyreLifeLap: 32 });
  });

  it("a reload: the first snapshot alone shows the real value", () => {
    const data = snapshot(["a"], { tyres: { a: { lap: 30, tyre_life_laps: 16, tyre_life_at_start_laps: 3 } } });
    const s = reduce(initialState(2024, 5), { type: "snapshot", data });
    expect(tyreAgeView(s.drivers.a!)).toMatchObject({ kind: "real", laps: 16, used: true });
  });
});

const row = (id: string, more: Partial<DriverRow>): DriverRow => ({
  driverId: id,
  position: 1,
  gapAheadS: null,
  gapLeaderS: 0,
  lastLapTimeS: 90,
  compound: "SOFT",
  tyreAgeLaps: 13,
  tyreLifeLaps: null,
  tyreLifeAtStartLaps: null,
  tyreLifeLap: null,
  undercutFlag: false,
  undercutProb: null,
  lap: 30,
  raceTimeS: 2700,
  jolpicaPosition: 1,
  inPit: false,
  stops: 0,
  lastPitLap: null,
  known: true,
  ...more,
});

const ROWS = [
  row("max_verstappen", { tyreLifeLaps: 16, tyreLifeAtStartLaps: 3 }), // real, used set
  row("perez", { position: 2, tyreLifeLaps: 13, tyreLifeAtStartLaps: 0 }), // real, new set
  row("sainz", { position: 3 }), // no real value: estimated
  row("zhou", { position: 4, tyreAgeLaps: null }), // unknown
];

function cells(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`<span class="tyre-age tyre-age-(\\w+)"[^>]*${attr}`, "g"))].map((m) => m[1]!);
}

describe("rendering: real vs estimated age is text, not colour", () => {
  it("the timing tower's Age cell", () => {
    const html = renderToStaticMarkup(createElement(TimingTower, { rows: ROWS, lapsDown: () => 0 }));
    expect(cells(html, "")).toEqual(["real", "real", "estimated", "unknown"]);
    expect(html).toContain('<span class="tag tag-used">used</span>');
    expect(html.match(/tag-used/g)).toHaveLength(1); // only the used set
    expect(html).toContain(`<abbr class="age-est" title="${ESTIMATED_NOTE}">est.</abbr>`);
    expect(html).toContain('<span class="visually-hidden">16 laps on a used set (3 laps before this stint)</span>');
    expect(html).toContain('<span class="visually-hidden">13 laps on the set</span>');
    expect(html).toContain(`<span class="visually-hidden">13 laps, ${ESTIMATED_NOTE}</span>`);
    expect(html).toContain('<span class="visually-hidden">tyre age unknown</span>');
  });

  it("the tyre panel shows the same value with its unit and sizes the bar from it", () => {
    const html = renderToStaticMarkup(createElement(TyrePanel, { rows: ROWS }));
    expect(cells(html, "")).toEqual(["real", "real", "estimated", "unknown"]);
    expect(html).toContain('<span aria-hidden="true">16 laps<span class="tag tag-used">used</span></span>');
    expect(html).toContain('<span aria-hidden="true">13 laps<abbr class="age-est"');
    expect(html).toContain("width:40%"); // 16 / 40 laps, the real value
  });
});
