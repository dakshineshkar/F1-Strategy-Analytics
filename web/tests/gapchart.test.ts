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
    expect(title).toBe("Gap to leader, laps 1 to 3");
  });
});
