/** The call (redesign Step 2): pairs flagged now from the race state (also after a late join, critique
 * F09), model identity and the SMOKE TEST rule (F10), the gauge's geometry, alert wording (F13), the
 * previous-lap marker (F38), the status strip's mode, and the call / feed markup. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AlertFeed } from "@/components/AlertFeed";
import { TheCall } from "@/components/TheCall";
import { TimingTower } from "@/components/TimingTower";
import { type Health, type Replay, toHealth, toHealthModel } from "@/lib/api";
import {
  alertIsNew,
  alertKind,
  callLayout,
  closestPair,
  closestReason,
  decisionGap,
  flaggedPairs,
  gaugeGeometry,
  isSmokeModel,
  modelDetail,
  modelIdentity,
  modeOf,
  noCallReason,
  previousLapOf,
  raceEnded,
  theCall,
  trendOf,
} from "@/lib/call";
import { type Entrant, indexEntrants } from "@/lib/entrants";
import { initialState, type RaceAction, raceReducer, type RaceState, towerRows } from "@/lib/reducer";
import { flipDelta } from "@/lib/useFlip";

import { alertMsg, lap, snapshot, snapshotMsg } from "./helpers";

function run(actions: RaceAction[], from: RaceState = initialState(2024, 5)): RaceState {
  return actions.reduce(raceReducer, from);
}
/** The reducer's snapshot action from an ``event: snapshot`` data line (the stream hook does the same). */
const snap = (raw: string): RaceAction => {
  const data = JSON.parse(raw) as Record<string, unknown>;
  for (const k of ["type", "lap", "event_id", "sse_sent_at_ms"]) delete data[k];
  return { type: "snapshot", data: data as unknown as ReturnType<typeof snapshot> };
};

function entrant(driver_id: string, constructor_id: string): Entrant {
  return {
    driver_id,
    code: driver_id.slice(0, 3).toUpperCase(),
    given_name: null,
    family_name: driver_id,
    car_number: null,
    grid: null,
    constructor_id,
    team_name: constructor_id,
    team_code: constructor_id.slice(0, 3).toUpperCase(),
    team_lineage_id: constructor_id,
    team_colour_hex: "#123456",
    team_text_hex: "#FFFFFF",
    colour_source: "test",
    nationality: null,
    nationality_code: null,
  };
}

const health = (version: string | null, extra: Record<string, unknown> = {}): Health | undefined =>
  toHealth({
    status: "ok",
    checks: { model: version === null ? { ok: false, error: "no model" } : { ok: true, model_version: version, feature_set: "real", g: 3.5, k: 2, ...extra } },
    lake: { scheme: "hdfs", mode: "full", synthetic: false },
  });

describe("model identity and the SMOKE TEST rule", () => {
  it("keeps checks.model from /api/health (it was dropped before: critique F10)", () => {
    // F10's fields are null from an API that does not send them
    const none = { smoke_test: null, trained_on: null, model_id: null, stamp: null };
    expect(health("deploy_real_G3.5_k2")?.model).toEqual({ model_version: "deploy_real_G3.5_k2", feature_set: "real", g: 3.5, k: 2, ...none });
    expect(health(null)?.model).toBeNull();
    // an older API or a malformed model block keeps the health check usable
    expect(toHealth({ status: "ok", lake: { scheme: "file", mode: "sample", synthetic: true } })?.model).toBeNull();
    expect(toHealthModel({ model: { model_version: "" } })).toBeNull();
    expect(toHealthModel({ model: { model_version: "m", feature_set: 3, g: "x", k: null } })).toEqual({ model_version: "m", feature_set: null, g: null, k: null, ...none });
    expect(toHealthModel(null)).toBeNull();
  });

  it("names the model and stamps the sample deployment model as a smoke test", () => {
    const full = modelIdentity(health("deploy_real_G3.5_k2") ?? null);
    expect(full).toEqual({ version: "deploy_real_G3.5_k2", featureSet: "real", g: 3.5, k: 2, smoke: false });
    // no-break spaces inside each part, so "k 2" never wraps (Step 5, finding 13)
    expect(modelDetail(full!)).toBe("real\u00a0features, G\u00a03.5\u00a0s, k\u00a02");
    expect(modelIdentity(health("sample_deploy_real_G3.5_k2") ?? null)?.smoke).toBe(true);
    expect(isSmokeModel("sample_x")).toBe(true);
    expect(isSmokeModel("deploy_sample")).toBe(false);
    expect(modelIdentity(null)).toBeNull();
    expect(modelDetail({ version: "v", featureSet: null, g: null, k: null, smoke: false })).toBe("");
  });
});

describe("pairs flagged now", () => {
  const order = ["ver", "nor", "lec", "pia", "sai"];
  const state = run([snap(snapshotMsg(order, 12, { lec: true, sai: true }))]);

  it("pairs each flagged car with the car directly ahead, from the snapshot alone (late join, F09)", () => {
    expect(state.alerts).toEqual({}); // no alert history after a late join
    const pairs = flaggedPairs(state);
    expect(pairs.map((p) => [p.attackerId, p.defenderId])).toEqual([
      ["lec", "nor"],
      ["sai", "pia"],
    ]);
    expect(pairs[0]).toMatchObject({ prob: 0.66, gapS: 1.5, alert: null });
  });

  it("ranks by probability, then the newest alert, then position; links the alert group", () => {
    // an alert sets the attacker's flag and probability (the reducer), here equal to LEC's 0.66
    const s = run([{ type: "event", raw: alertMsg("sai", "pia", "opportunity", "new_candidate", 0.66, 12) }], state);
    const pairs = flaggedPairs(s);
    expect(pairs[0]?.attackerId).toBe("sai"); // same probability, newer alert
    expect(pairs[0]?.alert?.reason).toBe("opportunity");
    expect(theCall(s)?.defenderId).toBe("pia");
    const higher = run([snap(snapshotMsg(order, 12, { lec: true }))]);
    expect(theCall(higher)?.attackerId).toBe("lec");
  });

  it("the leader is never an attacker; nothing flagged gives no call", () => {
    expect(flaggedPairs(run([snap(snapshotMsg(order, 3, { ver: true }))]))).toEqual([]);
    expect(theCall(run([snap(snapshotMsg(order, 3))]))).toBeNull();
    expect(theCall(initialState(2024, 5))).toBeNull();
  });

  it("explains a missing call, and finds the closest non-teammate pair outside the pits", () => {
    expect(noCallReason(initialState(2024, 5), {})).toBe("Waiting for the first lap of the race stream.");
    const data = snapshot(order);
    data.drivers.nor = { ...data.drivers.nor!, gap_ahead_s: 0.8 };
    data.drivers.lec = { ...data.drivers.lec!, gap_ahead_s: 2.1 };
    for (const id of ["pia", "sai"]) data.drivers[id] = { ...data.drivers[id]!, gap_ahead_s: 6 };
    const s = run([{ type: "snapshot", data }]);
    const mates = indexEntrants([entrant("ver", "rbr"), entrant("nor", "rbr"), entrant("lec", "fer"), entrant("pia", "mcl"), entrant("sai", "wil")]);
    expect(closestPair(s, mates)).toMatchObject({ attackerId: "lec", defenderId: "nor", gapS: 2.1 });
    expect(closestPair(s, {})).toMatchObject({ attackerId: "nor", gapS: 0.8 });
    expect(noCallReason(s, mates)).toMatch(/^The cars within 3.5 s are not candidates/);
    const far = snapshot(order);
    for (const id of order.slice(1)) far.drivers[id] = { ...far.drivers[id]!, gap_ahead_s: 5 };
    expect(noCallReason(run([{ type: "snapshot", data: far }]), {})).toBe("No car is within 3.5 s of a non-teammate ahead.");
  });
});

describe("the gauge and the trend", () => {
  it("runs from 0 s to max(5 s, gap x 1.5), shades the rule window to 3.5 s, and has no pit loss on the axis", () => {
    expect(gaugeGeometry(1.75)).toEqual({ maxS: 5, gapPct: 35, windowPct: 70, nextS: null, nextPct: null, nextBeyond: false });
    // a larger gap stretches the axis so the gap sits at two thirds of it
    const far = gaugeGeometry(6);
    expect(far.maxS).toBe(9);
    expect(far.gapPct).toBeCloseTo(66.67, 2);
    expect(far.windowPct).toBeCloseTo((3.5 / 9) * 100, 6);
    expect(gaugeGeometry(-0.2).gapPct).toBe(0);
    expect(Object.keys(gaugeGeometry(2))).not.toContain("pitLossPct");
  });

  it("points the trend arrow at next lap's gap, never below 0 s, and marks it past the axis end", () => {
    expect(gaugeGeometry(2, -0.5)).toMatchObject({ nextS: 1.5, nextPct: 30 });
    expect(gaugeGeometry(0.3, -0.5)).toMatchObject({ nextS: 0, nextPct: 0 });
    expect(gaugeGeometry(3.2, 2)).toMatchObject({ maxS: 5, nextS: 5.2, nextPct: 100, nextBeyond: true });
    expect(gaugeGeometry(2, Number.NaN).nextS).toBeNull();
  });

  it("words the gap trend (negative = closing), steady under 0.05 s/lap", () => {
    expect(trendOf(-0.31)).toEqual({ dir: "closing", text: "closing 0.31 s/lap" });
    expect(trendOf(0.2)).toEqual({ dir: "opening", text: "opening 0.20 s/lap" });
    expect(trendOf(0.01)?.dir).toBe("steady");
    expect(trendOf(null)).toBeNull();
    expect(trendOf(Number.NaN)).toBeNull();
  });
});

describe("alert wording matches the strength (F13)", () => {
  it("calls a below-threshold new pair a candidate, not an opportunity", () => {
    expect(alertKind({ reason: "opportunity", prob: 0.24, threshold: 0.5 })).toEqual({ kind: "candidate", label: "Candidate" });
    expect(alertKind({ reason: "opportunity", prob: 0.5, threshold: 0.5 })).toEqual({ kind: "opportunity", label: "Opportunity" });
    expect(alertKind({ reason: "attempt", prob: 0.1, threshold: 0.5 })).toEqual({ kind: "attempt", label: "Attempt" });
  });
});

describe("the previous-lap marker (F38)", () => {
  it("marks a car whose latest lap is behind the leader's, unless it is simply lapped", () => {
    expect(previousLapOf({ lap: 9 }, 10, 0)).toBe(9);
    expect(previousLapOf({ lap: 10 }, 10, 0)).toBeNull();
    expect(previousLapOf({ lap: 9 }, 10, 1)).toBeNull(); // one lap down and up to date
    expect(previousLapOf({ lap: 8 }, 10, 1)).toBe(8); // one lap down and still on the previous lap
    expect(previousLapOf({ lap: null }, 10, 0)).toBeNull();
    expect(previousLapOf({ lap: 9 }, null, 0)).toBeNull();
  });

  it("puts a small muted lap number in the Gap cell, without a box, and says where the gap was measured", () => {
    const s = run([lap("ver", 10, 1000, 1), lap("nor", 10, 1001, 2), lap("pia", 9, 905, 3)].map((raw) => ({ type: "event", raw }) as RaceAction));
    const m = renderToStaticMarkup(createElement(TimingTower, { rows: towerRows(s), lapsDown: () => 0 }));
    expect(m).toContain('<span class="gap-lap" aria-describedby="tip-prevlap">L9<span class="visually-hidden"> (measured at lap 9, not lapped)</span></span>');
    expect(m).toContain('class="c-num c-gap is-prevlap" title="measured at lap 9; the car has not crossed the line on lap 10 yet"');
    expect((m.match(/class="gap-lap"/g) ?? []).length).toBe(1);
    // the boxed tag is gone
    expect(m).not.toContain("tag-prevlap");
    expect(m).not.toMatch(/class="tag"[^>]*>\+\d L/);
  });
});

describe("the status strip's mode", () => {
  const replay = (state: Replay["state"], more: Partial<Replay> = {}): Replay => ({
    season: 2024,
    round: 5,
    speed: 10,
    run_id: "r",
    state,
    error: null,
    started_at: null,
    ended_at: null,
    paused: state === "paused",
    lap: 23,
    note: null,
    paused_at: null,
    ...more,
  });

  it("names the replay state from /api/replays, so a pause or stop never reads as live", () => {
    expect(modeOf(replay("running"), false, "connected")).toMatchObject({ label: "REPLAY 10×", tone: "replay" });
    expect(modeOf(replay("starting", { speed: 60 }), false, "connecting").label).toBe("REPLAY 60×");
    expect(modeOf(replay("paused"), false, "connected")).toMatchObject({ label: "PAUSED", description: "Replay paused at lap 23." });
    expect(modeOf(replay("stopped"), false, "connected")).toMatchObject({ label: "STOPPED", tone: "ended" });
    expect(modeOf(replay("finished"), true, "closed").label).toBe("FINISHED");
    expect(modeOf(replay("failed"), false, "connected").label).toBe("FAILED");
    expect(modeOf(null, true, "closed").label).toBe("FINISHED");
    expect(modeOf(null, false, "connected").label).toBe("LIVE");
    expect(modeOf(null, false, "connecting")).toMatchObject({ label: "NO REPLAY", tone: "idle" });
  });
});

describe("FLIP", () => {
  it("inverts a row by its old top minus its new top, and skips new rows, no move and long jumps", () => {
    expect(flipDelta(60, 30)).toBe(30);
    expect(flipDelta(30, 60)).toBe(-30);
    expect(flipDelta(undefined, 30)).toBeNull();
    expect(flipDelta(30, 30)).toBeNull();
    expect(flipDelta(0, 600)).toBeNull();
    expect(flipDelta(0, 600, 1000)).toBe(-600);
  });
});

describe("the call's markup", () => {
  const order = ["ver", "nor", "lec"];
  const state = run([snap(snapshotMsg(order, 12, { lec: true }))]);
  const model = modelIdentity(health("deploy_real_G3.5_k2") ?? null);
  const html = (props: Partial<Parameters<typeof TheCall>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(TheCall, {
        state,
        entrants: {},
        model,
        context: null,
        onSimulate: () => undefined,
        replayIdle: false,
        onOpenReplay: () => undefined,
        ...props,
      }),
    );

  it("names the pair, labels the probability as a model estimate with the model id (no base-rate line)", () => {
    const m = html();
    expect(m).toContain('<span class="call-code">LEC</span>');
    expect(m).toContain('<span class="call-code">NOR</span>');
    expect(m).toContain('<span class="call-prob-num num">66%</span>');
    expect(m).toContain("model estimate that pitting next lap brings LEC out ahead");
    // Step 5, finding 4: the "2025 base rate" line is removed (2025 is the sealed test season)
    expect(m).not.toContain("base rate");
    expect(m).toContain('<span class="num">deploy_real_G3.5_k2</span>');
    expect(m).toContain('role="img" aria-label="Gap now 1.5 s to the car ahead, inside the 3.5 s rule window; pit loss unknown."');
    expect(m).toContain(">Simulate this pair</button>");
    expect(m).not.toContain("SMOKE TEST");
  });

  it("stamps SMOKE TEST when the sample model scores", () => {
    expect(html({ model: modelIdentity(health("sample_deploy_real_G3.5_k2") ?? null) })).toContain('<span class="stamp stamp-smoke">SMOKE TEST</span>');
  });

  it("without a flagged pair says why; without a replay offers to start one", () => {
    const quiet = run([snap(snapshotMsg(order, 12))]);
    expect(html({ state: quiet })).toContain("No undercut call");
    expect(html({ state: initialState(2024, 5), replayIdle: true })).toContain(">Open replay controls</button>");
    // the start prompt is a neutral control: solid signal is for the call and its button only
    expect(html({ state: initialState(2024, 5), replayIdle: true })).not.toContain("btn-primary");
  });
});

describe("the alert feed after a late join (F09)", () => {
  it("says since when it listened and lists the pairs flagged now", () => {
    const state = run([snap(snapshotMsg(["ver", "nor", "lec"], 12, { lec: true }))]);
    const m = renderToStaticMarkup(
      createElement(AlertFeed, { groups: [], announcement: null, flaggedNow: flaggedPairs(state), sinceLap: 12 }),
    );
    expect(m).toContain("No alerts since you opened this page (lap 12).");
    expect(m).toContain("Flagged now, from the current race state");
    expect(m).toMatch(/<span class="code">LEC<\/span>.*<span class="code">NOR<\/span><span class="num">66%<\/span>/);
    // from the start of the race it keeps the plain empty text
    expect(renderToStaticMarkup(createElement(AlertFeed, { groups: [], announcement: null, sinceLap: 1 }))).toContain("No undercut alerts yet.");
  });
});

describe("the call's states (2026-11-19 polish round)", () => {
  const replay = (state: Replay["state"]): Pick<Replay, "state"> => ({ state });

  it("the race has ended after the finish, session_end or the leader's last lap; a stop mid-race is not an end", () => {
    expect(raceEnded(replay("finished"), false, 40, 56)).toBe(true);
    expect(raceEnded(null, true, 40, 56)).toBe(true);
    expect(raceEnded(replay("running"), false, 56, 56)).toBe(true);
    expect(raceEnded(replay("running"), false, 55, 56)).toBe(false);
    expect(raceEnded(replay("stopped"), false, 21, 56)).toBe(false);
    expect(raceEnded(null, false, 30, null)).toBe(false);
    expect(raceEnded(null, false, null, 56)).toBe(false);
  });

  it("keeps its full height while a replay streams; one line only while idle, before lap 1 or after the finish", () => {
    expect(callLayout(true, true, 20, false)).toBe("full");
    expect(callLayout(false, true, 20, false)).toBe("full"); // no call while streaming: the closest pair fills it
    expect(callLayout(false, false, 20, false)).toBe("compact");
    expect(callLayout(false, true, 0, false)).toBe("compact");
    expect(callLayout(true, false, 20, false)).toBe("full"); // a call on a stopped replay keeps its space
    expect(callLayout(true, true, 56, true)).toBe("compact");
  });

  it("states the gap at decision from this page's alert, or that it was not received", () => {
    const order = ["ver", "nor", "lec"];
    const late = run([snap(snapshotMsg(order, 12, { lec: true }))]);
    expect(decisionGap(theCall(late)!)).toBeNull();
    const seen = run([{ type: "event", raw: alertMsg("lec", "nor", "opportunity", "new_candidate", 0.66, 11) }], late);
    expect(decisionGap(theCall(seen)!)).toEqual({ lap: 11, gapS: 1.2 });
  });

  it("says why the closest pair is not a call", () => {
    expect(closestReason({ gapS: 4.12 })).toBe("gap 4.1 s, outside the 3.5 s rule window");
    expect(closestReason({ gapS: 2.9 })).toBe(
      "gap 2.9 s now, but not flagged at the last decision (a pit lap, a neutralised lap, or the gap was above 3.5 s then)",
    );
    expect(closestReason({ gapS: null })).toBe("gap unknown");
  });

  it("marks only alerts from the leader's lap or the one before as new", () => {
    expect(alertIsNew({ decisionLap: 20 }, 20)).toBe(true);
    expect(alertIsNew({ decisionLap: 19 }, 20)).toBe(true);
    expect(alertIsNew({ decisionLap: 18 }, 20)).toBe(false);
    expect(alertIsNew({ decisionLap: 1 }, 0)).toBe(false);
  });
});

describe("the call's markup in each state", () => {
  const order = ["ver", "nor", "lec", "pia"];
  const model = modelIdentity(health("deploy_real_G3.5_k2") ?? null);
  const html = (props: Partial<Parameters<typeof TheCall>[0]>) =>
    renderToStaticMarkup(
      createElement(TheCall, {
        state: initialState(2024, 5),
        entrants: {},
        model,
        context: null,
        onSimulate: () => undefined,
        replayIdle: false,
        onOpenReplay: () => undefined,
        ...props,
      }),
    );

  it("a call labels the gauge 'gap now' and the rule line 'gap at decision (lap N)'", () => {
    const s = run([snap(snapshotMsg(order, 12, { lec: true })), { type: "event", raw: alertMsg("lec", "nor", "opportunity", "new_candidate", 0.66, 11) }]);
    const m = html({ state: s });
    expect(m).toContain('<span class="gauge-label">gap now</span>');
    expect(m).toContain('gap at decision (lap 11) <span class="num">1.2 s</span>');
    expect(m).toContain("rule window 3.5 s");
    expect(m).not.toMatch(/>G \d/); // no unexplained "G" on the axis
    expect(m).toContain('class="btn btn-primary"');
    const late = html({ state: run([snap(snapshotMsg(order, 12, { lec: true }))]) });
    expect(late).toContain("gap at decision: not received (before you opened the page)");
  });

  it("after the finish: 'Race ended', no pit instruction, no Simulate, the archive", () => {
    const s = run([
      snap(snapshotMsg(order, 55, { lec: true })),
      ...[lap("ver", 56, 5320, 1), lap("nor", 56, 5322, 2)].map((raw) => ({ type: "event", raw }) as RaceAction),
    ]);
    const m = html({ state: s, ended: true, layout: "compact", onArchive: () => undefined });
    expect(m).toContain("Race ended at lap 56");
    expect(m).toContain(">Open the post-race archive</button>");
    expect(m).not.toContain("Simulate");
    expect(m).not.toContain("pitting next lap");
    expect(m).not.toContain("btn-primary");
    expect(m).toContain('class="panel call is-compact is-ended"');
    expect(html({ state: s, ended: true, layout: "compact", onArchive: null })).toContain("The post-race archive of this race is not built yet.");
  });

  it("no call while streaming: the closest pair, why, a muted gauge and a neutral Simulate, no signal fill", () => {
    const data = snapshot(order);
    data.drivers.nor = { ...data.drivers.nor!, gap_ahead_s: 6 };
    data.drivers.lec = { ...data.drivers.lec!, gap_ahead_s: 4.1 };
    data.drivers.pia = { ...data.drivers.pia!, gap_ahead_s: 7 };
    const s = run([{ type: "snapshot", data }]);
    const m = html({ state: s, layout: "full" });
    expect(m).toContain("No undercut call");
    expect(m).toContain("gap 4.1 s, outside the 3.5 s rule window");
    expect(m).toContain('class="gauge is-muted"');
    expect(m).toContain('<button type="button" class="btn">Simulate closest pair</button>');
    expect(m).not.toContain("btn-primary");
    expect(m).not.toContain("has-call");
  });

  it("while nothing streams it is one line with the closest pair", () => {
    const s = run([snap(snapshotMsg(order, 12))]);
    const m = html({ state: s, layout: "compact" });
    expect(m).toContain('class="panel call is-compact"');
    // one run of text: the pair and the reason read as a sentence
    expect(m).toMatch(/<span class="call-line-text">closest pair <span class="code">[A-Z]{3}<\/span> on <span class="code">[A-Z]{3}<\/span>: gap /);
    expect(m).not.toContain('class="gauge');
  });
});

describe("the tower's band is the call's pair only", () => {
  it("bands the attacker and the defender with their roles; other flagged rows get no band, weight from 50%", () => {
    const order = ["ver", "nor", "lec", "pia", "sai"];
    const data = snapshot(order);
    data.drivers.lec = { ...data.drivers.lec!, undercut_flag: true, undercut_prob: 0.62 };
    data.drivers.sai = { ...data.drivers.sai!, undercut_flag: true, undercut_prob: 0.31 };
    const s = run([{ type: "snapshot", data }]);
    const call = theCall(s)!;
    const m = renderToStaticMarkup(createElement(TimingTower, { rows: towerRows(s), lapsDown: () => 0, callPair: call }));
    expect((m.match(/class="[^"]*is-call[ "]/g) ?? []).length).toBe(2);
    expect(m).toMatch(/<tr data-driver="lec"[^>]*class="is-flagged is-call is-call-attacker"/);
    expect(m).toMatch(/<tr data-driver="nor"[^>]*class="is-call is-call-defender"/);
    expect(m).toMatch(/<tr data-driver="sai"[^>]*class="is-flagged"/);
    expect(m).toContain('<span class="call-role role-attacker" aria-describedby="tip-call">attacker');
    expect(m).toContain('<span class="call-role role-defender" aria-describedby="tip-call">defender');
    expect(m).toMatch(/<td class="c-uc is-strong">.*?62%/);
    expect(m).toMatch(/<td class="c-uc">.*?31%/);
  });

  it("a stale car keeps its row: dimmed, 'no timing since L19' across Int and Gap, its flag kept", () => {
    const order = ["ver", "nor", "bot"];
    const data = snapshot(order);
    data.drivers.bot = { ...data.drivers.bot!, undercut_flag: true, undercut_prob: 0.4 };
    const s = run([{ type: "snapshot", data }]);
    const m = renderToStaticMarkup(
      createElement(TimingTower, { rows: towerRows(s), lapsDown: () => 0, staleLap: (id: string) => (id === "bot" ? 19 : null) }),
    );
    expect(m).toMatch(/<tr data-driver="bot"[^>]*class="is-flagged is-stale-car"/);
    expect(m).toContain('<td class="c-num c-notiming" colSpan="2" aria-describedby="tip-stale">no timing since L19</td>');
    expect(m).toContain("Flag from lap 19, no timing since: not a call, ");
    expect((m.match(/<tr data-driver=/g) ?? []).length).toBe(3);
  });
});

describe("the alert feed's signal colour is for new alerts only", () => {
  it("neutral type outlines; 'new' and the signal only for alerts from the last lap", () => {
    const s = run([
      { type: "event", raw: alertMsg("lec", "nor", "opportunity", "new_candidate", 0.66, 18) },
      { type: "event", raw: alertMsg("sai", "pia", "attempt", "pit_in", 0.4, 20) },
    ]);
    const m = renderToStaticMarkup(createElement(AlertFeed, { groups: Object.values(s.alerts), announcement: null, maxLap: 20 }));
    expect(m).toMatch(/<li data-flip="[^"]*sai[^"]*" class="alert alert-attempt is-new">/);
    expect(m).toMatch(/<li data-flip="[^"]*lec[^"]*" class="alert alert-opportunity">/);
    expect((m.match(/class="alert-new">new</g) ?? []).length).toBe(1);
    expect((m.match(/class="alert-new"><\/span>/g) ?? []).length).toBe(1); // the slot is kept on the older alert
  });
});
