import { describe, expect, it } from "vitest";

import {
  alertGroups,
  alertKey,
  gapsAt,
  HISTORY_LAPS,
  initialState,
  lapsDown,
  MAX_ANNOUNCEMENTS,
  MAX_SEEN_IDS,
  raceReducer,
  type RaceAction,
  type RaceState,
  towerRows,
} from "@/lib/reducer";

import type { RaceSnapshot } from "@/lib/api";
import { NO_TIMING } from "@/lib/timing";

import { alertMsg, driver, lap, msg, snapshot, snapshotMsg, uuid } from "./helpers";

const run = (actions: RaceAction[], start: RaceState = initialState(2024, 5)): RaceState =>
  actions.reduce(raceReducer, start);
const ev = (raw: string): RaceAction => ({ type: "event", raw });

describe("ordering", () => {
  it("follows the order sorted set of the snapshot", () => {
    const s = run([{ type: "snapshot", data: snapshot(["verstappen", "norris", "leclerc"]) }]);
    expect(towerRows(s).map((r) => [r.driverId, r.position])).toEqual([
      ["verstappen", 1],
      ["norris", 2],
      ["leclerc", 3],
    ]);
    expect(s.snapshots).toBe(1);
  });

  it("sorts the zset by score, not by arrival order", () => {
    const data = snapshot(["a", "b", "c"]);
    data.order = [
      { driver_id: "c", position: 3 },
      { driver_id: "a", position: 1 },
      { driver_id: "b", position: 2 },
    ];
    expect(run([{ type: "snapshot", data }]).order).toEqual(["a", "b", "c"]);
  });

  it("re-ranks live by laps completed, then crossing time (like live_state.live_order)", () => {
    const s = run([
      { type: "snapshot", data: snapshot(["a", "b", "c"]) },
      ev(lap("a", 10, 1000, 1)),
      ev(lap("b", 10, 1001.5, 2)),
      ev(lap("c", 10, 1001.0, 3)), // c crossed before b: c is now P2
      ev(lap("a", 11, 1095, 1)), // a is a lap ahead
    ]);
    expect(s.order).toEqual(["a", "c", "b"]);
    expect(towerRows(s).map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it("a later snapshot re-syncs the order from Redis", () => {
    const s = run([
      { type: "snapshot", data: snapshot(["a", "b"]) },
      ev(lap("b", 3, 300, 1)),
      ev(lap("a", 3, 301, 2)),
      { type: "snapshot", data: snapshot(["a", "b"]) },
    ]);
    expect(s.order).toEqual(["a", "b"]);
    expect(s.drivers.a?.position).toBe(1);
  });
});

describe("gaps from lap events", () => {
  it("uses race time at the same lap number, leader = Jolpica P1, ahead = P-1", () => {
    const s = run([ev(lap("a", 5, 500, 1)), ev(lap("b", 5, 501.234, 2)), ev(lap("c", 5, 503.5, 3))]);
    expect(s.drivers.a).toMatchObject({ gapLeaderS: 0, gapAheadS: null });
    expect(s.drivers.b).toMatchObject({ gapLeaderS: 1.234, gapAheadS: 1.234 });
    expect(s.drivers.c).toMatchObject({ gapLeaderS: 3.5, gapAheadS: 2.266 });
  });

  it("a lapped car is compared with the leader at the same lap number", () => {
    const s = run([ev(lap("a", 4, 400, 1)), ev(lap("a", 5, 490, 1)), ev(lap("z", 4, 506, 2))]);
    expect(s.drivers.z?.gapLeaderS).toBe(106);
    expect(gapsAt(s.history, 5, "z")).toEqual({ leader: null, ahead: null });
  });

  it("a late leader event fixes the gaps of cars already at that lap", () => {
    const s = run([ev(lap("b", 6, 601, 2)), ev(lap("a", 6, 600, 1))]);
    expect(s.drivers.b).toMatchObject({ gapLeaderS: 1, gapAheadS: 1 });
  });

  it("keeps the snapshot gap when the leader's lap has not arrived", () => {
    const s = run([{ type: "snapshot", data: snapshot(["a", "b"]) }, ev(lap("b", 7, 700, 2))]);
    expect(s.drivers.b?.gapLeaderS).toBe(1.5);
  });
});

describe("out-of-order and duplicate laps", () => {
  it("an older lap goes into the history only; the tower does not regress", () => {
    const s = run([ev(lap("a", 9, 900, 1, { compound: "HARD", tyre_age: 9 })), ev(lap("a", 8, 800, 1, { compound: "SOFT", tyre_age: 8 }))]);
    expect(s.drivers.a).toMatchObject({ lap: 9, compound: "HARD", tyreAgeLaps: 9, raceTimeS: 900 });
    expect(s.history[8]?.a?.raceTimeS).toBe(800);
  });

  it("a repeated event id is applied once", () => {
    const id = uuid();
    const raw = lap("a", 3, 300, 1, { event_id: id });
    const s = run([ev(raw), ev(raw), ev(raw)]);
    expect(s.duplicates).toBe(2);
    expect(s.seen.filter((x) => x === id)).toHaveLength(1);
  });

  it("keeps only the last HISTORY_LAPS laps and the last MAX_SEEN_IDS ids", () => {
    const actions = Array.from({ length: HISTORY_LAPS + 10 }, (_, i) => ev(lap("a", i + 1, (i + 1) * 90, 1)));
    const s = run(actions);
    expect(Object.keys(s.history).map(Number).sort((x, y) => x - y)[0]).toBe(11);
    const many = run(Array.from({ length: MAX_SEEN_IDS + 3 }, (_, i) => ev(lap("a", 1, i, 1))));
    expect(many.seen).toHaveLength(MAX_SEEN_IDS);
  });
});

describe("pit cycle", () => {
  it("pit_in marks IN PIT and counts the stop; pit_out clears it; the next lap brings the new tyre", () => {
    let s = run([ev(lap("a", 20, 2000, 1, { compound: "MEDIUM", tyre_age: 20 })), ev(msg("pit_in", { driver_id: "a", lap: 21, race_time_s: 2095 }))]);
    expect(s.drivers.a).toMatchObject({ inPit: true, stops: 1, lastPitLap: 21 });
    s = run([ev(lap("a", 21, 2095, 1, { compound: "MEDIUM", tyre_age: 21 })), ev(msg("pit_out", { driver_id: "a", lap: 22, race_time_s: 2117 }))], s);
    expect(s.drivers.a).toMatchObject({ inPit: false, stops: 1 });
    s = run([ev(lap("a", 22, 2210, 1, { compound: "HARD", tyre_age: 1 }))], s);
    expect(s.drivers.a).toMatchObject({ compound: "HARD", tyreAgeLaps: 1, inPit: false });
  });

  it("a pit event of an unknown driver adds a row", () => {
    const s = run([{ type: "snapshot", data: snapshot(["a"]) }, ev(msg("pit_in", { driver_id: "newbie", lap: 3, race_time_s: 1 }))]);
    expect(s.unknownDrivers).toBe(1);
    expect(s.drivers.newbie).toMatchObject({ inPit: true, known: false });
    expect(s.order).toContain("newbie");
  });
});

describe("alert grouping", () => {
  it("groups by (attacker, defender) with the latest probability and reason, newest first", () => {
    const s = run([
      ev(alertMsg("hulkenberg", "bottas", "opportunity", "new_candidate", 0.31, 6)),
      ev(alertMsg("norris", "piastri", "opportunity", "new_candidate", 0.2, 6)),
      ev(alertMsg("hulkenberg", "bottas", "opportunity", "probability_crossed", 0.55, 7)),
      ev(alertMsg("hulkenberg", "bottas", "attempt", "pit_in", 0.55, 7)),
    ]);
    const groups = alertGroups(s);
    expect(groups.map((g) => g.key)).toEqual([alertKey("hulkenberg", "bottas"), alertKey("norris", "piastri")]);
    expect(groups[0]).toMatchObject({ reason: "attempt", trigger: "pit_in", prob: 0.55, decisionLap: 7, count: 3 });
    expect(s.drivers.hulkenberg).toMatchObject({ undercutFlag: true, undercutProb: 0.55 });
  });

  it("queues announcements only for attempts and threshold crossings", () => {
    const s = run([
      ev(alertMsg("a", "b", "opportunity", "new_candidate", 0.3)),
      ev(alertMsg("a", "b", "opportunity", "probability_crossed", 0.6)),
      ev(alertMsg("a", "b", "attempt", "pit_in", 0.6)),
    ]);
    expect(s.announcements.map((a) => a.text)).toEqual([
      expect.stringContaining("Undercut chance up"),
      expect.stringContaining("Undercut attempt"),
    ]);
    const many = run(Array.from({ length: MAX_ANNOUNCEMENTS + 3 }, () => ev(alertMsg("a", "b", "attempt", "pit_in", 0.7))));
    expect(many.announcements).toHaveLength(MAX_ANNOUNCEMENTS);
  });
});

describe("snapshot after reconnect", () => {
  it("replaces tower values from Redis and keeps client history and alerts", () => {
    const before = run([ev(lap("a", 5, 500, 1)), ev(alertMsg("a", "b", "opportunity", "new_candidate", 0.4))]);
    const data = snapshot(["b", "a"]);
    data.drivers.a = { ...data.drivers.a!, tyre_compound: "SOFT", undercut_prob: 0.1, undercut_flag: false };
    const after = raceReducer(before, { type: "snapshot", data });
    expect(after.order).toEqual(["b", "a"]);
    expect(after.drivers.a).toMatchObject({ compound: "SOFT", undercutProb: 0.1, undercutFlag: false, known: true, lap: 5 });
    expect(after.history).toBe(before.history);
    expect(after.alerts).toBe(before.alerts);
  });

  it("ignores a snapshot of another race", () => {
    const s = run([{ type: "snapshot", data: { ...snapshot(["a"]), round: 6 } }]);
    expect(s.foreign).toBe(1);
    expect(s.order).toEqual([]);
  });
});

describe("session_end", () => {
  it("closes the race and ignores everything after it", () => {
    const s = run([ev(lap("a", 1, 90, 1)), ev(msg("session_end", {})), ev(lap("a", 2, 180, 1)), { type: "connection", status: "reconnecting" }]);
    expect(s.sessionEnded).toBe(true);
    expect(s.connection).toBe("closed");
    expect(s.drivers.a?.lap).toBe(1);
  });
});

describe("malformed input never throws", () => {
  const bad = [
    "",
    "not json",
    "null",
    "[]",
    "42",
    JSON.stringify({ type: "lap" }),
    msg("lap", { driver_id: "a", lap: 0, race_time_s: 1, position: 1 }),
    msg("lap", { driver_id: "A B", lap: 1, race_time_s: 1, position: 1 }),
    msg("lap", { driver_id: "a", lap: 1, race_time_s: "1", position: 1 }),
    msg("lap", { driver_id: "a", lap: 1, race_time_s: -5, position: 1 }),
    msg("lap", { driver_id: "a", lap: 1.5, race_time_s: 1, position: 1 }),
    msg("lap", { driver_id: "a", lap: 1, race_time_s: 1, position: "1" }),
    msg("pit_in", { driver_id: "a" }),
    msg("bogus", {}),
    msg("undercut_alert", { reason: "opportunity", trigger: "pit_in" }),
    JSON.stringify({ type: "lap", season: 2024, round: 5, event_id: "nope", payload: {} }),
    JSON.stringify({ type: "session_end", season: 2024, round: 5, event_id: uuid() }),
    '{"type":"lap","season":2024,"round":5,"payload":{"x":NaN}}',
  ];
  it.each(bad.map((b, i) => [i, b]))("case %i is counted as malformed", (_i, raw) => {
    const before = initialState(2024, 5);
    const after = raceReducer(before, { type: "event", raw });
    expect(after.malformed).toBe(1);
    expect(after.drivers).toEqual({});
  });

  it("other races' events are counted as foreign", () => {
    const s = run([ev(lap("a", 1, 1, 1).replace('"round":5', '"round":6'))]);
    expect(s.foreign).toBe(1);
    expect(s.drivers).toEqual({});
  });

  it("an unknown driver on a lap event gets a row", () => {
    const s = run([{ type: "snapshot", data: snapshot(["a"]) }, ev(lap("mystery_driver", 2, 200, 2))]);
    expect(s.unknownDrivers).toBe(1);
    expect(towerRows(s).map((r) => r.driverId)).toEqual(["mystery_driver", "a"]);
  });

  it("an unknown compound becomes UNKNOWN", () => {
    const s = run([ev(lap("a", 1, 1, 1, { compound: "SUPERSOFT" })), ev(lap("b", 1, 2, 2, { compound: null }))]);
    expect([s.drivers.a?.compound, s.drivers.b?.compound]).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});

describe("laps down", () => {
  it("is not lapped when the leader merely crossed the line first", () => {
    const s = run([ev(lap("a", 11, 1100, 1)), ev(lap("b", 11, 1101, 2)), ev(lap("a", 12, 1190, 1))]);
    expect(lapsDown(s, "b")).toBe(0);
    expect(lapsDown(s, "a")).toBe(0);
  });

  it("is a lap down once the leader completed one more lap before the car's crossing", () => {
    const s = run([ev(lap("a", 10, 1000, 1)), ev(lap("a", 11, 1090, 1)), ev(lap("z", 10, 1095, 2))]);
    expect(lapsDown(s, "z")).toBe(1);
    const t = run([ev(lap("a", 10, 1000, 1)), ev(lap("a", 11, 1090, 1)), ev(lap("a", 12, 1180, 1)), ev(lap("z", 10, 1185, 2))]);
    expect(lapsDown(t, "z")).toBe(2);
  });

  it("is 0 without lap data", () => {
    expect(lapsDown(run([{ type: "snapshot", data: snapshot(["a", "b"]) }]), "b")).toBe(0);
    expect(lapsDown(initialState(2024, 5), "nobody")).toBe(0);
  });
});

describe("pushed snapshots (event: snapshot)", () => {
  it("replace stale undercut flags left by alerts", () => {
    let s = run([
      ev(snapshotMsg(["a", "b", "c"], 0)),
      ev(alertMsg("b", "a", "opportunity", "new_candidate", 0.4, 9)),
      ev(alertMsg("c", "b", "opportunity", "new_candidate", 0.3, 9)),
    ]);
    expect([s.drivers.b?.undercutFlag, s.drivers.c?.undercutFlag]).toEqual([true, true]);
    // Next leader lap: Redis says only c is still a candidate.
    s = run([ev(snapshotMsg(["a", "b", "c"], 11, { c: true }))], s);
    expect(s.drivers.b).toMatchObject({ undercutFlag: false, undercutProb: null });
    expect(s.drivers.c).toMatchObject({ undercutFlag: true, undercutProb: 0.66 });
    expect(Object.values(s.drivers).filter((d) => d.undercutFlag)).toHaveLength(1);
    expect(s.alerts[alertKey("b", "a")]?.count).toBe(1); // the feed history is kept
  });

  it("apply every time (ids repeat across connections) and never enter the dedupe list", () => {
    const raw = snapshotMsg(["a", "b"], 0);
    const s = run([ev(raw), ev(raw), ev(raw)]);
    expect(s.snapshots).toBe(3);
    expect(s.duplicates).toBe(0);
    expect(s.seen).toEqual([]);
  });

  it("set the order from the zset", () => {
    const s = run([ev(lap("a", 3, 300, 1)), ev(lap("b", 3, 301, 2)), ev(snapshotMsg(["b", "a"], 3))]);
    expect(s.order).toEqual(["b", "a"]);
  });

  it("malformed or foreign snapshots change only counters", () => {
    const bad = [
      snapshotMsg(["a"], 1, {}, { event_id: "snap-1" }),
      snapshotMsg(["a"], -1),
      snapshotMsg(["a"], 1, {}, { drivers: { a: { position: "1" } } }),
      snapshotMsg(["a"], 1, {}, { order: "a" }),
    ];
    const s = run(bad.map(ev));
    expect(s.malformed).toBe(4);
    const foreign = run([ev(snapshotMsg(["a"], 1, {}, { round: 6 }))]);
    expect(foreign.foreign).toBe(1);
    expect(foreign.drivers).toEqual({});
  });
});

describe("unknown drivers (Fix D)", () => {
  const ev2 = (raw: string): RaceAction => ({ type: "event", raw });

  it("the API's order (lap snapshot before its first lap frame) gives 0 on a fresh race", () => {
    const s = run([
      ev2(snapshotMsg([], 0)), // connect before the race has any key
      ev2(snapshotMsg(["a", "b", "c"], 1)),
      ev2(lap("b", 1, 90, 2)),
      ev2(lap("a", 1, 89, 1)),
      ev2(lap("c", 1, 91, 3)),
    ]);
    expect(s.unknownDrivers).toBe(0);
    expect(towerRows(s).map((r) => r.driverId)).toEqual(["a", "b", "c"]);
  });

  it("the old order (first lap frame before its snapshot) counted that car: the artefact seen live", () => {
    const s = run([
      ev2(snapshotMsg([], 0)),
      ev2(lap("b", 1, 90, 2)), // e.g. leclerc P2, the first lap-1 message of 2024 R1
      ev2(snapshotMsg(["a", "b", "c"], 1)),
      ev2(lap("a", 1, 89, 1)),
      ev2(lap("c", 1, 91, 3)),
    ]);
    expect(s.unknownDrivers).toBe(1);
  });

  it("a genuinely unknown driver id still increments the counter (lap, pit and alert)", () => {
    const s = run([
      ev2(snapshotMsg(["a", "b"], 1)),
      ev2(lap("a", 2, 180, 1)),
      ev2(lap("ghost", 2, 181, 3)),
      ev2(msg("pit_in", { driver_id: "phantom", lap: 2, race_time_s: 182 })),
      ev2(alertMsg("spectre", "a", "opportunity", "new_candidate", 0.4)),
    ]);
    expect(s.unknownDrivers).toBe(3);
    expect(Object.keys(s.drivers)).toEqual(expect.arrayContaining(["ghost", "phantom", "spectre"]));
    // the same id again is a known row now: counted once
    expect(run([ev2(lap("ghost", 3, 270, 3))], s).unknownDrivers).toBe(3);
  });
});

// ------------------------------------------------------------- F37: opening or reconnecting mid-lap
/** A snapshot whose timing hash gives each car its latest lap (``laps``) and gaps ``gaps``. */
function lapSnapshot(
  order: string[],
  laps: Record<string, number>,
  gaps: number[] = order.map((_, i) => i * 1.5),
  hash: "timing" | "tyres" | "none" = "timing",
): RaceSnapshot {
  const data = snapshot(order);
  order.forEach((id, i) => {
    data.drivers[id] = driver(i + 1, {
      gap_leader_s: gaps[i] ?? null,
      gap_ahead_s: i === 0 ? null : round3((gaps[i] ?? 0) - (gaps[i - 1] ?? 0)),
    });
  });
  for (const [id, l] of Object.entries(laps)) {
    if (hash === "timing") data.timing[id] = { lap: l, ...NO_TIMING };
    if (hash === "tyres") data.tyres[id] = { lap: l, tyre_life_laps: l, tyre_life_at_start_laps: 0 };
  }
  return data;
}
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const snapAction = (data: RaceSnapshot): RaceAction => ({ type: "snapshot", data });
const snapEvent = (data: RaceSnapshot, n: number): RaceAction =>
  ev(JSON.stringify({ type: "snapshot", lap: n, ...data, event_id: `snapshot-${n}`, sse_sent_at_ms: 1 }));

/** Rows shown below a row whose gap to the leader is more than 5 s larger (the F37 symptom). */
function inversions(s: RaceState): string[] {
  const out: string[] = [];
  let maxAbove = -Infinity;
  for (const r of towerRows(s)) {
    if (r.gapLeaderS === null) continue;
    if (r.gapLeaderS + 5 < maxAbove) out.push(r.driverId);
    maxAbove = Math.max(maxAbove, r.gapLeaderS);
  }
  return out;
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

describe("opening mid-lap (F37)", () => {
  // The F37 capture, 2024 R5 lap 10: the page opens after VER..SAI crossed lap 9 and before
  // STR..ZHO did; then STR..ZHO cross lap 9 and VER, PER, NOR, ALO cross lap 10.
  const F37 = [
    "max_verstappen", "perez", "norris", "alonso", "piastri", "leclerc", "russell", "sainz",
    "stroll", "gasly", "bottas", "ricciardo", "ocon", "albon", "kevin_magnussen", "sargeant",
    "hamilton", "hulkenberg", "tsunoda", "zhou",
  ];
  const GAPS = [0, 8.0, 10.9, 14.7, 15.4, 16.5, 17.9, 18.4, 27.1, 28.8, 29.4, 29.9, 31.8, 32.8, 33.5, 34.7, 36.1, 47.5, 51.9, 57.4];
  const LAP = 96;
  const opened = (): RaceState => {
    const laps = Object.fromEntries(F37.map((id, i) => [id, i < 8 ? 9 : 8]));
    let s = run([snapAction(lapSnapshot(F37, laps, GAPS))]);
    for (let i = 8; i < 20; i++) s = raceReducer(s, ev(lap(F37[i]!, 9, 9 * LAP + GAPS[i]!, i + 1)));
    for (let i = 0; i < 4; i++) s = raceReducer(s, ev(lap(F37[i]!, 10, 10 * LAP + GAPS[i]!, i + 1)));
    return s;
  };

  it("the exact F37 case: PIA, LEC, RUS, SAI come out P5-P8, not P17-P20", () => {
    const s = opened();
    expect(towerRows(s).map((r) => [r.position, r.driverId])).toEqual(F37.map((id, i) => [i + 1, id]));
    expect(s.order.slice(4, 8)).toEqual(["piastri", "leclerc", "russell", "sainz"]);
    expect(towerRows(s).slice(4, 8).map((r) => r.lap)).toEqual([9, 9, 9, 9]);
    expect(inversions(s)).toEqual([]);
  });

  it("a car with no timing and no tyre hash keeps today's fallback (previous order)", () => {
    // cars with a lap event rank first; the others keep the snapshot order below them
    let s = run([snapAction(lapSnapshot(F37, {}, GAPS, "none"))]);
    s = raceReducer(s, ev(lap("stroll", 9, 9 * LAP + 27.1, 9)));
    expect(s.order[0]).toBe("stroll");
    expect(s.order.slice(1)).toEqual(F37.filter((id) => id !== "stroll"));
    expect(s.drivers.piastri).toMatchObject({ lap: null, snapshotRank: null });
  });

  it("uses the tyre hash's lap when the timing hash is missing", () => {
    const laps = { a: 5, b: 5, c: 4 };
    let s = run([snapAction(lapSnapshot(["a", "b", "c"], laps, [0, 1, 2], "tyres"))]);
    s = raceReducer(s, ev(lap("c", 5, 5 * LAP + 2, 3)));
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(s.drivers.b).toMatchObject({ lap: 5, raceTimeS: null, snapshotRank: 1 });
  });

  it("a lapped car is ordered by laps completed first", () => {
    // L is a lap down: lap 7 in the snapshot while the others are on 9 / 8
    let s = run([snapAction(lapSnapshot(["a", "b", "y", "l"], { a: 9, b: 9, y: 8, l: 7 }, [0, 2, 90, 100]))]);
    s = raceReducer(s, ev(lap("l", 8, 8 * LAP + 100, 4)));
    expect(s.order).toEqual(["a", "b", "y", "l"]); // y crossed lap 8 before the snapshot, l after it
    s = raceReducer(s, ev(lap("a", 10, 10 * LAP, 1)));
    expect(s.order).toEqual(["a", "b", "y", "l"]);
    expect(s.drivers.l).toMatchObject({ lap: 8, snapshotRank: null });
    s = raceReducer(s, ev(lap("y", 9, 9 * LAP + 90, 3)));
    s = raceReducer(s, ev(lap("l", 9, 9 * LAP + 100, 4)));
    expect(s.order).toEqual(["a", "b", "y", "l"]);
  });

  it("a snapshot lap older than or equal to the page's own lap never overwrites it", () => {
    const seen = run([snapAction(lapSnapshot(["a", "b"], {}, [0, 1], "none")), ev(lap("a", 12, 1150.2, 1)), ev(lap("b", 12, 1151.4, 2))]);
    const older = raceReducer(seen, snapAction(lapSnapshot(["a", "b"], { a: 11, b: 11 })));
    expect(older.drivers.a).toMatchObject({ lap: 12, raceTimeS: 1150.2, jolpicaPosition: 1, snapshotRank: null });
    const equal = raceReducer(seen, snapAction(lapSnapshot(["a", "b"], { a: 12, b: 12 })));
    expect(equal.drivers.a).toMatchObject({ lap: 12, raceTimeS: 1150.2, jolpicaPosition: 1, snapshotRank: 0 });
    expect(equal.drivers.b).toMatchObject({ lap: 12, raceTimeS: 1151.4, snapshotRank: 1 });
  });

  it("a leader-lap snapshot that arrives before its own lap frames keeps the zset order", () => {
    // 2024 R5 lap 1 as recorded: the snapshot already holds every lap-1 crossing; c and d's frames
    // arrive later. No car jumps to P1 meanwhile.
    const order = ["a", "b", "c", "d"];
    let s = run([ev(snapshotMsg([], 0)), snapEvent(lapSnapshot(order, { a: 1, b: 1, c: 1, d: 1 }), 1)]);
    const seen: string[][] = [];
    for (const [id, t, p] of [["b", 92, 2], ["a", 91, 1], ["c", 93, 3], ["d", 94, 4]] as const) {
      s = raceReducer(s, ev(lap(id, 1, t, p)));
      seen.push([...s.order]);
    }
    expect(seen).toEqual([order, order, order, order]);
    expect(s.drivers.d).toMatchObject({ lap: 1, raceTimeS: 94, snapshotRank: 3 });
  });

  it("is pure: the previous state is never mutated", () => {
    const before = deepFreeze(opened());
    const snap = deepFreeze(lapSnapshot(F37, Object.fromEntries(F37.map((id) => [id, 11]))));
    expect(() => raceReducer(before, snapAction(snap))).not.toThrow();
    expect(() => raceReducer(before, ev(lap("piastri", 10, 10 * LAP + 15.4, 5)))).not.toThrow();
    expect(before.order.slice(4, 8)).toEqual(["piastri", "leclerc", "russell", "sainz"]);
  });
});

describe("reconnect after missed laps (F37)", () => {
  it("keeps the zset order between cars timed before the gap and cars only the snapshot knows", () => {
    // the page timed laps 1-13 of a, b, c and a's lap 14, then dropped; b crossed lap 14 in the gap
    const actions: RaceAction[] = [snapAction(lapSnapshot(["a", "b", "c"], {}, [0, 1, 2], "none"))];
    for (let l = 1; l <= 13; l++) {
      actions.push(ev(lap("a", l, l * 96, 1)), ev(lap("b", l, l * 96 + 1, 2)), ev(lap("c", l, l * 96 + 2, 3)));
    }
    actions.push(ev(lap("a", 14, 14 * 96, 1)), { type: "connection", status: "reconnecting" });
    const before = run(actions);
    expect(before.drivers.b).toMatchObject({ lap: 13 });

    let s = raceReducer(before, snapAction(lapSnapshot(["a", "b", "c"], { a: 14, b: 14, c: 13 })));
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(s.drivers.a).toMatchObject({ lap: 14, raceTimeS: 14 * 96, snapshotRank: 0 });
    expect(s.drivers.b).toMatchObject({ lap: 14, raceTimeS: null, snapshotRank: 1 });

    s = raceReducer(s, ev(lap("c", 14, 14 * 96 + 2, 3))); // crossed after the snapshot: behind both
    expect(s.order).toEqual(["a", "b", "c"]);
    s = raceReducer(s, ev(lap("b", 15, 15 * 96 + 1, 2))); // a lap-15 car goes ahead of every lap-14 car
    expect(s.order).toEqual(["b", "a", "c"]);
    s = raceReducer(s, ev(lap("a", 15, 15 * 96, 1)));
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(towerRows(s).map((r) => r.position)).toEqual([1, 2, 3]);
    expect(inversions(s)).toEqual([]);
  });
});
