/** The 2026-11-19 polish round: the what-if preselected from the call (never run on its own), the alert feed's
 * whole-row ending, and the status strip's lap progress. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusStrip } from "@/components/StatusStrip";
import { WhatIfPanel } from "@/components/WhatIfPanel";
import { cssLengthPx, fitRows, rowsBelow } from "@/lib/useFitRows";

afterEach(() => vi.unstubAllGlobals());

describe("the what-if follows the call until the viewer picks", () => {
  const order = ["ver", "nor", "lec", "pia"];
  const html = (suggested: string | null) =>
    renderToStaticMarkup(createElement(WhatIfPanel, { season: 2024, round: 5, order, suggested }));

  it("preselects the call's attacker and the car ahead, and says Run is needed", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const m = html("lec");
    expect(m).toContain('<option value="lec" selected="">');
    expect(m).toContain('<span class="wi-defender-value">NOR · Nor</span>');
    expect(m).toContain("No run yet. LEC on NOR is preselected from the call: press Run what-if.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has no table before a run, a one-line summary, and the explanation behind 'How to read this'", () => {
    const m = html(null);
    expect(m).not.toContain("<table");
    expect(m).toContain("No run yet. Choose an attacker, or press Simulate on the call or an alert.");
    expect(m).toContain('<p class="panel-note wi-summary">');
    expect(m).toMatch(/<details class="wi-how"><summary>How to read this<\/summary><p id="whatif-note"/);
    // a suggestion that is not a car in the order is ignored
    expect(html("nobody")).toContain('<option value="" selected="">Choose a car</option>');
  });
});

describe("the alert feed ends on a whole row", () => {
  it("fits whole rows above the footer, or every row when they all fit", () => {
    expect(fitRows(300, 68, 3, 32)).toBe(3); // 204 px: all fit, no footer
    expect(fitRows(300, 68, 9, 32)).toBe(3); // (300 - 32) / 68 = 3.9
    expect(fitRows(50, 68, 9, 32)).toBe(1); // never fewer than one
    expect(fitRows(0, 68, 9, 32)).toBe(1);
  });

  it("counts the rows below the visible window as the list scrolls", () => {
    expect(rowsBelow(9, 3, 0, 68)).toBe(6);
    expect(rowsBelow(9, 3, 204, 68)).toBe(3);
    expect(rowsBelow(9, 3, 9999, 68)).toBe(0);
  });

  it("reads the row height from CSS in rem or px", () => {
    expect(cssLengthPx(" 4.25rem", 16)).toBe(68);
    expect(cssLengthPx("70px", 16)).toBe(70);
    expect(cssLengthPx("", 16)).toBeNull();
    expect(cssLengthPx("4em", 16)).toBeNull();
  });
});

describe("the status strip shows the leader's lap progress once", () => {
  const strip = (progress: { lap: number; crossed: number; running: number } | null) =>
    renderToStaticMarkup(
      createElement(StatusStrip, {
        mode: { label: "REPLAY 10×", tone: "replay", description: "x" },
        model: null,
        lap: 20,
        laps: 56,
        progress,
        raceStatus: null,
        connection: "connected",
        sessionEnded: false,
        children: null,
      } as Parameters<typeof StatusStrip>[0]),
    );

  it("'2 of 20 crossed' next to the lap, in a fixed cell that is empty before lap 1", () => {
    const m = strip({ lap: 20, crossed: 2, running: 20 });
    expect(m).toContain('<span class="num">2</span><span class="ss-k">of</span><span class="num">20</span><span class="ss-k">crossed</span>');
    expect(strip(null)).toMatch(/<p class="ss-cell ss-progress"[^>]*><\/p>/);
  });
});
