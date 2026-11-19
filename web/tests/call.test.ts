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
  alertKind,
  BASE_RATE_2025,
  closestPair,
  flaggedPairs,
  gaugeGeometry,
  isSmokeModel,
  modelDetail,
  modelIdentity,
  modeOf,
  noCallReason,
  previousLapOf,
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
    expect(health("deploy_real_G3.5_k2")?.model).toEqual({ model_version: "deploy_real_G3.5_k2", feature_set: "real", g: 3.5, k: 2 });
    expect(health(null)?.model).toBeNull();
    // an older API or a malformed model block keeps the health check usable
    expect(toHealth({ status: "ok", lake: { scheme: "file", mode: "sample", synthetic: true } })?.model).toBeNull();
    expect(toHealthModel({ model: { model_version: "" } })).toBeNull();
    expect(toHealthModel({ model: { model_version: "m", feature_set: 3, g: "x", k: null } })).toEqual({ model_version: "m", feature_set: null, g: null, k: null });
    expect(toHealthModel(null)).toBeNull();
  });

  it("names the model and stamps the sample deployment model as a smoke test", () => {
    const full = modelIdentity(health("deploy_real_G3.5_k2") ?? null);
    expect(full).toEqual({ version: "deploy_real_G3.5_k2", featureSet: "real", g: 3.5, k: 2, smoke: false });
    expect(modelDetail(full!)).toBe("real features, G 3.5 s, k 2");
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
  it("puts 0 s on the left and the pit loss on the right, the rule window shaded to G", () => {
    expect(gaugeGeometry(1.75, 21)).toEqual({ maxS: 21, gapPct: (1.75 / 21) * 100, gPct: (3.5 / 21) * 100, pitLossPct: 100, gapBeyond: false });
    // without a pit loss the scale ends at 2 G; a gap past the end is drawn at the end and marked
    expect(gaugeGeometry(9, null)).toMatchObject({ maxS: 7, gapPct: 100, pitLossPct: null, gapBeyond: true });
    expect(gaugeGeometry(-0.2, 20).gapPct).toBe(0);
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

  it("renders a quiet L-tag and muted gaps that say where they were measured", () => {
    const s = run([lap("ver", 10, 1000, 1), lap("nor", 10, 1001, 2), lap("pia", 9, 905, 3)].map((raw) => ({ type: "event", raw }) as RaceAction));
    const m = renderToStaticMarkup(createElement(TimingTower, { rows: towerRows(s), lapsDown: () => 0 }));
    expect(m).toContain('aria-describedby="tip-prevlap">L9<span class="visually-hidden"> (gap measured at lap 9, not lapped)</span>');
    expect(m).toContain('class="c-num is-stale" title="measured at lap 9; the car has not crossed the line on lap 10 yet"');
    expect((m.match(/tag-prevlap/g) ?? []).length).toBe(1);
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

  it("names the pair, labels the probability as a model estimate with the model id and the base rate", () => {
    const m = html();
    expect(m).toContain('<span class="call-code">LEC</span>');
    expect(m).toContain('<span class="call-code">NOR</span>');
    expect(m).toContain('<span class="call-prob-num num">66%</span>');
    expect(m).toContain("model estimate that pitting next lap brings LEC out ahead");
    expect(m).toContain(`<span class="num">${Math.round(BASE_RATE_2025 * 100)}%</span> of attempts`);
    expect(m).toContain('<span class="num">deploy_real_G3.5_k2</span>');
    expect(m).toContain('role="img" aria-label="Gap 1.5 s to the car ahead, inside the 3.5 s rule window; pit loss unknown."');
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
