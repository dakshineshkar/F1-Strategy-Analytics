/** Replay controls (Feature 7): the status guard, the texts, which controls apply, the run
 * tracker that resets the live view on a new run, and the ReplayControl markup. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplayControl } from "@/components/ReplayControl";
import { ApiError, type Replay, toReplay, toReplayStatus } from "@/lib/api";
import {
  INITIAL_RUN,
  isActive,
  replayControls,
  replayLapText,
  replayMessage,
  replayStatusText,
  trackRun,
} from "@/lib/replays";

const base: Replay = {
  season: 2024,
  round: 5,
  speed: 10,
  run_id: "2024_5_20261118T090000.250Z",
  state: "running",
  error: null,
  started_at: "2026-11-18T09:00:00.250Z",
  ended_at: null,
  paused: false,
  lap: 23,
  note: null,
  paused_at: null,
};
const as = (over: Partial<Replay>): Replay => ({ ...base, ...over });

describe("replay status guard", () => {
  it("reads the Feature 7 fields and every state", () => {
    for (const state of ["starting", "running", "paused", "stopped", "finished", "failed"]) {
      expect(toReplay({ ...base, state })?.state).toBe(state);
    }
    const paused = toReplay({ ...base, state: "paused", paused: true, paused_at: "2026-11-18T09:01:00.000Z" });
    expect(paused?.paused).toBe(true);
    expect(paused?.paused_at).toBe("2026-11-18T09:01:00.000Z");
    expect(toReplay({ ...base, state: "stopped", note: "paused longer than 1800 s" })?.note).toContain("1800");
  });

  it("reads an older API without the new fields as not paused, no lap", () => {
    const old: Record<string, unknown> = { ...base };
    for (const k of ["paused", "lap", "note", "paused_at"]) delete old[k];
    expect(toReplay(old)).toEqual({ ...base, paused: false, lap: null, note: null, paused_at: null });
  });

  it("rejects wrong new fields and unknown states", () => {
    expect(toReplay({ ...base, paused: "yes" })).toBeUndefined();
    expect(toReplay({ ...base, lap: 2.5 })).toBeUndefined();
    expect(toReplay({ ...base, note: 3 })).toBeUndefined();
    expect(toReplay({ ...base, paused_at: 0 })).toBeUndefined();
    expect(toReplay({ ...base, state: "stopping" })).toBeUndefined();
    expect(toReplayStatus({ enabled: true, max_running: 1, running: [as({ state: "paused", paused: true })], recent: [] })?.running).toHaveLength(1);
  });
});

describe("replay texts", () => {
  it("names the state and the speed; stopped and paused name the lap", () => {
    expect(replayStatusText(base, true, true)).toBe("Running at 10×.");
    expect(replayStatusText(as({ state: "paused", paused: true }), true, true)).toBe("Paused at lap 23 (10×).");
    expect(replayStatusText(as({ state: "paused", paused: true, lap: null }), true, true)).toBe("Paused (10×).");
    expect(replayStatusText(as({ state: "starting", lap: null }), true, true)).toBe("Starting: waiting for the stream job…");
    expect(replayStatusText(as({ state: "starting", paused: true, speed: 1 }), true, true)).toContain("paused, 1×");
    expect(replayStatusText(as({ state: "stopped" }), false, true)).toBe("Stopped at lap 23.");
    expect(replayStatusText(as({ state: "stopped", lap: null }), false, true)).toBe("Stopped before the first lap.");
    expect(replayStatusText(as({ state: "stopped", note: "paused longer than 1800 s" }), false, true)).toBe(
      "Stopped at lap 23 (paused longer than 1800 s).",
    );
    expect(replayStatusText(as({ state: "stopped" }), true, true)).toBe("Another race is replaying.");
  });

  it("shows the lap reached only while a replay is active", () => {
    expect(replayLapText(base)).toBe("Lap 23 sent.");
    expect(replayLapText(as({ state: "starting", lap: null }))).toBe("No lap sent yet.");
    expect(replayLapText(as({ state: "stopped" }))).toBe("");
    expect(replayLapText(null)).toBe("");
  });

  it("explains a refused fresh start", () => {
    const msg = "the old keys of 2024 R5 could not be deleted; nothing was started";
    expect(replayMessage(new ApiError(msg, 503))).toBe(msg);
    expect(replayMessage(new ApiError("clean zone unavailable", 503))).toBe("The clean zone is not available right now.");
    expect(replayMessage(new ApiError("no replay of 2024 R5 is running", 409))).toBe("no replay of 2024 R5 is running");
  });
});

describe("which controls apply", () => {
  it("idle: only Start and the speed choice", () => {
    const c = replayControls(null, false, true, false, 60);
    expect(c).toEqual({ canStart: true, canPause: false, pauseLabel: "Pause", canStop: false, canChangeSpeed: true, shownSpeed: 60 });
    expect(replayControls(as({ state: "finished" }), false, true, false, 1).canStart).toBe(true);
    expect(replayControls(as({ state: "stopped" }), false, true, false, 1).canStop).toBe(false);
  });

  it("running or paused: Stop, Pause/Resume and the speed, never Start", () => {
    for (const [state, paused, label] of [["running", false, "Pause"], ["paused", true, "Resume"], ["starting", false, "Pause"]] as const) {
      const c = replayControls(as({ state, paused }), true, true, false, 60);
      expect([c.canStart, c.canPause, c.canStop, c.canChangeSpeed, c.pauseLabel]).toEqual([false, true, true, true, label]);
      expect(c.shownSpeed).toBe(10); // the API's speed, not the local choice
    }
    expect(isActive(as({ state: "paused" }))).toBe(true);
    expect(isActive(as({ state: "stopped" }))).toBe(false);
  });

  it("another race replaying, a pending request or a disabled API offer nothing", () => {
    const other = replayControls(null, true, true, false, 60);
    expect([other.canStart, other.canPause, other.canStop, other.canChangeSpeed]).toEqual([false, false, false, false]);
    const pending = replayControls(base, true, true, true, 60);
    expect([pending.canStart, pending.canPause, pending.canStop, pending.canChangeSpeed]).toEqual([false, false, false, false]);
    const off = replayControls(null, false, false, false, 60);
    expect([off.canStart, off.canChangeSpeed]).toEqual([false, false]);
  });
});

describe("run tracker", () => {
  it("records the first run seen, then bumps the generation on each new run id", () => {
    let t = trackRun(INITIAL_RUN, false, null);
    expect(t).toBe(INITIAL_RUN); // nothing loaded yet
    t = trackRun(t, true, "a");
    expect(t).toEqual({ seen: true, runId: "a", generation: 0 }); // page opened on run a: no reset
    expect(trackRun(t, true, "a")).toBe(t);
    const b = trackRun(t, true, "b");
    expect(b.generation).toBe(1);
    expect(trackRun(b, true, null)).toBe(b); // the run left the history: nothing to reset
    expect(trackRun(trackRun(INITIAL_RUN, true, null), true, "c").generation).toBe(1);
  });
});

describe("ReplayControl markup", () => {
  const noop = () => undefined;
  const html = (current: Replay | null, anyRunning: boolean, pending = false) =>
    renderToStaticMarkup(
      createElement(ReplayControl, {
        current,
        anyRunning,
        enabled: true,
        pending,
        error: null,
        onStart: noop,
        onStop: noop,
        onPause: noop,
        onResume: noop,
        onSpeed: noop,
      }),
    );
  const button = (markup: string, label: string) => {
    const m = new RegExp(`<button[^>]*>${label}</button>`).exec(markup);
    expect(m, `button ${label}`).not.toBeNull();
    return (m as RegExpExecArray)[0];
  };

  it("while running: Start disabled, Pause and Stop enabled, the API speed checked", () => {
    const m = html(base, true);
    expect(button(m, "Start replay")).toContain("disabled");
    expect(button(m, "Pause")).not.toContain("disabled");
    expect(button(m, "Stop")).not.toContain("disabled");
    expect(m).toMatch(/<input[^>]*checked=""[^>]*value="10"/);
    expect(m).toContain('role="status" aria-live="polite"');
    expect(m).toContain("Running at 10×.");
    expect(m).toContain("Lap 23 sent.");
  });

  it("while paused the button resumes", () => {
    const m = html(as({ state: "paused", paused: true }), true);
    expect(button(m, "Resume")).not.toContain("disabled");
    expect(m).toContain("Paused at lap 23 (10×).");
  });

  it("idle: Start enabled, Pause and Stop disabled; buttons are real buttons", () => {
    const m = html(as({ state: "stopped" }), false);
    expect(button(m, "Start replay")).not.toContain("disabled");
    expect(button(m, "Pause")).toContain("disabled");
    expect(button(m, "Stop")).toContain("disabled");
    expect(button(m, "Stop")).toContain('type="button"');
    expect(m).toContain("Stopped at lap 23.");
    expect(m).not.toMatch(/<fieldset[^>]*disabled/);
  });

  it("another race replaying disables the speed radios too", () => {
    expect(html(null, true)).toMatch(/<fieldset[^>]*disabled/);
  });
});
