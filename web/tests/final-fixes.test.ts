/** Final race-view fixes from the 2026-11-19 screenshot review: the race's pit loss in the call after a late join
 * (item 2), the alert feed after the finish and its counter (item 4), the what-if's height (item 6) and the
 * phone's short labels (item 1). The gap chart's empty state (item 5) is in gapchart.test.ts and the pipeline
 * count (item 3) in pipeline.test.ts. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AlertFeed } from "@/components/AlertFeed";
import { PhoneLabel } from "@/components/PhoneLabel";
import { ReplayDrawer, StatusStrip } from "@/components/StatusStrip";
import { TheCall } from "@/components/TheCall";
import type { RaceSnapshot } from "@/lib/api";
import { alertCountText, alertIsNew, type Mode } from "@/lib/call";
import type { Engineer } from "@/lib/engineer";
import { initialState, type RaceAction, raceReducer, type RaceState } from "@/lib/reducer";
import { leaderLap } from "@/lib/stale";
import { pitLossOf, type RacePitLoss } from "@/lib/useCallContext";

import { alertMsg, snapshot } from "./helpers";

const run = (actions: RaceAction[], from: RaceState = initialState(2024, 5)): RaceState => actions.reduce(raceReducer, from);
const CSS = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");
/** The rules inside the ``@media (max-width: 640px)`` block that holds the phone's race head. */
const PHONE = (() => {
  const start = CSS.indexOf("@media (max-width: 640px) {\n  main {");
  return CSS.slice(start, CSS.indexOf("\n}\n", start));
})();

/** An engineer response with only what the call reads (focus, pair ahead, rejoin pit loss). */
function engineer(focus: string, front: string, loss: number | null, source: Engineer["rejoin"]["pit_loss_source"]): Engineer {
  return {
    focus_id: focus,
    pair_ahead: { front_id: front, gap_s: 0.5, trend_s_per_lap: -0.36, trend_laps: 3 },
    rejoin: { pit_loss_s: loss, pit_loss_source: source },
  } as unknown as Engineer;
}

/** A page opened at lap 45: it holds the snapshot only (no lap frame yet), with lec flagged behind nor. */
function lateJoin(): RaceState {
  const order = ["ver", "nor", "lec", "pia"];
  const tyres: RaceSnapshot["tyres"] = Object.fromEntries(order.map((id) => [id, { lap: 45, tyre_life_laps: 20, tyre_life_at_start_laps: 0 }]));
  const snap = snapshot(order, { tyres });
  const lec = snap.drivers.lec;
  if (lec) snap.drivers.lec = { ...lec, gap_ahead_s: 0.5, undercut_flag: true, undercut_prob: 0.75 };
  return run([{ type: "snapshot", data: snap }]);
}

describe("item 2: the call states the race's pit loss after a late join", () => {
  const state = lateJoin();
  const html = (context: Engineer | null, pitLoss: RacePitLoss | null) =>
    renderToStaticMarkup(
      createElement(TheCall, {
        state,
        entrants: {},
        model: null,
        context,
        pitLoss,
        onSimulate: () => undefined,
        replayIdle: false,
        onOpenReplay: () => undefined,
      }),
    );
  const loss = pitLossOf(engineer("lec", "nor", 23.1, "global_prior"));

  it("the snapshot-only page has no lap frame (maxLap 0) but knows the leader's lap, so it fetches at once", () => {
    // the cause: the context hook used to wait for maxLap >= 1, which only a lap frame sets
    expect(state.maxLap).toBe(0);
    expect(leaderLap(state)).toBe(45);
  });

  it("pitLossOf takes the race's pit loss and its source from an engineer response", () => {
    expect(loss).toEqual({ s: 23.1, source: "global_prior" });
    expect(pitLossOf(engineer("x", "y", null, "none"))).toEqual({ s: null, source: "none" });
    expect(pitLossOf(null)).toBeNull();
  });

  it("shows '23.1 s from all earlier races' from the race's pit loss, with no engineer view of this pair", () => {
    const m = html(null, loss);
    expect(m).toContain('pit loss <span class="num">23.1 s</span> from all earlier races (no history at this circuit)');
    expect(m).not.toContain("pit loss unknown");
  });

  it("the same value when the engineer view loaded is another attacker's (the pit loss is per race)", () => {
    expect(html(engineer("pia", "lec", 23.1, "global_prior"), loss)).toBe(html(null, loss));
  });

  it("one markup for the same data: no viewport branch, so the phone and the desktop show the same value", () => {
    expect(html(null, loss)).toBe(html(null, { s: 23.1, source: "global_prior" }));
    // without any response yet it says so, at every width
    expect(html(null, null)).toContain("pit loss unknown");
  });
});

describe("item 4: the alert feed after the finish, and its counter", () => {
  const s = run([
    { type: "event", raw: alertMsg("lec", "nor", "opportunity", "new_candidate", 0.66, 55) },
    { type: "event", raw: alertMsg("sai", "pia", "opportunity", "new_candidate", 0.58, 53) },
    { type: "event", raw: alertMsg("sai", "pia", "opportunity", "probability_crossed", 0.6, 53) },
    { type: "event", raw: alertMsg("sai", "pia", "opportunity", "probability_crossed", 0.61, 53) },
    { type: "event", raw: alertMsg("sai", "pia", "opportunity", "probability_crossed", 0.62, 53) },
  ]);
  const feed = (ended: boolean) =>
    renderToStaticMarkup(createElement(AlertFeed, { groups: Object.values(s.alerts), announcement: null, maxLap: 56, ended }));

  it("live: an alert from the leader's lap or the one before is new; after the finish none is", () => {
    expect(alertIsNew({ decisionLap: 55 }, 56)).toBe(true);
    expect(alertIsNew({ decisionLap: 54 }, 56)).toBe(false);
    expect(alertIsNew({ decisionLap: 56 }, 56, true)).toBe(false);
    expect(alertIsNew({ decisionLap: 55 }, 56, true)).toBe(false);
  });

  it("the finished feed has no signal colour: no is-new row, no 'new' word", () => {
    expect(feed(false)).toContain("is-new");
    const m = feed(true);
    expect(m).not.toContain("is-new");
    expect(m).not.toContain('class="alert-new">new<');
  });

  it("the '4×' counter is labelled: a title and accessible text '4 alerts for this pair'", () => {
    const m = feed(true);
    expect(m).toContain('<span class="kv alert-count" title="4 alerts for this pair"><span class="num" aria-hidden="true">4×</span>');
    expect(m).toContain('<span class="visually-hidden">, 4 alerts for this pair</span>');
    expect(alertCountText(1)).toBe("1 alert for this pair");
    expect(alertCountText(2)).toBe("2 alerts for this pair");
  });
});

describe("item 6: the what-if's height follows its content", () => {
  it("reserves one status line, not 2.6rem, and the empty error region takes no space", () => {
    expect(CSS).toMatch(/\.whatif-status \{[^}]*min-height: 1\.3em;/);
    expect(CSS).not.toMatch(/\.whatif-status \{[^}]*min-height: 2\.6rem/);
    expect(CSS).toContain(".whatif-panel .replay-error:empty { min-height: 0; margin: 0; }");
  });
});

describe("item 1: the phone's race head and status strip wrap", () => {
  it("never scroll sideways, fade or force one line on a phone", () => {
    expect(PHONE).toContain(".race-head-live {");
    expect(PHONE).not.toMatch(/\.race-head-live[^{]*\{[^}]*(overflow-x|nowrap|mask-image)/);
    expect(PHONE).not.toMatch(/\.ss-cells[^{]*\{[^}]*(overflow-x|nowrap|mask-image)/);
    expect(PHONE).not.toMatch(/\.status-strip \{[^}]*nowrap/);
    expect(PHONE).toContain(".ss-cells > *, .ss-end { flex: none; min-width: max-content; }");
  });

  it("the data notice wraps instead of being cut, and the call's heading never breaks", () => {
    const banner = /\.data-banner \{[^}]*\}/.exec(CSS)?.[0] ?? "";
    expect(banner).toContain("flex-wrap: wrap");
    expect(banner).toContain("min-height: 1.5rem");
    expect(banner).not.toMatch(/nowrap|overflow: hidden|text-overflow|[^-]height: 1\.5rem/);
    expect(CSS).toMatch(/\.call-head h2 \{[^}]*white-space: nowrap;/);
  });

  it("a short label shows only on a phone; the full one is always the accessible name", () => {
    const m = renderToStaticMarkup(createElement(PhoneLabel, { full: "Race analysis", short: "Analysis" }));
    expect(m).toBe('<span class="phone-full">Race analysis</span><span class="phone-short" aria-hidden="true">Analysis</span>');
    expect(CSS).toContain(".phone-short { display: none; }");
    expect(PHONE).toContain(".phone-short { display: inline; }");
    expect(PHONE).toMatch(/\.phone-full, \.ss-model \.ss-k \{ position: absolute !important; width: 1px;/);
  });

  it("the strip's connection and the Replay button carry their short forms", () => {
    const mode: Mode = { label: "REPLAY 10×", description: "Replay running at 10×", tone: "replay" };
    // children go in as createElement arguments (react/no-children-prop); the casts only add them to the type
    const drawer = createElement(ReplayDrawer, { open: false, onOpenChange: () => undefined } as unknown as Parameters<typeof ReplayDrawer>[0], null);
    const props = { mode, model: null, lap: 11, laps: 56, raceStatus: null, connection: "connected", sessionEnded: false, onArchive: null };
    const m = renderToStaticMarkup(createElement(StatusStrip, props as Parameters<typeof StatusStrip>[0], drawer));
    expect(m).toContain('<span class="phone-full">Stream connected</span><span class="phone-short" aria-hidden="true">Connected</span>');
    expect(m).toContain('<span class="phone-full">Replay controls</span><span class="phone-short" aria-hidden="true">Replay</span>');
  });
});
