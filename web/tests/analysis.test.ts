import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisPage } from "@/components/analysis/AnalysisPage";
import { ChartHover, readoutSentence } from "@/components/analysis/ChartHover";
import { RaceSubHead } from "@/components/RaceSubHead";
import { makeNames } from "@/components/analysis/common";
import { compareText, CompareView } from "@/components/analysis/CompareView";
import { DegradationChart, fitText } from "@/components/analysis/DegradationChart";
import { LapTimesChart } from "@/components/analysis/LapTimesChart";
import { PitStopsTable } from "@/components/analysis/PitStopsTable";
import { PositionsChart } from "@/components/analysis/PositionsChart";
import { clock, RaceControlList } from "@/components/analysis/RaceControlList";
import { StrategyChart, stopSummary } from "@/components/analysis/StrategyChart";
import {
  analysisSearch,
  codeIndex,
  compareSummary,
  compoundKey,
  compoundLetter,
  coverageNotes,
  degradation,
  lapList,
  lapSeries,
  lapTimeDomain,
  lapTimesSummary,
  neutralRanges,
  parseAnalysisQuery,
  pitStopsSummary,
  positionLines,
  positionsSummary,
  raceControlRows,
  sectorTotals,
  signed,
  slopeText,
  strategyRows,
  tabKeyTarget,
  teamStyles,
  toAnalysisLap,
  toCompare,
  toLapsDoc,
  toPositionsDoc,
  toRaceControlDoc,
  toStintsDoc,
  VIEWS,
  type AnalysisLap,
  type Compare,
  type CompareLap,
  type Coverage,
  type PitStop,
  type PositionSeries,
  type RaceControlMsg,
  type Stint,
} from "@/lib/analysis";
import { hoverKey, linear, median, nearestPoint, niceTicks, pathOf, spreadLabels } from "@/lib/plot";
import { COMPOUND_TOKENS, contrastRatio, dark, inkOn, light, themeCss } from "@/lib/theme";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// ------------------------------------------------------------------ invented fixtures (no F1 data)
const COVERAGE: Coverage = {
  n_drivers: 2,
  n_laps: 6,
  n_lap_rows: 12,
  tyre_source: "tracinginsights",
  is_synthetic: false,
  has_sectors: true,
  has_speed_traps: true,
  deleted_known: true,
  neutralised_source: "track_status",
  n_race_control: 2,
  n_pitstops: 1,
  n_quick_laps: 6,
  n_ti_only_laps_dropped: 0,
};
const SYNTH: Coverage = {
  ...COVERAGE,
  tyre_source: "synthetic",
  is_synthetic: true,
  has_sectors: false,
  has_speed_traps: false,
  deleted_known: false,
  neutralised_source: "heuristic",
  n_race_control: 0,
};

function lap(driver: string, n: number, time: number, over: Partial<AnalysisLap> = {}): AnalysisLap {
  return {
    driver_id: driver,
    driver_code: driver.slice(0, 3).toUpperCase(),
    lap: n,
    position: driver === "alpha" ? 1 : 2,
    lap_time_s: time,
    cumulative_time_s: null,
    gap_to_leader_s: null,
    sector1_s: 30,
    sector2_s: 30,
    sector3_s: 30,
    speed_i1_kph: null,
    speed_i2_kph: null,
    speed_fl_kph: null,
    speed_st_kph: 320,
    stint: n <= 3 ? 1 : 2,
    compound: n <= 3 ? "MEDIUM" : "HARD",
    tyre_life_laps: n <= 3 ? n : n - 3,
    compound_source: "tracinginsights",
    is_synthetic: false,
    is_pit_in_lap: false,
    is_pit_out_lap: false,
    is_deleted: false,
    deleted_reason: null,
    track_status: "1",
    is_sc_lap: false,
    is_vsc_lap: false,
    is_red_flag_lap: false,
    is_neutralised_lap: false,
    neutralised_source: "track_status",
    is_quick_lap: true,
    quick_lap_exclusion: null,
    ...over,
  };
}

const SC = { is_sc_lap: true, is_neutralised_lap: true, is_quick_lap: false, quick_lap_exclusion: "neutralised" } as const;
const LAPS: AnalysisLap[] = [
  lap("alpha", 1, 100, { is_quick_lap: false, quick_lap_exclusion: "lap_1" }),
  lap("alpha", 2, 90.2),
  lap("alpha", 3, 110, { is_pit_in_lap: true, is_quick_lap: false, quick_lap_exclusion: "pit_in" }),
  lap("alpha", 4, 120, { ...SC, is_pit_out_lap: true, quick_lap_exclusion: "pit_out" }),
  lap("alpha", 5, 130, SC),
  lap("alpha", 6, 89.0),
  lap("bravo", 1, 101, { is_quick_lap: false, quick_lap_exclusion: "lap_1" }),
  lap("bravo", 2, 91),
  lap("bravo", 3, 91.5),
  lap("bravo", 4, 131, SC),
  lap("bravo", 5, 131.5, SC),
  lap("bravo", 6, 90, { is_deleted: true, is_quick_lap: false, quick_lap_exclusion: "deleted" }),
];

function stint(driver: string, n: number, over: Partial<Stint> = {}): Stint {
  return {
    driver_id: driver,
    driver_code: driver.slice(0, 3).toUpperCase(),
    stint: n,
    compound: n === 1 ? "MEDIUM" : "HARD",
    start_lap: n === 1 ? 1 : 4,
    end_lap: n === 1 ? 3 : 6,
    laps: 3,
    tyre_life_start: 1,
    tyre_life_end: 3,
    used_set: n === 1,
    ends_in_pit: n === 1,
    n_quick_laps: 5,
    deg_slope_s_per_lap: 0.0834,
    deg_intercept_s: 90,
    median_quick_lap_s: 90.5,
    fit_status: "ok",
    compound_source: "tracinginsights",
    is_synthetic: false,
    ...over,
  };
}
const STINTS: Stint[] = [stint("alpha", 2), stint("alpha", 1), stint("bravo", 1, { fit_status: "too_few_laps", n_quick_laps: 2, deg_slope_s_per_lap: null, deg_intercept_s: null })];
const PITS: PitStop[] = [
  {
    driver_id: "alpha",
    driver_code: "ALP",
    stop: 1,
    lap: 3,
    time_of_day: "15:10:00",
    duration_s: 22.4,
    is_long_stop: false,
    under_neutralisation: false,
    compound_before: "MEDIUM",
    compound_after: "HARD",
    tyre_life_before: 3,
    position_before: 1,
    position_after: 1,
  },
];
const RC: RaceControlMsg[] = [
  { seq: 0, lap: 1, time_utc: "2024-04-21T07:03:36.000Z", category: "Other", message: "DRS ENABLED", status: null, flag: null, scope: null, driver_id: null, driver_code: null, kind: "other", is_key: false },
  { seq: 1, lap: 4, time_utc: "2024-04-21T07:40:00.000Z", category: "SafetyCar", message: "SAFETY CAR DEPLOYED", status: "DEPLOYED", flag: null, scope: null, driver_id: null, driver_code: null, kind: "sc_deployed", is_key: true },
];
const POSITIONS: PositionSeries[] = [
  { driver_id: "alpha", driver_code: "ALP", grid: 2, positions: [1, 2, 3, 4, 5, 6].map((l) => ({ lap: l, position: 1 })) },
  { driver_id: "bravo", driver_code: "BRA", grid: 0, positions: [1, 2, 3, 4, 5, 6].map((l) => ({ lap: l, position: 2 })) },
];
const CMP_ROWS: CompareLap[] = [
  { lap: 1, a_lap_time_s: 100, b_lap_time_s: 101, delta_s: -1, gap_s: -1, sector1_delta_s: null, sector2_delta_s: -0.4, sector3_delta_s: -0.6, a_position: 1, b_position: 2, a_compound: "MEDIUM", b_compound: "MEDIUM", a_pit: false, b_pit: false, neutralised: false },
  { lap: 2, a_lap_time_s: 92, b_lap_time_s: 91, delta_s: 1, gap_s: 0, sector1_delta_s: 0.5, sector2_delta_s: 0.25, sector3_delta_s: 0.25, a_position: 1, b_position: 2, a_compound: "MEDIUM", b_compound: "MEDIUM", a_pit: true, b_pit: false, neutralised: false },
  { lap: 3, a_lap_time_s: 90, b_lap_time_s: 92.5, delta_s: -2.5, gap_s: -2.5, sector1_delta_s: -1, sector2_delta_s: -1, sector3_delta_s: -0.5, a_position: 1, b_position: 2, a_compound: "HARD", b_compound: "MEDIUM", a_pit: false, b_pit: false, neutralised: true },
];
const COMPARE: Compare = {
  season: 2024,
  round: 5,
  coverage: COVERAGE,
  a: { driver_id: "alpha", driver_code: "ALP" },
  b: { driver_id: "bravo", driver_code: "BRA" },
  rows: CMP_ROWS,
};
const NAMES = makeNames(null, codeIndex(LAPS));
const doc = <T,>(rows: T[], coverage: Coverage = COVERAGE) => ({ season: 2024, round: 5, coverage, rows });

// ------------------------------------------------------------------ guards
describe("analysis guards", () => {
  it("accept valid documents and reject one bad row", () => {
    expect(toLapsDoc(doc(LAPS))?.rows).toHaveLength(12);
    expect(toStintsDoc(doc(STINTS))?.rows).toHaveLength(3);
    expect(toRaceControlDoc(doc(RC))?.rows[1]?.kind).toBe("sc_deployed");
    expect(toPositionsDoc(doc(POSITIONS))?.rows[1]?.grid).toBe(0);
    expect(toCompare(COMPARE)?.a.driver_code).toBe("ALP");
    expect(toLapsDoc(doc([...LAPS, { ...LAPS[0], compound: "HYPERSOFT" }]))).toBeUndefined();
    expect(toLapsDoc(doc(LAPS, { ...COVERAGE, tyre_source: "fastf1" } as unknown as Coverage))).toBeUndefined();
    expect(toLapsDoc({ season: 2024, round: 5, rows: [] })).toBeUndefined(); // no coverage
    expect(toPositionsDoc(doc([{ ...POSITIONS[0], positions: [{ lap: 0, position: 1 }] }]))).toBeUndefined();
    expect(toCompare({ ...COMPARE, a: { driver_id: "alpha", driver_code: "alp" } })).toBeUndefined();
    expect(toRaceControlDoc(doc([{ ...RC[0], kind: "weather" }]))).toBeUndefined();
  });

  it("drops unknown fields and rejects missing ones and NaN", () => {
    const row = toAnalysisLap({ ...LAPS[1], extra: 1 });
    expect(row && "extra" in row).toBe(false);
    const missing: Partial<AnalysisLap> = { ...LAPS[1] };
    delete missing.lap_time_s;
    expect(toAnalysisLap(missing)).toBeUndefined();
    expect(toAnalysisLap({ ...LAPS[1], lap_time_s: Number.NaN })).toBeUndefined();
  });
});

// ------------------------------------------------------------------ tabs and URL
describe("tabs and the URL", () => {
  it("arrow keys wrap, Home/End jump, other keys do nothing", () => {
    expect(VIEWS).toHaveLength(8);
    expect(VIEWS[7]).toEqual({ id: "telemetry", label: "Telemetry" });
    expect(tabKeyTarget("ArrowRight", 6, 7)).toBe(0);
    expect(tabKeyTarget("ArrowLeft", 0, 7)).toBe(6);
    expect(tabKeyTarget("ArrowDown", 2, 7)).toBe(3);
    expect(tabKeyTarget("Home", 4, 7)).toBe(0);
    expect(tabKeyTarget("End", 1, 7)).toBe(6);
    expect(tabKeyTarget("a", 1, 7)).toBeNull();
    expect(tabKeyTarget("Home", 0, 0)).toBeNull();
  });

  it("parses and writes the query, dropping invalid values", () => {
    expect(parseAnalysisQuery({ view: "laps", lap: "23", a: "VER", b: "NOR", driver: "HAM" })).toEqual({
      view: "laps",
      lap: 23,
      a: "VER",
      b: "NOR",
      driver: "HAM",
      ta: null,
      talap: null,
      tb: null,
      tblap: null,
    });
    expect(parseAnalysisQuery({ view: "x", lap: "0", a: "ver", b: ["NOR"], driver: "HAMI" })).toEqual({
      view: "strategy",
      lap: null,
      a: null,
      b: null,
      driver: null,
      ta: null,
      talap: null,
      tb: null,
      tblap: null,
    });
    expect(analysisSearch({ view: "laps", lap: 7 })).toBe("?view=laps&lap=7");
    expect(analysisSearch({ view: "compare", a: "VER", b: "NOR", lap: null })).toBe("?view=compare&a=VER&b=NOR");
  });
});

// ------------------------------------------------------------------ shaping
describe("chart data shaping", () => {
  it("strategy rows follow the finishing order with sorted stints and pit laps", () => {
    const rows = strategyRows(STINTS, PITS, ["bravo", "alpha"]);
    expect(rows.map((r) => r.driverId)).toEqual(["bravo", "alpha"]);
    expect(rows[1]?.stints.map((s) => [s.stint, s.compound, s.start, s.end, s.used])).toEqual([
      [1, "MEDIUM", 1, 3, true],
      [2, "HARD", 4, 6, false],
    ]);
    expect(rows[1]?.pitLaps).toEqual([3]);
    expect(strategyRows(STINTS, [], ["zulu"]).map((r) => r.driverId)).toEqual(["zulu", "alpha", "bravo"]);
    expect(stopSummary(rows)).toBe("0 stops: 1 driver · 1 stop: 1 driver");
  });

  it("neutral ranges come from the leader's laps and merge", () => {
    expect(neutralRanges(LAPS)).toEqual([{ from: 4, to: 5, kind: "SC" }]);
    const heur = LAPS.map((l) => (l.is_sc_lap ? { ...l, is_sc_lap: null, neutralised_source: "heuristic" as const } : l));
    expect(neutralRanges(heur)).toEqual([{ from: 4, to: 5, kind: "NEUTRALISED" }]);
    const red = LAPS.map((l) => (l.lap === 5 ? { ...l, is_red_flag_lap: true } : l));
    expect(neutralRanges(red)).toEqual([
      { from: 4, to: 4, kind: "SC" },
      { from: 5, to: 5, kind: "RED" },
    ]);
  });

  it("lap series and the lap-time axis that pins slow laps", () => {
    const [a] = lapSeries(LAPS, ["alpha"]);
    expect(a?.points.map((p) => p.pit)).toEqual([null, null, "in", "out", null, null]);
    expect(a?.points[4]?.neutralised).toBe(true);
    const dom = lapTimeDomain([89, 90, 91, 92, 130]);
    expect(dom.lo).toBe(89);
    expect(dom.hi).toBeLessThan(130);
    expect(dom.above).toBe(1);
    expect(lapTimeDomain([])).toEqual({ lo: 0, hi: 1, above: 0 });
  });

  it("degradation uses quick laps per stint, the stored fit and grouped exclusions", () => {
    const d = degradation(LAPS, STINTS, "alpha");
    expect(d.stints.map((s) => s.stint)).toEqual([1, 2]);
    expect(d.stints[0]?.points).toEqual([{ life: 2, time: 90.2, lap: 2 }]);
    expect(d.stints[1]?.fit).toEqual({ slope: 0.0834, intercept: 90, x0: 3, x1: 3 });
    expect(d.excluded).toEqual([
      { reason: "lap_1", laps: [1] },
      { reason: "pit_in", laps: [3] },
      { reason: "pit_out", laps: [4] },
      { reason: "neutralised", laps: [5] },
    ]);
    const b = degradation(LAPS, STINTS, "bravo");
    expect(b.stints[0]?.fit).toBeNull();
    expect(fitText(b.stints[0] as (typeof b.stints)[number])).toBe("no fit: 2 quick laps (at least 5 needed)");
    expect(fitText(d.stints[1] as (typeof d.stints)[number])).toBe("+0.083 s/lap over 5 quick laps");
    expect(b.excluded.find((e) => e.reason === "deleted")?.laps).toEqual([6]);
  });

  it("positions put the grid at lap 0 and a pit-lane start at the back", () => {
    const lines = positionLines(POSITIONS);
    expect(lines[0]?.points[0]).toEqual({ lap: 0, position: 2 });
    expect(lines[1]?.points[0]).toEqual({ lap: 0, position: 2 });
    expect(lines[1]?.pitLaneStart).toBe(true);
    expect(positionLines([{ ...POSITIONS[0], grid: null } as PositionSeries])[0]?.points[0]).toEqual({ lap: 1, position: 1 });
  });

  it("team styles: team colour, the second teammate dashed", () => {
    const team = (id: string) => (id === "zulu" ? null : { team: id === "carol" ? "b" : "a", colour: "#123456" });
    const s = teamStyles(["bravo", "alpha", "carol", "zulu"], team);
    expect(s.get("alpha")).toEqual({ colour: "#123456", dash: "" });
    expect(s.get("bravo")).toEqual({ colour: "#123456", dash: "6 4" });
    expect(s.get("carol")?.dash).toBe("");
    expect(s.get("zulu")).toEqual({ colour: null, dash: "" });
  });

  it("compare summary and sector totals", () => {
    expect(compareSummary(CMP_ROWS)).toEqual({ laps: 3, aFaster: 2, bFaster: 1, medianDelta: -1, finalGap: -2.5, finalLap: 3 });
    expect(sectorTotals(CMP_ROWS)).toEqual([
      { sector: 1, total: -0.5, laps: 2 },
      { sector: 2, total: -1.15, laps: 3 },
      { sector: 3, total: -0.85, laps: 3 },
    ]);
    expect(compareText(COMPARE)).toBe(
      "On 3 laps with both times, ALP was faster on 2 and BRA on 1. Median lap delta (ALP − BRA): −1.000 s. After lap 3, ALP was 2.500 s ahead of BRA.",
    );
  });

  it("labels and notes", () => {
    expect(raceControlRows(RC, false).map((r) => r.seq)).toEqual([1]);
    expect(raceControlRows(RC, true)).toHaveLength(2);
    expect(slopeText(0.08345)).toBe("+0.083 s/lap");
    expect(slopeText(-0.02)).toBe("−0.020 s/lap");
    expect(signed(1.5)).toBe("+1.500");
    expect(signed(0)).toBe("±0.000");
    expect(lapList([10, 1, 6, 7, 7])).toBe("1, 6–7, 10");
    expect(compoundKey("INTERMEDIATE")).toBe("inter");
    expect(compoundKey(null)).toBe("unknown");
    expect(compoundLetter(null)).toBe("?");
    expect(clock("2024-04-21T07:03:36.000Z")).toBe("07:03:36");
    expect(clock(null)).toBe("—");
    expect(coverageNotes(COVERAGE)).toEqual([]);
    expect(coverageNotes(SYNTH)).toEqual([
      "SYNTHETIC: compounds and tyre ages here are generated, not real tyre data.",
      "No sector times in this lake.",
      "Deleted laps are unknown in this lake.",
      "Neutralised laps are estimated from lap times (no race-control data): SC and VSC cannot be told apart.",
      "No race-control messages in this lake.",
    ]);
  });
});

describe("text summaries (Step 4B)", () => {
  const code = NAMES.code;

  it("lap times: best lap and the median of racing laps per driver; no laps and no racing laps say so", () => {
    const lines = lapTimesSummary(lapSeries(LAPS, ["alpha", "bravo"]), code);
    // alpha: best 1:29.000 on lap 6; racing laps = 1, 2, 6 (3 pit-in, 4 pit-out + SC, 5 SC)
    expect(lines[0]).toBe("ALP: best 1:29.000 on lap 6; median 1:30.200 over 3 racing laps.");
    expect(lines[1]).toBe("BRA: best 1:30.000 on lap 6; median 1:31.250 over 4 racing laps.");
    expect(lapTimesSummary([{ driverId: "alpha", points: [] }], code)).toEqual(["ALP: no timed laps."]);
    const scOnly = lapSeries([lap("alpha", 4, 130, SC)], ["alpha"]);
    expect(lapTimesSummary(scOnly, code)).toEqual(["ALP: best 2:10.000 on lap 4; no racing laps."]);
  });

  it("positions: winner, gain from a pit-lane start, loss, and cars that stopped early", () => {
    const series: PositionSeries[] = [
      { driver_id: "alpha", driver_code: "ALP", grid: 2, positions: [{ lap: 1, position: 2 }, { lap: 2, position: 1 }] },
      { driver_id: "bravo", driver_code: "BRA", grid: 0, positions: [{ lap: 1, position: 3 }, { lap: 2, position: 2 }] },
      { driver_id: "charlie", driver_code: "CHA", grid: 1, positions: [{ lap: 1, position: 1 }, { lap: 2, position: 3 }] },
      { driver_id: "delta", driver_code: "DEL", grid: 3, positions: [{ lap: 1, position: 4 }] },
    ];
    expect(positionsSummary(series, code)).toBe(
      "ALP won from P2. Biggest gain: BRA, the pit lane to P2 (2 places). Biggest loss: CHA, P1 to P3 (2 places). " +
        "3 cars ran to lap 2; 1 stopped earlier.",
    );
    expect(positionsSummary([], code)).toBe("No positions in the lake for this race.");
    // nobody moved: no gain or loss sentence; a missing grid gives no start
    expect(positionsSummary([{ driver_id: "alpha", driver_code: "ALP", grid: null, positions: [{ lap: 1, position: 1 }] }], code)).toBe(
      "ALP won. 1 car ran to lap 1.",
    );
  });

  it("pit stops: count, drivers, SC/VSC stops and the shortest pit-lane time; null times are skipped", () => {
    const more: PitStop[] = [
      ...PITS,
      { ...(PITS[0] as PitStop), driver_id: "bravo", stop: 1, lap: 4, duration_s: 21.9, under_neutralisation: true },
      { ...(PITS[0] as PitStop), driver_id: "bravo", stop: 2, lap: 5, duration_s: null },
    ];
    expect(pitStopsSummary(more, code)).toBe("3 stops by 2 drivers; 1 under SC/VSC. Shortest pit-lane time: 21.900 s, BRA on lap 4.");
    expect(pitStopsSummary([{ ...(PITS[0] as PitStop), duration_s: null }], code)).toBe(
      "1 stop by 1 driver; 0 under SC/VSC. No pit-lane times in the lake.",
    );
    expect(pitStopsSummary([], code)).toBe("No pit stops in the lake for this race.");
  });
});

describe("plot geometry", () => {
  it("linear scales, ticks, paths, median and label spreading", () => {
    const s = linear([0, 10], [100, 200]);
    expect([s(0), s(5), s(20)]).toEqual([100, 150, 300]);
    expect(linear([0, 10], [100, 200], true)(20)).toBe(200);
    expect(linear([3, 3], [0, 10])(3)).toBe(5);
    expect(niceTicks(0, 56, 5)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(88.5, 101, 5)).toEqual([90, 92, 94, 96, 98, 100]);
    expect(niceTicks(2, 2)).toEqual([2]);
    expect(pathOf([{ a: 0, b: 1 }, { a: 1, b: null }, { a: 2, b: 3 }], (p) => p.a, (p) => p.b)).toBe("M0.00 1.00 M2.00 3.00");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    const placed = spreadLabels([{ id: "a", y: 10 }, { id: "b", y: 11 }, { id: "c", y: 200 }], 12, 0, 100);
    expect(placed.map((p) => p.y)).toEqual([10, 22, 100]);
  });
});

describe("compound colour tokens", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ] as const)("%s: every compound is >= 3:1 on the panel and its bar text >= 4.5:1", (_n, t) => {
    for (const k of COMPOUND_TOKENS) {
      expect(contrastRatio(t.compounds[k], t.surface), k).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(inkOn(t.compounds[k]), t.compounds[k]), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("are emitted as CSS variables with their ink", () => {
    expect(themeCss).toContain(`--compound-soft:${light.compounds.soft};`);
    expect(themeCss).toContain(`--compound-hard-ink:${inkOn(dark.compounds.hard)};`);
    expect(inkOn("#ffffff")).toBe("#000000");
    expect(inkOn("#000000")).toBe("#ffffff");
  });
});

// ------------------------------------------------------------------ rendered markup
describe("rendered views", () => {
  it("tyre strategy: an SVG with title and desc, letters on bars, a table, the synthetic note", () => {
    const rows = strategyRows(STINTS, PITS, ["alpha", "bravo"]);
    const m = html(createElement(StrategyChart, { rows, laps: 6, coverage: SYNTH, names: NAMES }));
    expect(m).toMatch(/<svg[^>]*role="img"[^>]*aria-labelledby="[^"]+ [^"]+"/);
    expect(m).toContain("<title");
    expect(m).toContain('<span class="stamp">SYNTHETIC</span> not real tyre data.');
    expect(m).toContain('<summary>Show table <span class="visually-hidden">: Stints by driver</span></summary>');
    // lap ticks are whole laps only (a 6-lap race had 1.5, 2.5 … before step 4B)
    expect(m).not.toMatch(/>\d+\.5<\/text>/);
    // the pit stop key is an authored triangle (the font subset has no "▼")
    expect(m).not.toContain("▼");
    expect(m).toContain('class="pit-mark"');
    expect(m).toContain("<caption>Stints by driver</caption>");
    expect((m.match(/<tr>/g) ?? []).length).toBe(3); // header + 2 drivers
    expect(m).toContain("laps 1–3 (used set)");
    expect(m).toContain(" Medium</span>"); // compound as text, not only colour
    expect(html(createElement(StrategyChart, { rows, laps: 6, coverage: COVERAGE, names: NAMES }))).not.toContain("SYNTHETIC");
  });

  it("lap times: driver checkboxes, SC band label, marked lap, compound letters in the table", () => {
    const m = html(
      createElement(LapTimesChart, {
        laps: LAPS,
        drivers: ["alpha"],
        order: ["alpha", "bravo"],
        onToggle: () => undefined,
        neutral: neutralRanges(LAPS),
        markLap: 4,
        totalLaps: 6,
        names: NAMES,
      }),
    );
    expect(m).toContain("<legend>Drivers (finishing order)</legend>");
    expect((m.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(m).toContain("Neutralised: SC laps 4–5.");
    expect(m).toContain("Lap 4 is marked.");
    expect(m).toContain('class="is-marked"');
    expect(m).toContain("1:30.200 M");
    expect(m).toContain("pit in");
  });

  it("degradation: labelled a lap-time proxy, slope as text, excluded laps listed", () => {
    const m = html(
      createElement(DegradationChart, {
        deg: degradation(LAPS, STINTS, "alpha"),
        driver: "alpha",
        order: ["alpha", "bravo"],
        onDriver: () => undefined,
        coverage: COVERAGE,
        names: NAMES,
      }),
    );
    expect(m).toContain("A lap-time proxy, not tyre wear:");
    expect(m).toContain("+0.083 s/lap");
    expect(m).toContain("lap 1 (standing start): 1; pit-in lap: 3; pit-out lap: 4; SC, VSC or red flag: 5");
    expect(m).toContain('aria-label="About the degradation slope"');
  });

  it("positions: label toggle, highlight, grid labels in the table", () => {
    const team = { ...NAMES, team: () => ({ team: "ferrari", colour: "#D9142B" }) };
    const m = html(createElement(PositionsChart, { series: POSITIONS, totalLaps: 6, names: team }));
    expect(m).toContain('role="radiogroup" aria-label="Line labels"');
    expect(m).toContain(" Full name</label>");
    expect(m).toContain("<caption>Positions by driver</caption>");
    expect(m).toContain(">Pit lane<");
    // Step 5: the highlight starts on the drivers the summary names (here only ALP: winner and biggest gain), the
    // others thin and grey; "None" stays selectable
    expect(m).toContain('<option value="__summary" selected="">The summary&#x27;s driver (ALP)</option><option value="">None</option>');
    expect(m).toContain('stroke="#D9142B" stroke-width="3.5"'); // alpha, highlighted
    expect(m).toContain('stroke="var(--grid)" stroke-width="1.25" stroke-dasharray="6 4"'); // bravo: grey, still dashed
    // bravo's line and its end-label key (step 4B) are dashed; alpha's are solid
    expect((m.match(/stroke-dasharray/g) ?? []).length).toBe(2);
    expect(m).toContain(">Last pos.<");
  });

  it("compare: the summary, both charts' titles, sector totals and the table", () => {
    const props = {
      compare: COMPARE,
      error: null,
      a: "ALP",
      b: "BRA",
      order: ["alpha", "bravo"],
      onPick: () => undefined,
      totalLaps: 3,
      hasSectors: true,
      names: NAMES,
    };
    const m = html(createElement(CompareView, props));
    expect(m).toContain("ALP was faster on 2 and BRA on 1");
    expect(m).toContain("Cumulative gap, ALP minus BRA, by lap");
    expect(m).toContain("Sector 2: ALP −1.150 s vs BRA over 3 laps (ALP faster)");
    expect(m).toContain("ALP pit");
    expect(html(createElement(CompareView, { ...props, hasSectors: false }))).toContain("No sector times in this lake.");
    expect(html(createElement(CompareView, { ...props, compare: null, error: "boom" }))).toContain('role="alert"');
  });

  it("pit stops and race control: lap links, kind labels, empty state", () => {
    const pits = html(createElement(PitStopsTable, { stops: PITS, names: NAMES, onLap: () => undefined }));
    expect(pits).toContain('href="?view=laps&amp;lap=3"');
    expect(pits).toContain("22.400 s");
    expect(pits).toContain(" Hard</span>");
    const rc = html(createElement(RaceControlList, { rows: RC, names: NAMES, onLap: () => undefined }));
    expect(rc).toContain("1 key events (SC, VSC, red flags, penalties) of 2 messages.");
    expect(rc).toContain('href="?view=laps&amp;lap=4"');
    expect(rc).toContain(">SC<");
    expect(rc).not.toContain("DRS ENABLED"); // key events only by default
    const none = html(createElement(RaceControlList, { rows: [], names: NAMES, onLap: () => undefined }));
    expect(none).toContain("No race-control messages in this lake for this race.");
  });

  it("every chart title is non-empty (React 19 renders a multi-part <title> empty)", () => {
    const all = [
      html(createElement(StrategyChart, { rows: strategyRows(STINTS, PITS, ["alpha"]), laps: 6, coverage: COVERAGE, names: NAMES })),
      html(createElement(DegradationChart, { deg: degradation(LAPS, STINTS, "alpha"), driver: "alpha", order: ["alpha"], onDriver: () => undefined, coverage: COVERAGE, names: NAMES })),
      html(createElement(PositionsChart, { series: POSITIONS, totalLaps: 6, names: NAMES })),
      html(createElement(CompareView, { compare: COMPARE, error: null, a: "ALP", b: "BRA", order: ["alpha", "bravo"], onPick: () => undefined, totalLaps: 3, hasSectors: true, names: NAMES })),
      html(createElement(LapTimesChart, { laps: LAPS, drivers: ["alpha"], order: ["alpha"], onToggle: () => undefined, neutral: [], markLap: null, totalLaps: 6, names: NAMES })),
    ].join("");
    const titles = [...all.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]);
    expect(titles.length).toBe(6);
    for (const t of titles) expect(t?.trim().length ?? 0).toBeGreaterThan(5);
  });

  it("the page renders its navigation and a loading state before data arrives", () => {
    const m = html(createElement(AnalysisPage, { season: 2024, round: 5, initial: parseAnalysisQuery({}) }));
    expect(m).toContain('<nav aria-label="Race views"');
    expect(m).toContain('aria-current="page"');
    expect(m).toContain("Loading the race analysis…");
  });
});

describe("step 4B: hover layer, head, glyphs and colours", () => {
  it("nearestPoint snaps to the closest mark (x only, or x and y); none for no marks", () => {
    const pts = [{ x: 10 }, { x: 50 }, { x: 90 }];
    expect(nearestPoint(pts, 0)).toBe(0);
    expect(nearestPoint(pts, 69)).toBe(1);
    expect(nearestPoint(pts, 200)).toBe(2);
    expect(nearestPoint([{ x: 10, y: 0 }, { x: 12, y: 100 }], 11, 95)).toBe(1);
    expect(nearestPoint([], 5)).toBe(-1);
  });

  it("hoverKey: arrows by one without wrapping, pages by ten, Home and End; the first arrow shows the last mark", () => {
    expect(hoverKey("ArrowRight", 2, 5)).toBe(3);
    expect(hoverKey("ArrowRight", 4, 5)).toBe(4);
    expect(hoverKey("ArrowLeft", 0, 5)).toBe(0);
    expect(hoverKey("ArrowLeft", -1, 5)).toBe(4);
    expect(hoverKey("PageDown", 0, 30)).toBe(10);
    expect(hoverKey("PageUp", 5, 30)).toBe(0);
    expect(hoverKey("Home", 3, 5)).toBe(0);
    expect(hoverKey("End", 0, 5)).toBe(4);
    expect(hoverKey("Enter", 1, 5)).toBeNull();
    expect(hoverKey("ArrowRight", 0, 0)).toBeNull();
  });

  it("ChartHover is a keyboard slider with a readout sentence; nothing for no marks", () => {
    const props = {
      width: 300,
      height: 100,
      points: [{ x: 10 }, { x: 20 }],
      mark: (i: number) => ({ kind: "line" as const, x: 10 * (i + 1), top: 0, bottom: 100 }),
      readout: (i: number) => ({ title: `Lap ${i + 1}`, rows: [{ key: "a", value: "1:30.000", label: "ALP" }] }),
      label: "Lap times: read a lap",
    };
    const m = html(createElement(ChartHover, props));
    expect(m).toContain('role="slider"');
    expect(m).toContain('tabindex="0"');
    expect(m).toContain('aria-label="Lap times: read a lap"');
    expect(m).toContain('aria-valuemax="2"');
    expect(html(createElement(ChartHover, { ...props, points: [] }))).toBe("");
    expect(readoutSentence({ title: "Lap 3", rows: [{ key: "a", value: "P1", label: "ALP" }] })).toBe("Lap 3, ALP P1");
  });

  it("RaceSubHead: the live head's order, the current page marked, no amber", () => {
    const m = html(createElement(RaceSubHead, { season: 2024, round: 5, name: "Chinese Grand Prix", page: "drivers" }));
    expect(m.indexOf('aria-label="Breadcrumb"')).toBeLessThan(m.indexOf("<h1>"));
    expect(m.indexOf("<h1>")).toBeLessThan(m.indexOf('aria-label="Race views"'));
    expect(m).toContain('href="/race/2024/5"');
    expect(m).toContain('<a aria-current="page" href="/race/2024/5/drivers">');
    expect((m.match(/aria-current/g) ?? []).length).toBe(1);
    expect(m).toContain("Chinese Grand Prix");
    expect(m).not.toContain("signal");
  });

  it("compare: gain blue and loss orange (never red/green), a desc on both charts, no Δ glyph", () => {
    const m = html(
      createElement(CompareView, { compare: COMPARE, error: null, a: "ALP", b: "BRA", order: ["alpha", "bravo"], onPick: () => undefined, totalLaps: 3, hasSectors: true, names: NAMES }),
    );
    expect(m).toContain('fill="var(--gain)"');
    expect(m).toContain('stroke="var(--loss)"');
    expect(m).not.toMatch(/var\(--(ok|danger)\)/);
    expect((m.match(/<desc/g) ?? []).length).toBe(2);
    expect(m).not.toContain("Δ");
    expect(m).toContain(">S1 delta<");
  });

  it("pit stops: a summary sentence and the authored arrow, read as \"to\" (no → glyph)", () => {
    const m = html(createElement(PitStopsTable, { stops: PITS, names: NAMES, onLap: () => undefined }));
    expect(m).toContain("1 stop by 1 driver; 0 under SC/VSC. Shortest pit-lane time: 22.400 s, ALP on lap 3.");
    expect(m).not.toContain("→");
    expect(m).toContain('<span class="visually-hidden">to</span>');
  });

  it("lap times: a legend for two or more drivers, end labels in text ink, a summary per driver", () => {
    const m = html(
      createElement(LapTimesChart, { laps: LAPS, drivers: ["alpha", "bravo"], order: ["alpha", "bravo"], onToggle: () => undefined, neutral: [], markLap: null, totalLaps: 6, names: NAMES }),
    );
    expect(m).toContain('aria-label="Lines"');
    expect(m).toContain("ALP: best 1:29.000 on lap 6");
    expect(m).toMatch(/class="chart-label" fill="var\(--text\)">ALP</);
    expect(m).not.toMatch(/class="chart-label" fill="currentColor"/);
    const one = html(
      createElement(LapTimesChart, { laps: LAPS, drivers: ["alpha"], order: ["alpha", "bravo"], onToggle: () => undefined, neutral: [], markLap: null, totalLaps: 6, names: NAMES }),
    );
    expect(one).not.toContain('aria-label="Lines"');
  });
});
