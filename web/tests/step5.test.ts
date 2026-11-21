/** Step 5 (final audit) display fixes: the call never relabels its defender after the order changed (finding 2),
 * a stored race state is never "LIVE" and never a call (finding 3), only P1 says "Leader" (finding 7), the archive
 * stamps SMOKE TEST when the sample model scored the bundle (finding 8), and the positions chart's default
 * highlight (finding 14). Display only: nothing here changes the reducer, the API or the stream. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArchiveStrip } from "@/components/ArchiveStrip";
import { CallGauge } from "@/components/CallGauge";
import { TheCall } from "@/components/TheCall";
import { TimingTower } from "@/components/TimingTower";
import { positionsKeyDrivers, type PositionSeries } from "@/lib/analysis";
import type { Replay } from "@/lib/api";
import { flaggedPairs, latestAlertOf, modeOf, orderChangedText, storedLap, theCall } from "@/lib/call";
import { towerGap } from "@/lib/format";
import { initialState, type RaceAction, raceReducer, type RaceState, towerRows } from "@/lib/reducer";

import { alertMsg, driver, lap, snapshot } from "./helpers";

function run(actions: RaceAction[], from: RaceState = initialState(2024, 5)): RaceState {
  return actions.reduce(raceReducer, from);
}
const code = (id: string) => id.slice(0, 3).toUpperCase();

/** 2024 R5 at lap 17 as the audit saw it (live-390-dark.png, live-768-light.png): PER was flagged against SAI at
 * the lap-16 decision (88%, gap 0.7 s); SAI then pitted and dropped behind, so LEC is directly ahead of PER now,
 * 8.0 s up the road, while PER's hash still carries the flag and the 88%. */
function lap17(alertDefender = "sainz"): RaceState {
  const order = ["verstappen", "leclerc", "perez", "sainz"];
  const data = snapshot(order);
  data.drivers.perez = driver(3, { gap_ahead_s: 8.0, gap_leader_s: 14.2, undercut_flag: true, undercut_prob: 0.88 });
  return run([
    { type: "snapshot", data },
    { type: "event", raw: alertMsg("perez", alertDefender, "opportunity", "new_candidate", 0.88, 16) },
  ]);
}

describe("finding 2: the call keeps the alert's defender when the order changed", () => {
  it("lap 16 PER → SAI, lap 17 LEC ahead of PER: the pair stays PER → SAI, marked as order changed", () => {
    const s = lap17();
    const call = theCall(s);
    expect(call).not.toBeNull();
    expect(call?.attackerId).toBe("perez");
    expect(call?.defenderId).toBe("sainz"); // never relabelled to LEC
    expect(call?.aheadNowId).toBe("leclerc");
    expect(call?.orderChanged).toBe(true);
    expect(call?.prob).toBe(0.88); // the alert's probability for that pair
    expect(call?.gapS).toBeNull(); // no "gap now" to SAI
    expect(call?.alert?.decisionLap).toBe(16);
    expect(latestAlertOf(s, "perez")?.defenderId).toBe("sainz");
    expect(orderChangedText(call!, code)).toEqual({ text: "flagged at lap 16 against SAI; order changed since", aheadNow: "LEC is directly ahead now" });
  });

  it("the call says so, mutes the gauge at the decision gap and does not present the rule checks as passing", () => {
    const s = lap17();
    const m = renderToStaticMarkup(
      createElement(TheCall, { state: s, entrants: {}, model: null, context: null, onSimulate: () => undefined, replayIdle: false }),
    );
    expect(m).toContain('<span class="call-code">SAI</span>');
    expect(m).not.toContain('<span class="call-code">LEC</span>');
    expect(m).toContain("defender at the decision lap");
    // the visible line keeps the length of the rule checks; the car ahead now is for screen readers
    expect(m).toContain('<span class="call-rule-checks call-order-changed">flagged at lap 16 against SAI; order changed since<span class="visually-hidden"> (LEC is directly ahead now)</span></span>');
    expect(m).not.toContain("within 3.5 s, not teammates, nobody between, green lap");
    expect(m).toContain('class="gauge is-muted"');
    expect(m).toContain('<span class="gauge-gap is-decision"><span class="gauge-label">gap at decision (lap 16)</span> <span class="num">1.2 s</span></span>');
    expect(m).not.toContain("trend after 3 laps");
    expect(m).not.toContain("gap now");
    expect(m).not.toContain("8.0 s");
  });

  it("when the alert's defender is still directly ahead, nothing changes: the rule checks and the gap now", () => {
    const s = lap17("leclerc");
    const call = theCall(s)!;
    expect(call.defenderId).toBe("leclerc");
    expect(call.orderChanged).toBe(false);
    expect(call.gapS).toBe(8.0);
    expect(orderChangedText(call, code)).toBeNull();
    const m = renderToStaticMarkup(
      createElement(TheCall, { state: s, entrants: {}, model: null, context: null, onSimulate: () => undefined, replayIdle: false }),
    );
    expect(m).toContain("within 3.5 s, not teammates, nobody between, green lap");
    expect(m).toContain('<span class="gauge-label">gap now</span>');
  });

  it("without any alert for the attacker (a late join with no history) the car directly ahead is the defender", () => {
    const order = ["verstappen", "leclerc", "perez"];
    const data = snapshot(order);
    data.drivers.perez = driver(3, { undercut_flag: true, undercut_prob: 0.6 });
    const pairs = flaggedPairs(run([{ type: "snapshot", data }]));
    expect(pairs.map((p) => [p.attackerId, p.defenderId, p.orderChanged])).toEqual([["perez", "leclerc", false]]);
  });

  it("the gauge names a decision gap as such (sentence and label)", () => {
    const m = renderToStaticMarkup(
      createElement(CallGauge, { gapS: 0.7, gapLabel: "gap at decision (lap 16)", pitLossS: null, pitLossText: null, trend: null, trendLaps: null, muted: true }),
    );
    expect(m).toContain('aria-label="Gap at decision (lap 16) 0.7 s, inside the 3.5 s rule window; pit loss unknown."');
    expect(m).toMatch(/^<div class="gauge is-muted" role="img"/); // a div, not a figure (axe aria-allowed-role)
  });
});

describe("finding 3: a stored race state is never LIVE and never a call", () => {
  const order = ["verstappen", "perez", "norris"];
  const stored = (): RaceState => {
    const data = snapshot(order);
    data.drivers.norris = driver(3, { undercut_flag: true, undercut_prob: 1 });
    data.timing = { verstappen: { lap: 11 } as never };
    return run([{ type: "snapshot", data }, { type: "connection", status: "connected" }]);
  };
  const replay = (state: Replay["state"]): Replay => ({
    season: 2024,
    round: 5,
    speed: 10,
    run_id: "r",
    state,
    paused: false,
    lap: 11,
    events_sent: 1,
    error: null,
    note: null,
    started_at: null,
    results_dir: null,
  } as unknown as Replay);

  it("storedLap: replays read, no run of this race, no session_end, cars held, no lap frame since connect", () => {
    const s = stored();
    expect(Object.keys(s.history)).toEqual([]); // a snapshot writes no lap history
    expect(storedLap(true, null, s)).toBeGreaterThan(0);
    expect(storedLap(false, null, s)).toBeNull(); // /api/replays not read yet
    expect(storedLap(true, replay("running"), s)).toBeNull();
    expect(storedLap(true, replay("stopped"), s)).toBeNull();
    expect(storedLap(true, null, { ...s, sessionEnded: true })).toBeNull();
    expect(storedLap(true, null, initialState(2024, 5))).toBeNull(); // nothing stored
    // a lap frame arrived (a replay run outside the API streams): live again
    const live = run([{ type: "event", raw: lap("verstappen", 12, 1200, 1) }], s);
    expect(storedLap(true, null, live)).toBeNull();
  });

  it("the strip says NOT REPLAYING, never LIVE, while the stream is connected", () => {
    const m = modeOf(null, false, "connected", 11);
    expect(m.label).toBe("NOT REPLAYING");
    expect(m.tone).toBe("stored");
    expect(m.description).toContain("an earlier run left (lap 11)");
    expect(modeOf(null, false, "connected", null).label).toBe("LIVE");
  });

  it("the call is one line: no pair, no probability, no model id", () => {
    const m = renderToStaticMarkup(
      createElement(TheCall, {
        state: stored(),
        entrants: {},
        model: { version: "deploy_real_G3.5_k2", featureSet: "real", g: 3.5, k: 2, smoke: false },
        context: null,
        onSimulate: () => undefined,
        replayIdle: true,
        stored: 11,
        layout: "compact",
      }),
    );
    expect(m).toContain("No replay of this race is running.");
    expect(m).toContain("The tower shows the state an earlier run left (lap 11); its flags are not a live call.");
    expect(m).toContain("Start one from the status strip above.");
    expect(m).not.toContain("Open replay controls");
    expect(m).not.toContain("model estimate");
    expect(m).not.toContain("100%");
    expect(m).not.toContain("deploy_real_G3.5_k2");
    expect(m).not.toContain("Simulate");
  });
});

describe("finding 7: only P1 says Leader", () => {
  it("towerGap", () => {
    expect(towerGap(1, 0)).toBe("Leader");
    expect(towerGap(1, null)).toBe("Leader");
    expect(towerGap(3, 0)).toBe("—");
    expect(towerGap(3, null)).toBe("—");
    expect(towerGap(3, 2.5)).toBe("+2.500");
  });

  it("a P3 car whose stored gap to the leader is 0 (VER on his pit lap) shows a dash with the reason", () => {
    const order = ["norris", "leclerc", "verstappen"];
    const data = snapshot(order);
    data.drivers.verstappen = driver(3, { gap_ahead_s: 3.006, gap_leader_s: 0 });
    const s = run([{ type: "snapshot", data }]);
    const m = renderToStaticMarkup(createElement(TimingTower, { rows: towerRows(s), lapsDown: () => 0 }));
    expect((m.match(/>Leader</g) ?? []).length).toBe(2); // P1's Int and Gap only
    const ver = m.slice(m.indexOf('data-driver="verstappen"'));
    expect(ver).toContain('title="not measured at this lap">—<span class="visually-hidden"> (not measured at this lap)</span>');
    expect(ver).toContain("+3.006");
    expect(ver).not.toContain("Leader");
  });
});

describe("finding 8: the archive stamps SMOKE TEST when the sample model scored the bundle", () => {
  const strip = (modelVersion: string) =>
    renderToStaticMarkup(createElement(ArchiveStrip, { status: null, lap: 20, laps: 56, modelVersion, scorerSha256: "2e7f1369676a00" }));

  it("sample model: the stamp, next to the POST-RACE chip", () => {
    const m = strip("sample_deploy_real_G3.5_k2");
    expect(m).toContain('<p class="stamp stamp-smoke"');
    expect(m).toContain("SMOKE TEST");
    expect(m).toContain("the sample model scored this bundle; its probabilities are not results.");
    expect(m.indexOf("POST-RACE")).toBeLessThan(m.indexOf("SMOKE TEST"));
  });

  it("the deployed model: no stamp", () => {
    expect(strip("deploy_real_G3.5_k2")).not.toContain("SMOKE TEST");
  });
});

describe("finding 14: the positions highlight starts on the summary's drivers", () => {
  const s = (driver_id: string, grid: number | null, positions: number[]): PositionSeries =>
    ({ driver_id, grid, positions: positions.map((position, i) => ({ lap: i + 1, position })) }) as PositionSeries;

  it("winner, biggest gain, biggest loss, without repeats", () => {
    const series = [s("ver", 1, [1, 1, 1]), s("ham", 18, [12, 10, 9]), s("str", 11, [13, 15, 16]), s("nor", 4, [2, 2, 2])];
    expect(positionsKeyDrivers(series)).toEqual(["ver", "ham", "str"]);
    // the winner is also the biggest gain: named once
    expect(positionsKeyDrivers([s("alp", 2, [1, 1]), s("bra", 1, [2, 2])])).toEqual(["alp", "bra"]);
    expect(positionsKeyDrivers([])).toEqual([]);
  });
});
