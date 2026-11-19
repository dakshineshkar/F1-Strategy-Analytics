import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GapChart, gapChartEmptyText } from "@/components/GapChart";
import { labelledIds, scales, xTickLaps } from "@/lib/chart";
import { initialState, raceReducer } from "@/lib/reducer";

import { lap, snapshotMsg } from "./helpers";

describe("GapChart", () => {
  it("renders a non-empty <title> (React 19 renders a multi-part <title> empty)", () => {
    let state = initialState(2024, 5);
    for (const raw of [lap("max_verstappen", 3, 300, 1), lap("norris", 3, 302.5, 2)]) {
      state = raceReducer(state, { type: "event", raw });
    }
    const m = renderToStaticMarkup(createElement(GapChart, { state }));
    const title = /<title[^>]*>([^<]*)<\/title>/.exec(m)?.[1];
    // the window keeps laps 1 and 2 on the axis and names them as not received (critique F24, decision 2026-11-19)
    expect(title).toBe("Gap to leader, laps 1 to 3; laps 1 to 2 not received");
  });

  const joinedAtLap3 = () => {
    let state = initialState(2024, 5);
    for (const raw of [lap("max_verstappen", 3, 300, 1), lap("norris", 3, 302.5, 2)]) {
      state = raceReducer(state, { type: "event", raw });
    }
    return state;
  };

  it("live: says the history starts when the page opened and hatches the laps before it", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: joinedAtLap3(), live: true }));
    expect(m).toContain("History from when you opened the page (from lap 3). Laps 1 to 2 ran before that and are not shown.");
    expect(m).toContain('class="chart-missing"');
    expect(m).toMatch(/<rect [^>]*fill="url\(#hatch-[A-Za-z0-9_-]+\)"/);
    expect(/<title[^>]*>([^<]*)<\/title>/.exec(m)?.[1]).toBe(
      "Gap to leader, laps 1 to 3; laps 1 to 2 not received (before this page opened)",
    );
    expect(m).toContain("Gap to leader in seconds by lap; laps 1 to 2 not received, before this page opened");
  });

  it("live from the first lap: the note stays, no band", () => {
    let state = initialState(2024, 5);
    state = raceReducer(state, { type: "event", raw: lap("max_verstappen", 1, 90, 1) });
    const m = renderToStaticMarkup(createElement(GapChart, { state, live: true }));
    expect(m).toContain("History from when you opened the page (from lap 1).");
    expect(m).not.toContain("chart-missing");
  });

  it("live before any lap: one honest line, no empty axis", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: initialState(2024, 5), live: true }));
    expect(m).toContain('<p class="chart-empty muted">No laps received yet.</p>');
    expect(m).not.toContain("<svg");
    expect(m).not.toContain("<table");
    expect(m).not.toContain("chart-missing");
  });

  it("live, late join with only the snapshot (no lap frame yet): 'First lap arrives at the next crossing'", () => {
    let state = initialState(2024, 5);
    state = raceReducer(state, { type: "event", raw: snapshotMsg(["ver", "nor", "lec"], 45) });
    expect(state.maxLap).toBe(0);
    const m = renderToStaticMarkup(createElement(GapChart, { state, live: true }));
    expect(m).toContain("First lap arrives at the next crossing.");
    expect(m).not.toContain("<svg");
    expect(m).not.toContain("0s</text>");
    expect(m).not.toContain("History from");
    // the chart box stays mounted (hidden) so its width is measured from the first lap on
    expect(m).toContain('class="chart-box" hidden=""');
    expect(gapChartEmptyText(true)).toBe("First lap arrives at the next crossing.");
    expect(gapChartEmptyText(false)).toBe("No laps received yet.");
  });

  it("archive (not live) with no laps keeps its axis: the empty state is live only", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: initialState(2024, 5) }));
    expect(m).toContain("<svg");
    expect(m).not.toContain("chart-empty");
  });

  it("archive (not live): no 'opened the page' wording", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: joinedAtLap3() }));
    expect(m).not.toContain("opened the page");
    expect(m).not.toContain("History from");
  });
});

describe("GapChart labels and the highlight (2026-11-19 polish round)", () => {
  const ids = ["ver", "nor", "lec", "pia", "sai", "ham", "rus", "alo", "str", "bot"];
  const raced = () => {
    let state = initialState(2024, 5);
    ids.forEach((id, i) => {
      for (const n of [4, 5]) state = raceReducer(state, { type: "event", raw: lap(id, n, n * 95 + i * 1.5, i + 1) });
    });
    return state;
  };

  it("labels the highlighted cars and the top 5 running cars, each once; stale cars are not in the top 5", () => {
    expect(labelledIds(ids, ids, ["bot", "lec"])).toEqual(["bot", "lec", "ver", "nor", "pia", "sai"]);
    expect(labelledIds(ids, ids, [], new Set(["nor"]))).toEqual(["ver", "lec", "pia", "sai", "ham"]);
    expect(labelledIds(ids, ["ver", "nor"], ["sai"])).toEqual(["ver", "nor"]); // only cars that are drawn
  });

  it("thins the lap labels to keep them apart and always labels the newest lap", () => {
    expect(xTickLaps([1, 15], 616)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(xTickLaps([1, 15], 240)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(xTickLaps([7, 7], 240)).toEqual([7]);
  });

  it("keeps the first lap off the y-axis labels", () => {
    const frame = { width: 720, height: 300, left: 44, right: 56, top: 16, bottom: 28 };
    expect(scales(frame, [1, 15], 30).x(1)).toBe(44);
    expect(scales(frame, [1, 15], 30, undefined, 12).x(1)).toBe(56);
    expect(scales(frame, [1, 15], 30, undefined, 12).x(15)).toBe(720 - 56 - 12);
  });

  it("starts on the call's pair, labels it and the top 5 only, and draws the rest thin and unlabelled", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: raced(), pair: { attackerId: "str", defenderId: "alo" }, live: true }));
    expect(m).toContain('<option value="__call" selected="">The call (STR → ALO)</option>');
    const labels = [...m.matchAll(/class="chart-label"[^>]*>([A-Z]+)</g)].map((x) => x[1]);
    expect(labels.sort()).toEqual(["ALO", "LEC", "NOR", "PIA", "SAI", "STR", "VER"].sort());
    expect(m).toMatch(/<g class="chart-line is-focus" style="color:var\(--signal-mark\)"><path[^>]*stroke-width="2.5"/);
    expect(m).toMatch(/<g class="chart-line" style="color:var\(--grid\)"><path[^>]*stroke-width="1"/);
    // without a call the select starts on None
    expect(renderToStaticMarkup(createElement(GapChart, { state: raced(), live: true }))).toContain('<option value="" selected="">None</option>');
  });
});
