/** F09 / F10, Step 3: the alert history the connect snapshot carries, deduplicated with the live alerts by
 * ``event_id``; and the SMOKE TEST stamp from ``checks.model.smoke_test`` (the name prefix only as a fallback). */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AlertFeed } from "@/components/AlertFeed";
import { type Health, toHealth, toHealthModel } from "@/lib/api";
import { alertIsNew, dividersWithin, feedItems, HISTORY_TEXT, modelIdentity } from "@/lib/call";
import { parseEvent } from "@/lib/events";
import { alertGroups, initialState, type RaceAction, raceReducer, type RaceState } from "@/lib/reducer";

import { alertMsg, snapshotMsg } from "./helpers";

const ORDER = ["ver", "nor", "lec", "pia", "sai"];
const ev = (raw: string): RaceAction => ({ type: "event", raw });
const run = (actions: RaceAction[], from: RaceState = initialState(2024, 5)): RaceState => actions.reduce(raceReducer, from);
/** A live alert frame and the same alert as a history item (the SSE frame object, as ``recent_alerts`` holds it). */
const alert = (a: string, d: string, lap: number, prob = 0.3): { raw: string; item: unknown } => {
  const raw = alertMsg(a, d, "opportunity", "new_candidate", prob, lap);
  return { raw, item: JSON.parse(raw) as unknown };
};
const connect = (items: unknown[], flags: Record<string, boolean> = {}, lap = 0): RaceAction =>
  ev(snapshotMsg(ORDER, lap, flags, { recent_alerts: items }));

describe("the connect snapshot's alert history (F09)", () => {
  it("parses recent_alerts with the live alert parser and drops bad or foreign items", () => {
    const a = alert("lec", "nor", 9);
    const foreign = { ...(a.item as object), round: 6 };
    const e = parseEvent(snapshotMsg(ORDER, 0, {}, { recent_alerts: [a.item, foreign, { type: "lap" }, "x"] }));
    expect(e?.type).toBe("snapshot");
    if (e?.type !== "snapshot") return;
    expect(e.recentAlerts.map((x) => x.eventId)).toEqual([JSON.parse(a.raw).event_id]);
    expect(e.recentDropped).toBe(3);
    // per-lap snapshots (and older APIs) carry no history
    const lapSnap = parseEvent(snapshotMsg(ORDER, 4));
    expect(lapSnap?.type === "snapshot" && lapSnap.recentAlerts.length === 0 && lapSnap.recentDropped === 0).toBe(true);
  });

  it("joins each alert's pair group marked as history, oldest first, without touching the rows", () => {
    const a1 = alert("lec", "nor", 7, 0.2);
    const a2 = alert("lec", "nor", 9, 0.55);
    const a3 = alert("sai", "pia", 8);
    const s = run([connect([a1.item, a3.item, a2.item], { lec: false })]);
    const groups = alertGroups(s);
    expect(groups.map((g) => [g.key, g.count, g.decisionLap, g.history])).toEqual([
      ["lec>nor", 2, 9, "before_open"],
      ["sai>pia", 1, 8, "before_open"],
    ]);
    // the snapshot's hashes decide the flags; history never sets them, never announces, never adds rows
    expect(s.drivers.lec?.undercutFlag).toBe(false);
    expect(s.announcements).toEqual([]);
    expect(Object.keys(s.drivers).sort()).toEqual([...ORDER].sort());
    expect(s.malformed).toBe(0);
  });

  it("a live alert that is also in the history is counted once (dedup by event_id)", () => {
    const a1 = alert("lec", "nor", 9);
    const a2 = alert("sai", "pia", 9);
    const s = run([connect([a1.item, a2.item]), ev(a1.raw), ev(a2.raw)]);
    expect(alertGroups(s).map((g) => [g.key, g.count])).toEqual([
      ["sai>pia", 1],
      ["lec>nor", 1],
    ]);
    expect(s.duplicates).toBe(2);
    // and the other way round: alerts applied live, then repeated in a later connect snapshot
    const live = run([connect([]), ev(a1.raw)]);
    const again = run([connect([a1.item])], live);
    expect(alertGroups(again).map((g) => [g.key, g.count, g.history])).toEqual([["lec>nor", 1, null]]);
  });

  it("a reconnect's snapshot repeating the history changes nothing; what it missed is marked while_away", () => {
    const a1 = alert("lec", "nor", 9);
    const a2 = alert("sai", "pia", 12);
    const first = run([connect([a1.item]), ev(a1.raw)]);
    const same = run([{ type: "connection", status: "reconnecting" }, connect([a1.item])], first);
    expect(alertGroups(same)).toEqual(alertGroups(first));
    const more = run([connect([a1.item, a2.item])], first);
    expect(alertGroups(more).map((g) => [g.key, g.count, g.history])).toEqual([
      ["sai>pia", 1, "while_away"],
      ["lec>nor", 1, "before_open"], // its live copy was the duplicate, so it stays history
    ]);
  });

  it("a new live alert on a history pair makes the group live again", () => {
    const old = alert("lec", "nor", 9);
    const now = alert("lec", "nor", 12, 0.6);
    const s = run([connect([old.item]), ev(now.raw)]);
    const [g] = alertGroups(s);
    expect([g?.count, g?.history, g?.decisionLap]).toEqual([2, null, 12]);
    expect(s.drivers.lec?.undercutFlag).toBe(true); // the live alert still marks the row
  });

  it("history is never new, even at the leader's lap or the one before; live keeps the Step 2c rule", () => {
    const h = alert("lec", "nor", 12);
    const s = run([connect([h.item])]);
    const [g] = alertGroups(s);
    expect(g && alertIsNew(g, 13)).toBe(false);
    expect(alertIsNew({ decisionLap: 12, history: null }, 13)).toBe(true);
    expect(alertIsNew({ decisionLap: 12 }, 13)).toBe(true);
    expect(alertIsNew({ decisionLap: 12, history: null }, 13, true)).toBe(false); // none new after the finish
  });

  it("a malformed history item is counted, never the snapshot", () => {
    const good = alert("lec", "nor", 9);
    const bad = { ...(good.item as Record<string, unknown>), event_id: "not-a-uuid" };
    const s = run([connect([bad, good.item])]);
    expect(s.malformed).toBe(1);
    expect(s.snapshots).toBe(1);
    expect(alertGroups(s)).toHaveLength(1);
  });

  it("the feed puts a quiet divider above the history block, not in the signal colour", () => {
    const h1 = alert("lec", "nor", 9);
    const h2 = alert("sai", "pia", 10);
    const live = alert("pia", "lec", 13);
    const s = run([connect([h1.item, h2.item]), ev(live.raw)]);
    const groups = alertGroups(s);
    const items = feedItems(groups);
    expect(items.map((it) => (it.kind === "alert" ? it.group.key : it.text))).toEqual([
      "pia>lec",
      HISTORY_TEXT.before_open,
      "sai>pia",
      "lec>nor",
    ]);
    expect(HISTORY_TEXT.before_open).toBe("Received before you opened the page");
    expect(dividersWithin(items, 1)).toBe(0);
    expect(dividersWithin(items, 2)).toBe(1);
    const m = renderToStaticMarkup(createElement(AlertFeed, { groups, announcement: null, maxLap: 13 }));
    expect(m).toContain('<li data-flip="history:before_open:sai&gt;pia" class="alert-divider alert-divider-before_open">Received before you opened the page</li>');
    // the history rows are never "new" (no signal colour class), the live one from the leader's lap is
    expect(m.match(/class="alert alert-[a-z]+ is-new"/g)).toHaveLength(1);
    expect(m.match(/is-history/g)).toHaveLength(2);
    expect(m).toContain(", received before you opened the page");
    // no "N×" for single alerts; the count label stays for pairs with more
    expect(m).not.toContain("alerts for this pair");
  });

  it("the N alerts for this pair label counts history and live alerts once each", () => {
    const h = alert("lec", "nor", 9);
    const l = alert("lec", "nor", 12);
    const s = run([connect([h.item]), ev(h.raw), ev(l.raw)]);
    const m = renderToStaticMarkup(createElement(AlertFeed, { groups: alertGroups(s), announcement: null, maxLap: 13 }));
    expect(m).toContain("2 alerts for this pair");
    expect(m).not.toContain("alert-divider");
  });

  it("the /state snapshot action (a reconnect) carries no history and keeps the groups", () => {
    const h = alert("lec", "nor", 9);
    const s = run([connect([h.item])]);
    const after = raceReducer(s, { type: "snapshot", data: { season: 2024, round: 5, drivers: {}, order: [], tyres: {}, timing: {} } });
    expect(alertGroups(after)).toEqual(alertGroups(s));
  });
});

describe("the SMOKE TEST stamp from checks.model.smoke_test (F10)", () => {
  const health = (model: Record<string, unknown>): Health | null =>
    toHealth({ status: "ok", checks: { model: { ok: true, feature_set: "real", g: 3.5, k: 2, ...model } }, lake: { scheme: "file", mode: "sample", synthetic: true } }) ?? null;

  it("parses the four additive fields", () => {
    expect(
      toHealthModel({
        model: { model_version: "sample_x", smoke_test: true, trained_on: "sample", model_id: "sample_x", stamp: "SMOKE TEST: demo only" },
      }),
    ).toEqual({ model_version: "sample_x", feature_set: null, g: null, k: null, smoke_test: true, trained_on: "sample", model_id: "sample_x", stamp: "SMOKE TEST: demo only" });
    expect(toHealthModel({ model: { model_version: "m", smoke_test: "yes", trained_on: "lake", model_id: 3, stamp: "" } })).toMatchObject({
      smoke_test: null,
      trained_on: null,
      model_id: null,
      stamp: null,
    });
  });

  it("follows smoke_test both ways, and falls back to the name prefix only when it is missing", () => {
    expect(modelIdentity(health({ model_version: "deploy_real_G3.5_k2", smoke_test: true }))?.smoke).toBe(true);
    expect(modelIdentity(health({ model_version: "sample_deploy_real_G3.5_k2", smoke_test: false }))?.smoke).toBe(false);
    expect(modelIdentity(health({ model_version: "sample_deploy_real_G3.5_k2" }))?.smoke).toBe(true);
    expect(modelIdentity(health({ model_version: "deploy_real_G3.5_k2" }))?.smoke).toBe(false);
  });
});
