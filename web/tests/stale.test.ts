/** Cars with no timing (bug 1 of the 2026-11-19 polish round): a car is stale when the leader has completed 2 or
 * more laps since its last crossing, beyond the laps it is down. A lapped car that is still racing never is.
 * Stale cars keep their rows (sorted to the bottom) and are never part of the call. */
import { describe, expect, it } from "vitest";

import { flaggedPairs, staleFlaggedCount, theCall } from "@/lib/call";
import { initialState, type RaceAction, raceReducer, type RaceState } from "@/lib/reducer";
import { displayRows, lapProgress, lapsBehind, STALE_LAPS, staleIds, staleSince } from "@/lib/stale";
import { NO_TIMING } from "@/lib/timing";

import { alertMsg, lap, snapshot } from "./helpers";

const run = (raws: string[], from: RaceState = initialState(2024, 5)): RaceState =>
  raws.map((raw) => ({ type: "event", raw }) as RaceAction).reduce(raceReducer, from);

/** ``laps`` crossings of one car: lap n at ``n × per + offset`` seconds, at Jolpica position ``pos``. */
function crossings(id: string, from: number, to: number, per: number, offset: number, pos: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) out.push(lap(id, n, n * per + offset, pos));
  return out;
}

/** Laps ``from``..``to`` of a field, in crossing order within each lap. */
function field(cars: { id: string; per: number; offset: number; pos: number; last: number }[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) {
    for (const c of [...cars].sort((a, b) => a.per * n + a.offset - (b.per * n + b.offset))) {
      if (n <= c.last) out.push(...crossings(c.id, n, n, c.per, c.offset, c.pos));
    }
  }
  return out;
}

/** Every crossing of the field up to race time ``untilS`` (after ``fromS``), in time order. */
function byTime(cars: { id: string; per: number; offset: number; pos: number; last: number }[], fromS: number, untilS: number): string[] {
  const all: { t: number; raw: string }[] = [];
  for (const c of cars) {
    for (let n = 1; n <= c.last; n += 1) {
      const t = n * c.per + c.offset;
      if (t > fromS && t <= untilS) all.push({ t, raw: lap(c.id, n, t, c.pos) });
    }
  }
  return all.sort((a, b) => a.t - b.t).map((x) => x.raw);
}

describe("stale cars", () => {
  it("a car turns stale once the leader has completed 2 laps since its last crossing", () => {
    expect(STALE_LAPS).toBe(2);
    const cars = [
      { id: "ver", per: 95, offset: 0, pos: 1, last: 99 },
      { id: "nor", per: 95, offset: 2, pos: 2, last: 99 },
      { id: "bot", per: 95, offset: 4, pos: 3, last: 19 }, // stops after lap 19
    ];
    const at20 = run(field(cars, 1, 20));
    expect(staleSince(at20, "bot")).toBeNull(); // the leader is one lap on: it may just be slow
    const at21 = run(field(cars, 21, 21), at20);
    expect(staleSince(at21, "bot")).toBe(19);
    expect([...staleIds(at21)]).toEqual(["bot"]);
    // the leader and the cars that keep crossing are never stale
    expect(staleSince(at21, "ver")).toBeNull();
    expect(staleSince(at21, "nor")).toBeNull();
    expect(staleSince(at21, "nobody")).toBeNull();
  });

  it("a lapped car that is still racing stays eligible (laps down from the crossings this page saw)", () => {
    const cars = [
      { id: "ver", per: 95, offset: 0, pos: 1, last: 99 },
      { id: "sar", per: 101, offset: 0, pos: 20, last: 99 }, // loses 6 s a lap: lapped before lap 16
    ];
    let s = run(byTime(cars, 0, 21 * 95));
    // the leader is on lap 21 and the lapped car on lap 19 (one lap down, mid-lap): not stale
    expect(s.drivers.ver?.lap).toBe(21);
    expect(s.drivers.sar?.lap).toBe(19);
    expect(lapsBehind(s, "sar")).toBe(1);
    expect(staleSince(s, "sar")).toBeNull();
    s = run(byTime(cars, 21 * 95, 22 * 95), s);
    expect(s.drivers.sar?.lap).toBe(20);
    expect(staleSince(s, "sar")).toBeNull();
  });

  it("after a late join (no crossings received) the gap to the leader says how many laps a car is down", () => {
    const order = ["ver", "nor", "sar", "bot"];
    const data = snapshot(order);
    const at = (n: number) => ({ ...NO_TIMING, lap: n });
    data.timing = { ver: at(30), nor: at(30), sar: at(28), bot: at(19) };
    data.drivers.ver = { ...data.drivers.ver!, last_lap_time_s: 96 };
    data.drivers.sar = { ...data.drivers.sar!, gap_leader_s: 110 }; // more than one lap: one lap down
    data.drivers.bot = { ...data.drivers.bot!, gap_leader_s: 20 }; // was on the lead lap when it stopped
    const s = raceReducer(initialState(2024, 5), { type: "snapshot", data });
    expect(lapsBehind(s, "sar")).toBe(1);
    expect(staleSince(s, "sar")).toBeNull(); // 30 - 28 - 1 = 1 lap: still racing
    expect(staleSince(s, "bot")).toBe(19);
  });

  it("keeps every row and moves the stale ones to the bottom in their own order", () => {
    const cars = [
      { id: "ver", per: 95, offset: 0, pos: 1, last: 99 },
      { id: "bot", per: 95, offset: 1, pos: 2, last: 10 },
      { id: "nor", per: 95, offset: 2, pos: 3, last: 99 },
      { id: "tsu", per: 95, offset: 3, pos: 4, last: 11 },
      { id: "pia", per: 95, offset: 5, pos: 5, last: 99 },
    ];
    const s = run(field(cars, 1, 14));
    const stale = staleIds(s);
    expect([...stale].sort()).toEqual(["bot", "tsu"]);
    const rows = displayRows(s, stale).map((r) => r.driverId);
    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 3)).toEqual(["ver", "nor", "pia"]);
    expect(new Set(rows.slice(3))).toEqual(new Set(["bot", "tsu"]));
    expect(rows.indexOf("tsu")).toBeLessThan(rows.indexOf("bot")); // tsu ran more laps, so it ranks higher
  });

  it("counts how many running cars have crossed the line on the leader's lap", () => {
    const cars = [
      { id: "ver", per: 95, offset: 0, pos: 1, last: 99 },
      { id: "nor", per: 95, offset: 2, pos: 2, last: 99 },
      { id: "bot", per: 95, offset: 4, pos: 3, last: 5 },
    ];
    let s = run(field(cars, 1, 9));
    expect(lapProgress(s)).toEqual({ lap: 9, crossed: 2, running: 2 }); // the stale car is not counted
    s = run([lap("ver", 10, 950, 1)], s);
    expect(lapProgress(s)).toEqual({ lap: 10, crossed: 1, running: 2 });
    expect(lapProgress(initialState(2024, 5))).toBeNull();
  });
});

describe("the 2024 R5 case: a flag left in a stopped car's hash is never the call", () => {
  // BOT stopped after lap 19 with its flag set (its last decision); TSU stopped after lap 26. From lap 27
  // BOT sits directly behind TSU in the order, so the pair BOT -> TSU was shown as the call until now.
  const cars = [
    { id: "ver", per: 95, offset: 0, pos: 1, last: 99 },
    { id: "nor", per: 95, offset: 3, pos: 2, last: 99 },
    { id: "tsu", per: 95, offset: 30, pos: 3, last: 26 },
    { id: "bot", per: 95, offset: 31, pos: 4, last: 19 },
  ];
  const at19 = run([...field(cars, 1, 19), alertMsg("bot", "tsu", "opportunity", "new_candidate", 0.42, 19)]);

  it("is a valid call while both cars are running", () => {
    expect(theCall(at19)).toMatchObject({ attackerId: "bot", defenderId: "tsu" });
    expect(staleFlaggedCount(at19)).toBe(0);
  });

  it("is excluded once the attacker is stale, and stays excluded after the defender stops too", () => {
    const at21 = run(field(cars, 20, 21), at19);
    expect(at21.drivers.bot?.undercutFlag).toBe(true); // the hash still carries it
    expect(flaggedPairs(at21)).toEqual([]);
    expect(theCall(at21)).toBeNull();
    expect(staleFlaggedCount(at21)).toBe(1);
    const at28 = run(field(cars, 22, 28), at21);
    expect(at28.order.slice(-2)).toEqual(["tsu", "bot"]); // BOT directly behind TSU
    expect(theCall(at28)).toBeNull();
    expect(staleFlaggedCount(at28)).toBe(1);
  });

  it("a running car flagged on a stale car ahead is excluded as well", () => {
    const s = run([...field(cars, 20, 21), alertMsg("nor", "ver", "opportunity", "new_candidate", 0.6, 21)], at19);
    expect(theCall(s)?.attackerId).toBe("nor"); // the running pair is still the call
    expect(flaggedPairs(s).map((p) => p.attackerId)).toEqual(["nor"]);
  });
});
