import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GapChart } from "@/components/GapChart";
import { initialState, raceReducer } from "@/lib/reducer";

import { lap } from "./helpers";

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

  it("live before any lap: an honest empty state", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: initialState(2024, 5), live: true }));
    expect(m).toContain("History from when you opened the page. No laps received yet.");
    expect(m).toContain("No laps received since you opened this page.");
    expect(m).not.toContain("chart-missing");
  });

  it("archive (not live): no 'opened the page' wording", () => {
    const m = renderToStaticMarkup(createElement(GapChart, { state: joinedAtLap3() }));
    expect(m).not.toContain("opened the page");
    expect(m).not.toContain("History from");
  });
});
