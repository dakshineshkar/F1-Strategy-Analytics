/** Replay controls (Feature 7): the status guard, the texts, which controls apply, the run tracker that resets the
 * live view on a new run, the inline transport's phases, its two-press Stop and its one announcement, and the
 * ReplayTransport markup. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplayTransport } from "@/components/ReplayTransport";
import { ApiError, type Replay, toReplay, toReplayStatus } from "@/lib/api";
import type { Mode } from "@/lib/call";
import {
  blockedReason,
  CONFIRM_MS,
  confirmStep,
  INITIAL_RUN,
  isActive,
  liveText,
  replayAgainSpeed,
  replayControls,
  replayMessage,
  replayStatusText,
  trackRun,
  transportPhase,
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

describe("the transport's phase", () => {
  it("active while starting, running or paused; over after a finish, a stop, a failure or the session's end", () => {
    expect(transportPhase(null, false, true, false)).toBe("idle");
    expect(transportPhase(null, false, null, false)).toBe("idle");
    for (const state of ["starting", "running", "paused"] as const) expect(transportPhase(as({ state }), true, true, false)).toBe("active");
    for (const state of ["finished", "stopped", "failed"] as const) expect(transportPhase(as({ state }), false, true, true)).toBe("over");
    expect(transportPhase(as({ state: "stopped" }), false, true, false)).toBe("over");
    expect(transportPhase(null, false, true, true)).toBe("over");
  });

  it("blocked while another race replays or replay is off, with the reason as text", () => {
    expect(transportPhase(null, true, true, false)).toBe("blocked");
    expect(transportPhase(as({ state: "finished" }), true, true, true)).toBe("blocked");
    expect(transportPhase(null, false, false, false)).toBe("blocked");
    expect(blockedReason(true, true)).toBe("Another race is replaying");
    expect(blockedReason(false, false)).toBe("Replay disabled on the API");
    expect(blockedReason(false, true)).toBeNull();
  });

  it("Replay again uses the last run's speed when it is an offered one", () => {
    expect(replayAgainSpeed(as({ state: "stopped", speed: 10 }), 60)).toBe(10);
    expect(replayAgainSpeed(as({ state: "stopped", speed: 7 }), 60)).toBe(60);
    expect(replayAgainSpeed(null, 1)).toBe(1);
  });
});

describe("two-press Stop (confirmStep)", () => {
  it("the first press arms, the second stops", () => {
    const first = confirmStep("idle", "press", true);
    expect(first).toEqual({ state: "armed", fire: false });
    expect(confirmStep(first.state, "press", true)).toEqual({ state: "idle", fire: true });
    expect(CONFIRM_MS).toBe(4000);
  });

  it("Escape, the timeout and a reset cancel without stopping", () => {
    for (const e of ["escape", "timeout", "reset"] as const) expect(confirmStep("armed", e, true)).toEqual({ state: "idle", fire: false });
    expect(confirmStep("idle", "escape", true)).toEqual({ state: "idle", fire: false });
  });

  it("a replay that ended on its own (finished or failed) while armed disarms it and sends no stop", () => {
    // the transport passes active = false once the status says finished or failed
    expect(confirmStep("armed", "press", false)).toEqual({ state: "idle", fire: false });
    expect(confirmStep("armed", "timeout", false)).toEqual({ state: "idle", fire: false });
    expect(confirmStep("idle", "press", false)).toEqual({ state: "idle", fire: false });
  });
});

describe("the one announcement (liveText)", () => {
  const live: Mode = { label: "LIVE", tone: "live", description: "Connected to the race stream." };
  const fin: Mode = { label: "FINISHED", tone: "ended", description: "The session ended." };
  it("the replay's state while this race has a replay or a start is blocked; never a lap counter", () => {
    expect(liveText(live, base, true, true)).toBe("Running at 10×.");
    expect(liveText(live, as({ state: "paused", paused: true }), true, true)).toBe("Paused at lap 23 (10×).");
    expect(liveText(live, null, true, true)).toBe("Another race is replaying.");
    expect(liveText(live, null, false, false)).toBe("Replay is disabled on the API.");
    expect(liveText(live, base, true, true)).not.toContain("sent");
  });
  it("otherwise the mode's sentence (LIVE, FINISHED after session end, NOT REPLAYING)", () => {
    expect(liveText(live, null, false, true)).toBe("Connected to the race stream.");
    expect(liveText(fin, null, false, null)).toBe("The session ended.");
  });
});

describe("ReplayTransport markup", () => {
  const noop = () => undefined;
  const html = (current: Replay | null, anyRunning: boolean, opts: { pending?: boolean; ended?: boolean; archive?: boolean; enabled?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(ReplayTransport, {
        current,
        anyRunning,
        enabled: opts.enabled ?? true,
        pending: opts.pending ?? false,
        ended: opts.ended ?? false,
        liveText: "announced text",
        onArchive: opts.archive ? noop : null,
        onStart: noop,
        onStop: noop,
        onPause: noop,
        onResume: noop,
        onSpeed: noop,
      }),
    );
  const button = (markup: string, label: string) => {
    const m = new RegExp(`<button[^>]*>(?:<svg[^>]*>.*?</svg>)?${label}</button>`).exec(markup);
    expect(m, `button ${label}`).not.toBeNull();
    return (m as RegExpExecArray)[0];
  };

  it("idle: Start replay (neutral, never the signal) and the speed radios; nothing else", () => {
    const m = html(null, false);
    expect(button(m, "Start replay")).not.toContain("disabled");
    expect(button(m, "Start replay")).toContain("btn-strong");
    expect(m).not.toContain("btn-primary");
    expect(m).toMatch(/<fieldset class="tp-speeds"><legend class="visually-hidden">Replay speed<\/legend>/);
    expect(m).toMatch(/<input[^>]*checked=""[^>]*value="60"/);
    expect(m).not.toContain(">Pause<");
    expect(m).not.toContain(">Stop<");
    expect(m).not.toContain("Replay again");
  });

  it("active (running): Pause, Stop and the API's speed; no Start", () => {
    const m = html(base, true);
    expect(button(m, "Pause")).not.toContain("disabled");
    expect(button(m, "Stop")).not.toContain("disabled");
    expect(button(m, "Stop")).toContain('type="button"');
    expect(m).toMatch(/<input[^>]*checked=""[^>]*value="10"/);
    expect(m).not.toContain("Start replay");
  });

  it("active (paused): Resume", () => {
    expect(button(html(as({ state: "paused", paused: true }), true), "Resume")).not.toContain("disabled");
  });

  it("over: Replay again at the last run's speed, plus the archive when there is one", () => {
    const m = html(as({ state: "stopped" }), false, { ended: true, archive: true });
    expect(button(m, "Replay again")).not.toContain("disabled");
    expect(m).toContain("at 10×, the last run&#x27;s speed");
    expect(button(m, "Open the post-race archive")).toBeTruthy();
    expect(html(as({ state: "finished" }), false, { ended: true })).not.toContain("Open the post-race archive");
    expect(m).not.toContain(">Stop<");
    expect(m).not.toContain("tp-speeds");
  });

  it("blocked: Start disabled with the reason as visible text", () => {
    const m = html(null, true);
    expect(button(m, "Start replay")).toContain("disabled");
    expect(m).toContain('<span class="tp-reason">Another race is replaying</span>');
    expect(html(null, false, { enabled: false })).toContain('<span class="tp-reason">Replay disabled on the API</span>');
  });

  it("a start in flight says Starting…", () => {
    expect(html(null, false, { pending: true })).toMatch(/<button[^>]*disabled=""[^>]*>.*Starting…<\/button>/);
  });

  it("one visually hidden polite region; icons are decorative; every button has visible text", () => {
    const m = html(base, true);
    expect(m).toContain('<p id="replay-status" class="visually-hidden" role="status" aria-live="polite">announced text</p>');
    expect((m.match(/aria-live/g) ?? []).length).toBe(1);
    for (const svg of m.match(/<svg[^>]*>/g) ?? []) expect(svg).toContain('aria-hidden="true"');
    for (const b of m.match(/<button[^>]*>.*?<\/button>/g) ?? []) expect(b.replace(/<[^>]+>/g, "").trim().length).toBeGreaterThan(2);
    expect(m).toContain('role="group" aria-label="Replay"');
  });

  it("another race replaying disables the speed radios too", () => {
    expect(html(as({ state: "stopped" }), true)).not.toContain("tp-speeds");
    expect(html(base, true, { pending: true })).toMatch(/<fieldset class="tp-speeds" disabled=""/);
  });
});
