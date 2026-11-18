/** Feature 5 race-status banner: the guard, the announcement transitions (only on change), the
 * rendered banner, and the archive's per-lap status (v2) next to v1 bundles. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RaceStatusBanner } from "@/components/RaceStatusBanner";
import { type RaceStatus, type RaceStatusKind, statusAnnouncement, toRaceStatus } from "@/lib/raceStatus";

const st = (status: RaceStatusKind, lap: number, more: Partial<RaceStatus> = {}): RaceStatus => ({
  lap,
  status,
  source: "track_status",
  message: null,
  messageLap: null,
  ...more,
});

describe("toRaceStatus", () => {
  it("accepts the API's shape and rejects anything else", () => {
    expect(
      toRaceStatus({ season: 2024, round: 5, lap: 23, status: "sc", source: "track_status", message: "SAFETY CAR DEPLOYED", message_lap: 23 }),
    ).toEqual({ lap: 23, status: "sc", source: "track_status", message: "SAFETY CAR DEPLOYED", messageLap: 23 });
    for (const bad of [
      { lap: 0, status: "sc", source: "track_status", message: null, message_lap: null },
      { lap: 3, status: "yellow", source: "track_status", message: null, message_lap: null },
      { lap: 3, status: "sc", source: "heuristic", message: null, message_lap: null },
      { lap: 3, status: "sc", source: "none", message: 5, message_lap: null },
      null,
    ]) {
      expect(toRaceStatus(bad)).toBeUndefined();
    }
  });
});

describe("announcements: politely, only when the status changes", () => {
  it("green -> vsc -> sc -> green announces each change once", () => {
    const seq = [st("green", 20), st("green", 21), st("vsc", 22), st("vsc", 22, { message: "VSC" }), st("sc", 23), st("sc", 24), st("green", 32)];
    const said: (string | null)[] = [];
    let prev: RaceStatus | null = null;
    for (const s of seq) {
      said.push(statusAnnouncement(prev, s));
      prev = s;
    }
    expect(said).toEqual([
      null, // the race starts green: nothing to report
      null,
      "Race status: virtual safety car, lap 22.",
      null, // a new message with the same status stays silent
      "Race status: safety car, lap 23.",
      null,
      "Race status: green flag, racing, lap 32.",
    ]);
  });

  it("unknown is never announced and never counts as a previous status", () => {
    expect(statusAnnouncement(null, st("unknown", 1))).toBeNull();
    expect(statusAnnouncement(st("unknown", 2), st("green", 3))).toBeNull();
    expect(statusAnnouncement(st("unknown", 2), st("neutralised", 3, { source: "estimated" }))).toBe(
      "Race status: neutralised (safety car or virtual safety car, estimated), lap 3.",
    );
    expect(statusAnnouncement(null, st("red", 9))).toBe("Race status: red flag, session stopped, lap 9.");
    expect(statusAnnouncement(st("sc", 5), null)).toBeNull();
  });
});

describe("the banner", () => {
  const html = (status: RaceStatus | null, more: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(RaceStatusBanner, { status, ...more }));

  it.each([
    ["green", "GREEN"],
    ["sc", "SC"],
    ["vsc", "VSC"],
    ["red", "RED FLAG"],
    ["neutralised", "SC / VSC"],
    ["unknown", "UNKNOWN"],
  ] as const)("%s shows the text code %s and a border class", (kind, code) => {
    const m = html(st(kind, 10));
    expect(m).toContain(`class="race-status race-status-${kind}"`);
    expect(m).toMatch(new RegExp(`class="race-status-code"[^>]*>${code.replace("/", "\\/")}`));
  });

  it("shows the latest race-control message with its lap and the source; a live region exists", () => {
    const m = html(st("sc", 24, { message: "SAFETY CAR DEPLOYED", messageLap: 23 }));
    expect(m).toContain("Lap 24");
    expect(m).toContain("SAFETY CAR DEPLOYED (lap 23)");
    // the parts are separate sentences for screen readers (no "Lap 24SAFETY")
    expect(m).toContain('Lap 24</span><span class="visually-hidden">. </span>');
    expect(m).toContain("from the track-status feed and race control (laps up to now)");
    expect(m).toContain('aria-live="polite"');
    expect(m).toContain('aria-describedby="tip-racestatus"');
  });

  it("labels the estimate, waits before the first lap, and stays silent in post-race mode", () => {
    const est = html(st("neutralised", 22, { source: "estimated" }));
    expect(est).toContain('<span class="race-status-est"> est.</span>');
    expect(est).toContain("estimated from lap times (no race-control feed for this race)");
    expect(html(null)).toContain("Waiting for the first lap.");
    const v1 = html(null, { unavailable: "v1 bundle note", announce: false });
    expect(v1).toContain("v1 bundle note");
    expect(v1).not.toContain("aria-live");
  });
});
