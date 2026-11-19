import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CallsList, EngineerCard, EngineerPanel, GapSparkline, RejoinBar } from "@/components/EngineerPanel";
import { RaceDashboard } from "@/components/RaceDashboard";
import { ApiError } from "@/lib/api";
import {
  engineerMessage,
  FOCUS_KEY,
  loadFocus,
  newCalls,
  pickFocus,
  probText,
  rejoinBar,
  rejoinLanes,
  saveFocus,
  sparkline,
  stintText,
  toEngineer,
  trendText,
  tyreText,
  zeroPct,
  type Engineer,
  type EngineerCar,
} from "@/lib/engineer";
import type { Entrant } from "@/lib/entrants";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// ------------------------------------------------------------------ invented fixtures (no F1 data)
function car(id: string, pos: number, over: Partial<EngineerCar> = {}): EngineerCar {
  return {
    driver_id: id,
    driver_code: id.slice(0, 3).toUpperCase(),
    position: pos,
    lap: 20,
    projected: false,
    compound: "MEDIUM",
    tyre_life_laps: 12,
    tyre_life_source: "real",
    tyre_life_delta_laps: null,
    stint_laps: 12,
    typical_stint: { compound: "MEDIUM", median_laps: 22, n_stints: 14, n_races: 3, source: "circuit", is_synthetic: false },
    pace_last3_s: 91.2,
    pace_delta_s: null,
    last_lap_time_s: 91.4,
    in_pit: false,
    undercut_flag: false,
    undercut_prob: 0.3,
    prob_recorded: true,
    ...over,
  };
}

const ENG: Engineer = {
  season: 2024,
  round: 5,
  lap: 20,
  current_lap: 20,
  history_from_lap: 1,
  focus_id: "bravo",
  neutralised: { status: "green", source: "estimated", message: null, message_lap: null },
  ahead: car("alpha", 1, { tyre_life_delta_laps: 8, pace_delta_s: -0.2 }),
  focus: car("bravo", 2),
  behind: car("charlie", 3, { undercut_prob: 0.64, tyre_life_delta_laps: -3 }),
  pair_ahead: {
    front_id: "alpha",
    rear_id: "bravo",
    gap_s: 4.2,
    projected: false,
    trend_s_per_lap: 0.1,
    trend_laps: 5,
    gaps: [16, 17, 18, 19, 20].map((lap, i) => ({ lap, gap_s: 3.8 + 0.1 * i })),
    prob: 0.3,
    prob_role: "focus_on_ahead",
    prob_recorded: true,
    pair_matches: true,
  },
  pair_behind: {
    front_id: "bravo",
    rear_id: "charlie",
    gap_s: 1.2,
    projected: false,
    trend_s_per_lap: -0.4,
    trend_laps: 5,
    gaps: [16, 17, 18, 19, 20].map((lap, i) => ({ lap, gap_s: 2.8 - 0.4 * i })),
    prob: 0.64,
    prob_role: "threat",
    prob_recorded: true,
    pair_matches: true,
  },
  rejoin: {
    pit_loss_s: 21.5,
    pit_loss_source: "circuit_prior",
    pit_loss_text: "circuit prior from earlier races",
    position: 5,
    ahead_id: "echo",
    behind_id: "foxtrot",
    gap_ahead_s: 0.8,
    gap_behind_s: 2.4,
    in_traffic: true,
    reliable: true,
    reasons: [],
    field: [
      { driver_id: "alpha", gap_s: -4.2, projected: false },
      { driver_id: "charlie", gap_s: 1.2, projected: false },
      { driver_id: "echo", gap_s: 20.7, projected: false },
      { driver_id: "foxtrot", gap_s: 23.9, projected: true },
      { driver_id: "golf", gap_s: 60, projected: false },
    ],
    left_out: 1,
  },
  calls: [
    { id: "threat", severity: "warn", text: "Under threat from behind: CHA 64%" },
    { id: "rejoin", severity: "warn", text: "Pit now rejoins P5 behind ECH, in traffic (0.8 s)" },
  ],
  disclaimer: "Strategy calls are display rules built from these values, not model output.",
};

const ENTRANTS: Record<string, Entrant> = Object.fromEntries(
  (
    [
      ["alpha", "ferrari"],
      ["bravo", "ferrari"],
      ["charlie", "haas"],
    ] as const
  ).map(([id, team]) => [
    id,
    {
      driver_id: id,
      code: id.slice(0, 3).toUpperCase(),
      given_name: "Given",
      family_name: id,
      car_number: 1,
      grid: 1,
      constructor_id: team,
      team_name: team,
      team_code: "FER",
      team_lineage_id: team,
      team_colour_hex: "#D9142B",
      team_text_hex: "#FFFFFF",
      colour_source: "project_palette",
      nationality: null,
      nationality_code: null,
    } satisfies Entrant,
  ]),
);

// ------------------------------------------------------------------ guards and messages
describe("engineer guards", () => {
  it("accept the response and reject a bad field anywhere", () => {
    expect(toEngineer(JSON.parse(JSON.stringify(ENG)))?.behind?.undercut_prob).toBe(0.64);
    expect(toEngineer({ ...ENG, ahead: null, pair_ahead: null })?.ahead).toBeNull();
    expect(toEngineer({ ...ENG, focus: { ...ENG.focus, compound: "HYPER" } })).toBeUndefined();
    expect(toEngineer({ ...ENG, calls: [{ id: "nope", severity: "info", text: "x" }] })).toBeUndefined();
    expect(toEngineer({ ...ENG, behind: { ...ENG.behind, undercut_prob: 1.5 } })).toBeUndefined();
    expect(toEngineer({ ...ENG, rejoin: { ...ENG.rejoin, field: [{ driver_id: "A", gap_s: 1, projected: false }] } })).toBeUndefined();
    expect(toEngineer({ ...ENG, neutralised: { ...ENG.neutralised, status: "yellow" } })).toBeUndefined();
  });

  it("maps errors to short messages", () => {
    expect(engineerMessage(new ApiError("API not reachable", null))).toBe("The API is not reachable.");
    expect(engineerMessage(new ApiError("no laps recorded yet for 2024 R5", 409))).toMatch(/Waiting for laps/);
    expect(engineerMessage(new ApiError("clean zone unavailable", 503))).toMatch(/not available/);
    expect(engineerMessage(new Error("x"))).toBe("The engineer view is not available.");
  });
});

// ------------------------------------------------------------------ pure helpers
describe("engineer helpers", () => {
  it("sparkline maps laps to x and bigger gaps to the top", () => {
    const pts = sparkline([{ lap: 1, gap_s: 1 }, { lap: 3, gap_s: 3 }], 100, 20, 0);
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [0, 20],
      [100, 0],
    ]);
    expect(sparkline([], 100, 20)).toEqual([]);
    expect(sparkline([{ lap: 4, gap_s: 2 }], 100, 20)[0]).toMatchObject({ x: 50, y: 10 });
  });

  it("rejoin bar keeps the window and marks the slot", () => {
    const bar = rejoinBar(ENG.rejoin);
    expect(bar.window).toEqual([-5, 31.5]);
    expect(bar.marks.map((m) => m.driverId)).toEqual(["alpha", "charlie", "echo", "foxtrot"]); // golf is outside
    expect(bar.slot).toBe(72.6);
    expect(bar.marks.find((m) => m.driverId === "foxtrot")?.projected).toBe(true);
    expect(rejoinBar({ ...ENG.rejoin, pit_loss_s: null }).slot).toBeNull();
    expect(zeroPct(bar.window)).toBe(13.7); // 5 of 36.5 s
    expect(zeroPct([0, 0])).toBe(0);
  });

  it("rejoin labels take the lowest lane where they clear the ones placed (F20: codes never overlap)", () => {
    const m = (driverId: string, pct: number) => ({ driverId, pct, projected: false });
    // 300 px track, 30 px labels: b (3 px from a) needs lane 1; c (33 px from a) clears it with the 2 px gap
    const placed = rejoinLanes([m("c", 21), m("a", 10), m("b", 11), m("d", 50)], 300, 30);
    expect(placed.map((p) => [p.mark.driverId, p.lane])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
      ["d", 0],
    ]);
    // a wide track keeps every label in lane 0
    expect(rejoinLanes([m("a", 10), m("b", 30)], 1000, 30).every((p) => p.lane === 0)).toBe(true);
    expect(rejoinLanes([], 300)).toEqual([]);
  });

  it("new calls are only those not in the previous lap's list", () => {
    expect(newCalls(null, ENG.calls)).toEqual([]); // the first load announces nothing
    expect(newCalls([ENG.calls[1]!], ENG.calls).map((c) => c.id)).toEqual(["threat"]);
    expect(newCalls(ENG.calls, ENG.calls)).toEqual([]);
  });

  it("the focus lock: saved, loaded, and ignored when storage throws", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveFocus("charlie", store);
    expect(mem.get(FOCUS_KEY)).toBe("charlie");
    expect(loadFocus(store)).toBe("charlie");
    saveFocus(null, store);
    expect(loadFocus(store)).toBeNull();
    mem.set(FOCUS_KEY, "<script>");
    expect(loadFocus(store)).toBeNull(); // not a driver id
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadFocus(broken)).toBeNull();
    expect(() => saveFocus("alpha", broken)).not.toThrow();
    expect(loadFocus(null)).toBeNull();
    expect(pickFocus("charlie", ["alpha", "charlie"])).toBe("charlie");
    // nothing locked (or the lock left the race): P2, so the car ahead is never empty (F19); P1 when alone
    expect(pickFocus("zulu", ["alpha", "charlie"])).toBe("charlie");
    expect(pickFocus(null, ["alpha", "charlie", "echo"])).toBe("charlie");
    expect(pickFocus(null, ["alpha"])).toBe("alpha");
    expect(pickFocus(null, [])).toBeNull();
  });

  it("text for every value", () => {
    expect(trendText(-0.4, 5)).toBe("closing 0.40 s/lap over 5 laps");
    expect(trendText(0.2, 4)).toBe("opening 0.20 s/lap over 4 laps");
    expect(trendText(0.01, 5)).toBe("steady over 5 laps");
    expect(trendText(null, 2)).toBe("trend needs 3 laps (2 so far)");
    expect(probText(0.64, true)).toBe("64%");
    expect(probText(null, true)).toBe("not evaluated");
    expect(probText(0.5, false)).toBe("not recorded for this lap");
    expect(tyreText(car("x", 1, { tyre_life_source: "estimated" }))).toBe("12 laps (est.)");
    expect(tyreText(car("x", 1, { tyre_life_laps: null }))).toBe("tyre life unknown");
    expect(stintText(ENG.focus)).toBe("12 laps of a typical 22 here (14 stints, 3 races)");
    const none = car("x", 1, { typical_stint: { ...ENG.focus.typical_stint, median_laps: null, source: "none" } });
    expect(stintText(none)).toBe("12 laps (no stint history for this compound)");
  });
});

// ------------------------------------------------------------------ rendered markup
describe("engineer view markup", () => {
  const names = { code: (id: string) => id.slice(0, 3).toUpperCase(), name: (id: string) => id };

  it("a card has every value as text, the badge, the teammate tag and no inline colours", () => {
    const m = html(createElement(EngineerCard, { role: "Ahead", car: ENG.ahead, focus: ENG.focus, entrants: ENTRANTS, isTeammate: true, names }));
    expect(m).toContain("Ahead: P1");
    expect(m).toContain('class="team-badge"');
    expect(m).toContain('<span class="tag">teammate</span>');
    expect(m).toContain(" Medium</span>, 12 laps (+8 vs focus)");
    expect(m).toContain("12 laps of a typical 22 here");
    expect(m).toContain("(−0.20 s vs focus)");
    expect(m).toContain("30%");
    // the only inline style is the team badge's data-driven colour (the entrants feature's exception)
    const styles = [...m.matchAll(/style="([^"]*)"/g)].map((x) => x[1]);
    expect(styles.every((st) => /^--team:#[0-9A-F]{6};--team-ink:#(000000|FFFFFF)$/.test(st ?? ""))).toBe(true);
    const none = html(createElement(EngineerCard, { role: "Ahead", car: null, focus: ENG.focus, entrants: ENTRANTS, isTeammate: false, names }));
    expect(none).toContain("Leading: no car ahead.");
  });

  it("the sparkline has a single-string title and its values as text", () => {
    const m = html(createElement(GapSparkline, { pair: ENG.pair_behind!, label: "Gap CHA to BRA" }));
    expect(m).toContain("<title>Gap CHA to BRA by lap: 2.8, 2.4, 2.0, 1.6, 1.2 s</title>");
    expect(m).toContain("Gap CHA to BRA, laps 16–20: 2.8, 2.4, 2.0, 1.6, 1.2 s");
    // the latest lap is the only dot, with its value as a direct label
    expect((m.match(/<circle /g) ?? []).length).toBe(1);
    expect(m).toContain('<span class="eng-spark-end num" aria-hidden="true">1.2 s</span>');
    // no laps yet: it says why, never a caption of dashes (F12)
    const none = html(createElement(GapSparkline, { pair: { ...ENG.pair_behind!, gaps: [] }, label: "Gap CHA to BRA" }));
    expect(none).toContain("Gap CHA to BRA: no lap of this pair completed yet.");
    expect(none).not.toContain("<svg");
  });

  it("the rejoin bar: a sentence, the pit loss with its source, the slot as a shape and text", () => {
    const m = html(createElement(RejoinBar, { rejoin: ENG.rejoin, names }));
    expect(m).toContain("Pit now: rejoins P5 behind ECH (0.8 s), ahead of FOX (2.4 s), in traffic.");
    expect(m).toContain("Pit loss 21.5 s: circuit prior from earlier races.");
    expect(m).toContain("1 cars a lap or more down are not placed.");
    // the slot is an authored triangle (no ▼ glyph) plus its word, in its own row under the axis
    expect(m).not.toContain("▼");
    expect(m).toMatch(/<span class="rejoin-slot" style="left:72\.6%"><svg class="rejoin-slot-mark"[^>]*><path[^>]*><\/path><\/svg>rejoin<\/span>/);
    expect(m).toContain('class="rejoin-mark is-projected"');
    expect(m).toContain('class="rejoin-tick is-projected"');
    expect(m).toContain(">−5 s<");
    expect(m).toContain(">+31.5 s behind<");
    expect(html(createElement(RejoinBar, { rejoin: { ...ENG.rejoin, pit_loss_s: null }, names }))).toContain(
      "Pit loss: no estimate (no pit-loss prior).",
    );
    const bad = html(createElement(RejoinBar, { rejoin: { ...ENG.rejoin, reliable: false, reasons: ["SC"] }, names }));
    expect(bad).toContain("Unreliable: SC.");
  });

  it("calls: labelled as display rules, and aria-live only on the new calls", () => {
    const m = html(createElement(CallsList, { calls: ENG.calls, fresh: [ENG.calls[0]!], disclaimer: ENG.disclaimer }));
    expect(m).toContain("not model output.");
    // the kind is a chip (word and outline), never a side bar (F35)
    expect(m).toContain(
      '<span class="eng-kind kind-watch">Watch</span><span class="visually-hidden">: </span><span class="eng-call-text">Under threat from behind: CHA 64%',
    );
    expect(m).not.toContain("is-warn\" style");
    expect((m.match(/aria-live/g) ?? []).length).toBe(1);
    expect(m).toMatch(/aria-live="polite" aria-atomic="true">Under threat from behind: CHA 64%<\/div>/);
    expect(html(createElement(CallsList, { calls: [], fresh: [], disclaimer: "" }))).toContain("No call at this lap.");
  });

  it("the panel renders the picker (the live order) and its legend before data arrives", () => {
    const m = html(createElement(EngineerPanel, { season: 2024, round: 5, order: ["alpha", "bravo"], maxLap: 3, entrants: ENTRANTS }));
    expect(m).toContain("Focus driver (kept in this browser)");
    expect((m.match(/<option /g) ?? []).length).toBe(2);
    expect(m).toContain("Loading the engineer view…");
    expect(m).toContain('aria-label="Engineer"><h3>Engineer</h3>');
  });

  it("the race page has Race | Engineer tabs with the race view selected", () => {
    const m = html(createElement(RaceDashboard, { season: 2024, round: 5 }));
    expect(m).toContain('role="tablist" aria-label="Race page views"');
    expect(m).toMatch(/role="tab" id="page-tab-race" aria-selected="true"/);
    expect(m).toMatch(/role="tab" id="page-tab-engineer" aria-selected="false"[^>]*tabindex="-1"/);
    expect(m).toContain('id="page-panel-race"');
    expect(m).not.toContain('id="page-panel-engineer"');
  });
});
