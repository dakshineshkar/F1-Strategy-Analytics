/** Telemetry overlay (Feature 6): guards, lane shaping, the crosshair, the readout, the summary
 * text, the URL picks, the 2024-only gate and the line styles. Invented laps only (no F1 data). */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { makeNames } from "@/components/analysis/common";
import { Lanes, ReadoutTable, TelemetryView } from "@/components/analysis/TelemetryView";
import { analysisSearch, parseAnalysisQuery } from "@/lib/analysis";
import { dark, light } from "@/lib/theme";
import {
  carStyles,
  strokesClose,
  crosshairKey,
  gainsAndLosses,
  LANES,
  laneBoxes,
  laneDomain,
  laneValues,
  lapOption,
  nearestIndex,
  onRuns,
  ONLY_2024_NOTE,
  pickLap,
  readoutAt,
  readoutText,
  signedS,
  stepPoints,
  telemetryAvailable,
  telemetryNotes,
  telemetrySummary,
  toTelemetryCompare,
  toTelemetryLaps,
  type TelemetryCompare,
  type TelemetryLap,
  type TelemetryLaps,
} from "@/lib/telemetry";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

function summary(lap: number, over: Partial<TelemetryLap> = {}): TelemetryLap {
  return {
    lap,
    lap_time_s: 90 + lap / 10,
    trace_time_s: 90 + lap / 10,
    lap_length_m: 1000,
    n_samples: 700,
    max_gap_s: 0.3,
    coverage: "full",
    is_pit_in_lap: false,
    is_pit_out_lap: false,
    is_deleted: false,
    is_neutralised_lap: false,
    is_red_flag_lap: false,
    compound: "SOFT",
    tyre_life_laps: lap,
    top_speed_kph: 300,
    top_speed_at_m: 800,
    min_corner_speed_kph: 80,
    min_corner_at_m: 400,
    full_throttle_share: 0.6,
    brake_share: 0.1,
    drs_share: 0,
    n_braking_zones: 2,
    ...over,
  };
}

const D = Array.from({ length: 11 }, (_, i) => i * 100); // 0..1000 m
function car(code: string, lap: number, speed: number[], over: Record<string, unknown> = {}) {
  return {
    driver_id: code.toLowerCase(),
    driver_code: code,
    lap,
    summary: summary(lap),
    own_distance_m: D,
    elapsed_s: D.map((d) => d / 50),
    speed_kph: speed,
    throttle_pct: D.map((d) => (d < 500 ? 100 : 30)),
    rpm: D.map((d) => 10000 + d),
    brake: D.map((d) => (d >= 300 && d < 500 ? 1 : 0)),
    n_gear: D.map((d) => (d < 500 ? 7 : 4)),
    drs: D.map((d) => (d >= 800 ? 1 : 0)),
    braking_start_m: [300],
    braking_end_m: [500],
    braking_apex_kph: [80],
    ...over,
  };
}

const RAW_COMPARE = {
  season: 2024,
  round: 5,
  is_synthetic: false,
  grid_step_m: 5,
  distance_m: D,
  a: car("ALP", 12, D.map(() => 180)),
  b: car("BRA", 14, D.map(() => 175)),
  delta_s: [0, -0.01, -0.03, -0.02, 0.05, 0.08, 0.06, 0.04, 0.03, 0.0, -0.2],
  segments: [
    { index: 0, start_m: 0, end_m: 250, delta_change_s: -0.02 },
    { index: 1, start_m: 250, end_m: 500, delta_change_s: 0.08 },
    { index: 2, start_m: 500, end_m: 750, delta_change_s: -0.0004 },
    { index: 3, start_m: 750, end_m: 1000, delta_change_s: -0.258 },
  ],
  final_delta_s: -0.2,
  lap_time_delta_s: -0.2,
};
const COMPARE = toTelemetryCompare(RAW_COMPARE) as TelemetryCompare;

const LAPS_DOC = {
  season: 2024,
  round: 5,
  driver_id: "alp",
  driver_code: "ALP",
  is_synthetic: false,
  source: "tracinginsights",
  grid_step_m: 5,
  fastest_lap: 3,
  rows: [summary(1), summary(2, { is_pit_in_lap: true }), summary(3), summary(4, { coverage: "partial", is_deleted: true })],
};

const NAMES = makeNames(
  {
    alp: { driver_id: "alp", code: "ALP", constructor_id: "team_a", team_colour_hex: "#3366ff" } as never,
    bra: { driver_id: "bra", code: "BRA", constructor_id: "team_a", team_colour_hex: "#3366ff" } as never,
  },
  new Map(),
);

// ------------------------------------------------------------------ guards
describe("guards", () => {
  it("accept the API shapes", () => {
    expect(COMPARE).toBeDefined();
    expect(COMPARE.a.summary.lap).toBe(12);
    const laps = toTelemetryLaps(LAPS_DOC);
    expect(laps?.rows.map((r) => r.lap)).toEqual([1, 2, 3, 4]);
    expect(laps?.fastest_lap).toBe(3);
  });

  it("reject unequal lanes, a bad code, an unknown coverage or source", () => {
    expect(toTelemetryCompare({ ...RAW_COMPARE, delta_s: [0, 1] })).toBeUndefined();
    expect(toTelemetryCompare({ ...RAW_COMPARE, a: car("ALP", 12, [180]) })).toBeUndefined();
    expect(toTelemetryCompare({ ...RAW_COMPARE, b: { ...RAW_COMPARE.b, driver_code: "bra" } })).toBeUndefined();
    expect(toTelemetryCompare({ ...RAW_COMPARE, distance_m: [0] , delta_s: [0] })).toBeUndefined();
    expect(toTelemetryCompare({ ...RAW_COMPARE, segments: [{ index: 0 }] })).toBeUndefined();
    expect(toTelemetryLaps({ ...LAPS_DOC, rows: [{ ...summary(1), coverage: "none" }] })).toBeUndefined();
    expect(toTelemetryLaps({ ...LAPS_DOC, source: "fastf1" })).toBeUndefined();
    expect(toTelemetryLaps({ ...LAPS_DOC, rows: [{ ...summary(1), brake_share: 1.5 }] })).toBeUndefined();
    expect(toTelemetryLaps(null)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ lanes
describe("lane shaping", () => {
  it("has the seven lanes in order, stacked with gaps", () => {
    expect(LANES.map((l) => l.id)).toEqual(["speed", "throttle", "brake", "gear", "rpm", "drs", "delta"]);
    const { boxes, bottom } = laneBoxes(8);
    expect(boxes[0]).toMatchObject({ top: 8, bottom: 158 });
    expect(boxes[1]?.top).toBe(170);
    expect(bottom).toBe(8 + LANES.reduce((s, l) => s + l.height, 0) + 12 * (LANES.length - 1));
  });

  it("domains: speed to the top (+5%, 20 km/h steps), fixed throttle/gear/bands, rpm in 1,000s, symmetric delta", () => {
    expect(laneDomain(COMPARE, "speed")).toEqual([0, 200]);
    expect(laneDomain(COMPARE, "throttle")).toEqual([0, 100]);
    expect(laneDomain(COMPARE, "brake")).toEqual([0, 1]);
    expect(laneDomain(COMPARE, "gear")).toEqual([0.5, 8.5]);
    expect(laneDomain(COMPARE, "rpm")).toEqual([10000, 11000]);
    expect(laneDomain(COMPARE, "delta")).toEqual([-0.2, 0.2]);
    const flat = { ...COMPARE, delta_s: D.map(() => 0) };
    expect(laneDomain(flat, "delta")).toEqual([-0.1, 0.1]);
  });

  it("values per car, the delta shared", () => {
    expect(laneValues(COMPARE, "speed", "b")[0]).toBe(175);
    expect(laneValues(COMPARE, "delta", "a")).toBe(COMPARE.delta_s);
    expect(laneValues(COMPARE, "delta", "b")).toBe(COMPARE.delta_s);
  });

  it("on/off runs and step points", () => {
    expect(onRuns(D, COMPARE.a.brake)).toEqual([[300, 500]]);
    expect(onRuns(D, COMPARE.a.drs)).toEqual([[800, 1000]]);
    expect(onRuns([0, 5, 10], [1, 1, 1])).toEqual([[0, 10]]);
    expect(onRuns([0, 5], [0, 0])).toEqual([]);
    expect(stepPoints([0, 5, 10], [3, 4, 5])).toEqual([
      { d: 0, v: 3 },
      { d: 5, v: 3 },
      { d: 5, v: 4 },
      { d: 10, v: 4 },
      { d: 10, v: 5 },
    ]);
  });
});

// ------------------------------------------------------------------ crosshair
describe("crosshair", () => {
  it("finds the nearest point", () => {
    expect(nearestIndex(D, -5)).toBe(0);
    expect(nearestIndex(D, 149)).toBe(1);
    expect(nearestIndex(D, 151)).toBe(2);
    expect(nearestIndex(D, 150)).toBe(1); // a tie goes to the earlier point
    expect(nearestIndex(D, 5000)).toBe(10);
    expect(nearestIndex([], 3)).toBe(0);
  });

  it("moves by key: 5 m, Shift 50 m, Page 250 m, Home/End; other keys do nothing", () => {
    const grid = Array.from({ length: 201 }, (_, i) => i * 5); // 0..1000 m every 5 m
    expect(crosshairKey("ArrowRight", false, 10, grid)).toBe(11);
    expect(crosshairKey("ArrowLeft", false, 10, grid)).toBe(9);
    expect(crosshairKey("ArrowRight", true, 10, grid)).toBe(20);
    expect(crosshairKey("ArrowDown", true, 10, grid)).toBe(0);
    expect(crosshairKey("PageUp", false, 10, grid)).toBe(60);
    expect(crosshairKey("PageDown", false, 10, grid)).toBe(0);
    expect(crosshairKey("Home", false, 77, grid)).toBe(0);
    expect(crosshairKey("End", false, 0, grid)).toBe(200);
    expect(crosshairKey("ArrowRight", false, 200, grid)).toBe(200);
    expect(crosshairKey("a", false, 3, grid)).toBeNull();
    expect(crosshairKey("End", false, 0, [])).toBeNull();
  });

  it("reads every channel of both laps at an index (clamped)", () => {
    const r = readoutAt(COMPARE, 4);
    expect(r).toMatchObject({ index: 4, distance: 400, delta: 0.05 });
    expect(r.a).toMatchObject({ code: "ALP", lap: 12, speed: 180, throttle: 100, brake: true, gear: 7, rpm: 10400, drs: false });
    expect(r.b.speed).toBe(175);
    expect(readoutAt(COMPARE, 99).index).toBe(10);
    expect(readoutAt(COMPARE, -3).index).toBe(0);
    expect(readoutText(r)).toBe("400 m: ALP 180.0 km/h, BRA 175.0 km/h, delta +0.050 s");
  });
});

// ------------------------------------------------------------------ text
describe("summary text", () => {
  it("signs seconds with a real minus", () => {
    expect(signedS(0.1234)).toBe("+0.123 s");
    expect(signedS(-0.2)).toBe("−0.200 s");
    expect(signedS(0.0001)).toBe("±0.000 s");
  });

  it("gains and losses ignore changes under 1 ms, largest first", () => {
    const { gains, losses } = gainsAndLosses(COMPARE.segments);
    expect(gains.map((s) => s.index)).toEqual([3, 0]);
    expect(losses.map((s) => s.index)).toEqual([1]);
  });

  it("names lap times, top speeds, corners, throttle, gains, losses and the line", () => {
    const text = telemetrySummary(COMPARE);
    expect(text[0]).toBe("Lap times: ALP lap 12 1:31.200, BRA lap 14 1:31.400 (ALP lap 12 −0.200 s).");
    expect(text).toContain("Top speed: ALP lap 12 300.0 km/h at 800 m, BRA lap 14 300.0 km/h at 800 m.");
    expect(text).toContain("Slowest corner: ALP lap 12 80.0 km/h, BRA lap 14 80.0 km/h.");
    expect(text).toContain("Full throttle: ALP lap 12 60% of the lap, BRA lap 14 60%.");
    expect(text).toContain("ALP lap 12 gains most at 750–1,000 m (−0.258 s), 0–250 m (−0.020 s).");
    expect(text).toContain("ALP lap 12 loses most at 250–500 m (+0.080 s).");
    expect(text[text.length - 1]).toBe("At the line ALP lap 12 is 0.200 s ahead.");
    const level = telemetrySummary({ ...COMPARE, final_delta_s: 0, segments: [], lap_time_delta_s: null });
    expect(level).toContain("At the line they are level.");
    expect(level).toContain("ALP lap 12 gains time in no mini-sector.");
  });

  it("notes synthetic data, gaps, pit laps and lap 1", () => {
    expect(telemetryNotes(COMPARE)).toEqual([]);
    const notes = telemetryNotes({
      ...COMPARE,
      is_synthetic: true,
      a: { ...COMPARE.a, lap: 1, summary: summary(1, { coverage: "partial" }) },
      b: { ...COMPARE.b, summary: summary(14, { is_pit_out_lap: true }) },
    });
    expect(notes[0]).toMatch(/^SYNTHETIC/);
    expect(notes.join(" ")).toMatch(/ALP lap 1 has gaps/);
    expect(notes.join(" ")).toMatch(/ALP lap 1 starts from the grid slot/);
    expect(notes.join(" ")).toMatch(/BRA lap 14 is a pit lap/);
  });
});

// ------------------------------------------------------------------ picks
describe("picking laps and the URL", () => {
  const laps = toTelemetryLaps(LAPS_DOC) as TelemetryLaps;

  it("defaults to the fastest lap, keeps a valid choice, falls back to the first", () => {
    expect(pickLap(laps, null)).toBe(3);
    expect(pickLap(laps, 2)).toBe(2);
    expect(pickLap(laps, 99)).toBe(3);
    expect(pickLap({ ...laps, fastest_lap: null }, null)).toBe(1);
    expect(pickLap({ ...laps, rows: [] }, 2)).toBeNull();
    expect(pickLap(null, 2)).toBeNull();
  });

  it("labels laps with their marks", () => {
    expect(lapOption(summary(3), 3)).toBe("3 · 1:30.300 (fastest)");
    expect(lapOption(summary(2, { is_pit_in_lap: true }), 3)).toBe("2 · 1:30.200 (pit in)");
    expect(lapOption(summary(4, { coverage: "partial", is_deleted: true }), 3)).toBe("4 · 1:30.400 (deleted, gaps)");
    expect(lapOption(summary(5, { lap_time_s: null }), 3)).toBe("5 · no time");
  });

  it("keeps the picks in the URL", () => {
    const q = parseAnalysisQuery({ view: "telemetry", ta: "VER", talap: "33", tb: "NOR", tblap: "x" });
    expect(q).toMatchObject({ view: "telemetry", ta: "VER", talap: 33, tb: "NOR", tblap: null });
    expect(analysisSearch({ view: "telemetry", ta: "VER", talap: 33, tb: "VER", tblap: 40 })).toBe(
      "?view=telemetry&ta=VER&talap=33&tb=VER&tblap=40",
    );
  });

  it("is available for 2024 only", () => {
    expect(telemetryAvailable(2024)).toBe(true);
    for (const s of [2021, 2023, 2025]) expect(telemetryAvailable(s)).toBe(false);
  });

  it("A solid, B dashed, whatever the colours", () => {
    const team = carStyles({ colour: "#3366ff" }, { colour: "#3366ff" });
    expect(team.a.dash).toBe("");
    expect(team.b.dash).not.toBe("");
    expect(team.closeColours).toBe(true);
    const none = carStyles(null, null);
    expect([none.a.colour, none.b.colour]).toEqual(["var(--text)", "var(--text)"]);
    expect([none.a.neutral, none.b.neutral]).toEqual([true, true]);
    expect(none.closeColours).toBe(true);
  });

  it("a car without a team colour is neutral text ink, never a chart-line colour next to a team colour", () => {
    for (const [a, b] of [
      [{ colour: "#3671c6" }, null],
      [null, { colour: "#ff8000" }],
    ] as const) {
      const s = carStyles(a, b);
      expect([s.a.colour, s.b.colour].join(" ")).not.toMatch(/--line-/);
      expect([s.a.colour, s.b.colour]).toContain("var(--text)");
      expect(s.a.dash).toBe("");
      expect(s.b.dash).toBe("6 4");
    }
    // a team colour stands apart from the neutral ink; a white one does not in dark (the legend then says so)
    expect(carStyles({ colour: "#3671c6" }, null).closeColours).toBe(false);
    expect(carStyles({ colour: "#ff8000" }, null).closeColours).toBe(false);
    expect(carStyles({ colour: "#4e7c9b" }, null).closeColours).toBe(false);
    expect(carStyles({ colour: "#ffffff" }, null).closeColours).toBe(true);
    // Mercedes teal is far from the ink with normal vision (17.3) but not under protanopia (4.2 in the validator)
    expect(carStyles({ colour: "#27f4d2" }, null).closeColours).toBe(true);
    expect(carStyles({ colour: dark.text }, null).closeColours).toBe(true);
    expect(carStyles(null, { colour: light.text }).closeColours).toBe(true);
  });

  it("strokesClose: equal, near and far colours; a value it cannot measure is not close", () => {
    expect(strokesClose("#3366ff", "#3366ff")).toBe(true);
    expect(strokesClose("#3366ff", "#3467fe")).toBe(true);
    expect(strokesClose("#3366ff", "#ff8000")).toBe(false);
    expect(strokesClose("var(--text)", "var(--text)")).toBe(true);
    expect(strokesClose("var(--line-0)", "#ff8000")).toBe(false);
  });
});

// ------------------------------------------------------------------ rendering
describe("rendering", () => {
  it("other seasons show the 2024-only note and no pickers", () => {
    const m = html(
      createElement(TelemetryView, {
        season: 2023,
        round: 5,
        order: ["alp", "bra"],
        names: NAMES,
        pick: { ta: null, talap: null, tb: null, tblap: null },
        onPick: () => undefined,
      }),
    );
    expect(m).toContain(ONLY_2024_NOTE);
    expect(m).not.toContain("<select");
  });

  it("2024 shows both pickers and a loading state before data arrives", () => {
    const m = html(
      createElement(TelemetryView, {
        season: 2024,
        round: 5,
        order: ["alp", "bra"],
        names: NAMES,
        pick: { ta: null, talap: null, tb: null, tblap: null },
        onPick: () => undefined,
      }),
    );
    expect(m).toContain("Lap A (solid line)");
    expect(m).toContain("Lap B (dashed line)");
    expect(m).toContain("Loading the telemetry…");
    expect(m).not.toContain(ONLY_2024_NOTE);
  });

  it("the lanes: a keyboard slider over seven lanes, A solid and B dashed", () => {
    const styles = carStyles({ colour: "#3366ff" }, { colour: "#3366ff" });
    const m = html(createElement(Lanes, { compare: COMPARE, styles, index: 4, onIndex: () => undefined, describedBy: "sum" }));
    expect(m).toContain('role="slider"');
    expect(m).toContain('tabindex="0"');
    expect(m).toContain('aria-valuetext="400 m: ALP 180.0 km/h, BRA 175.0 km/h, delta +0.050 s"');
    expect(m).toContain('aria-valuenow="400"');
    expect(m).toContain('aria-valuemax="1000"');
    for (const l of LANES) expect(m).toContain(`>${l.label}</text>`);
    expect(m).toContain('stroke-dasharray="6 4"');
    expect(m).toContain("↑ A behind");
  });

  it("the readout table lists every channel of both laps", () => {
    const m = html(createElement(ReadoutTable, { compare: COMPARE, index: 4 }));
    expect(m).toContain("<caption>Values at 400 m (lap A&#x27;s distance)</caption>");
    for (const name of ["Lap distance", "Elapsed", "Speed", "Throttle", "Brake", "Gear", "RPM", "DRS", "Delta (A − B)"])
      expect(m).toContain(`<th scope="row">${name}</th>`);
    expect(m).toContain("+0.050 s (A behind)");
    expect(m).toContain("A · ALP 12");
    expect(m).toContain("B · BRA 14");
  });
});
