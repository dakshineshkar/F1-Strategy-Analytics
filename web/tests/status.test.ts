/** Feature 5 race status: the guard, the announcement transitions (only on change), and its place in the post-race
 * archive's status strip (step 4A: the code chip with its border class, the latest key message with its lap, the
 * source as visible text, silent while scrubbing). */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArchiveStrip } from "@/components/ArchiveStrip";
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

describe("the archive strip's race status (was the banner)", () => {
  const html = (status: RaceStatus | null, more: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ArchiveStrip, { status, lap: status?.lap ?? 1, laps: 56, modelVersion: "deploy_real_G3.5_k2", scorerSha256: "0a9b7dfbc2056f4b", ...more }),
    );

  it.each([
    ["green", "GREEN"],
    ["sc", "SC"],
    ["vsc", "VSC"],
    ["red", "RED FLAG"],
    ["neutralised", "SC / VSC"],
    ["unknown", "UNKNOWN"],
  ] as const)("%s shows the text code %s in the chip that carries the border style", (kind, code) => {
    const m = html(st(kind, 10));
    expect(m).toContain(`class="ss-cell ss-track race-status race-status-${kind}"`);
    expect(m).toMatch(new RegExp(`class="ss-v race-status-code">${code.replace("/", "\\/")}`));
    // no side bar: the old banner class is gone
    expect(m).not.toContain('class="race-status race-status-');
  });

  it("shows the lap, the latest race-control message with its lap and the source, as visible text", () => {
    const m = html(st("sc", 24, { message: "SAFETY CAR DEPLOYED", messageLap: 23 }));
    expect(m).toContain('aria-label="Race status"');
    expect(m).toContain('<span class="lc-now">24</span><span class="ss-of">/56</span>');
    expect(m).toContain("Race control, lap 23:");
    expect(m).toContain('<span class="ss-rc-text">SAFETY CAR DEPLOYED</span>');
    expect(m).toContain("Track status from the track-status feed and race control (laps up to now).");
    expect(m).toContain("POST-RACE");
    expect(m).toContain("deploy_real_G3.5_k2");
    expect(m).toContain("scorer 0a9b7dfbc205…");
    expect(m).not.toContain("aria-live");
  });

  it("labels the estimate, says when there is no key message, and shows the v1 note", () => {
    const est = html(st("neutralised", 22, { source: "estimated" }));
    expect(est).toContain('<span class="race-status-est"> est.</span>');
    expect(est).toContain("estimated from lap times (no race-control feed for this race)");
    expect(est).toContain("No key race-control message up to this lap.");
    expect(html(null)).toContain("Waiting for the first lap.");
    const v1 = html(null, { unavailable: "v1 bundle note" });
    expect(v1).toContain("v1 bundle note");
    expect(v1).toContain(">n/a<");
    expect(v1).not.toContain("aria-live");
  });
});
