import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArchiveControls } from "@/components/ArchiveControls";
import {
  advance,
  archiveStep,
  clampLap,
  hasTowerExtras,
  initialArchiveView,
  lapDurationMs,
  lapValueText,
  markerRows,
  markers,
  parseRaceQuery,
  playback,
  type Playback,
  raceControlUpTo,
  raceSearch,
  seek,
  stateAtLap,
  statusAtLap,
  toArchiveBundle,
  toArchiveList,
  type ArchiveBundle,
} from "@/lib/archive";
import { alertGroups, initialState, towerRows } from "@/lib/reducer";

import { driver, uuid } from "./helpers";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const IDS = ["max_verstappen", "lando_norris", "oscar_piastri"];

function message(lap: number, type: string, payload: Record<string, unknown>): Doc {
  return {
    lap,
    event_id: uuid(),
    message: { type, season: 2024, round: 5, event_ts: null, published_at: "2024-05-05T20:03:00.000Z", payload },
  };
}

function lapMsg(lap: number, i: number): Doc {
  const id = IDS[i] as string;
  return message(lap, "lap", {
    event_id: uuid(),
    driver_id: id,
    lap,
    race_time_s: lap * 90 + i * 1.5,
    position: i + 1,
    lap_time_s: 90 + i,
    compound: "MEDIUM",
    tyre_age: lap,
    tyre_life_laps: null,
    tyre_life_at_start_laps: null,
    produced_at_ms: 1,
  });
}

function alert(lap: number, reason: string, trigger: string, prob: number): Doc {
  return message(lap, "undercut_alert", {
    reason,
    trigger,
    season: 2024,
    round: 5,
    attacker_id: "oscar_piastri",
    defender_id: "lando_norris",
    decision_lap: lap - 1,
    attempt_lap: lap,
    gap_s: 1.5,
    undercut_prob: prob,
    threshold: 0.5,
    inputs: {},
    trigger_event_id: null,
  });
}

/** Four leader laps of three cars, a pit stop on lap 2, alerts on lap 3, session_end on lap 4. */
function rawBundle(): Doc {
  const messages: Doc[] = [];
  const snapshots: Doc[] = [];
  for (let lap = 1; lap <= 4; lap += 1) {
    for (let i = 0; i < IDS.length; i += 1) messages.push(lapMsg(lap, i));
    if (lap === 2) messages.push(message(2, "pit_in", { event_id: uuid(), driver_id: "lando_norris", lap: 2, race_time_s: 181.5 }));
    if (lap === 3) {
      messages.push(message(3, "pit_out", { event_id: uuid(), driver_id: "lando_norris", lap: 3, race_time_s: 200 }));
      messages.push(alert(3, "opportunity", "new_candidate", 0.4));
      messages.push(alert(3, "opportunity", "probability_crossed", 0.55));
      messages.push(alert(3, "attempt", "pit_in", 0.55));
    }
    if (lap === 4) messages.push(message(4, "session_end", {}));
    snapshots.push({
      lap,
      drivers: Object.fromEntries(
        IDS.map((id, i) => [
          id,
          driver(i + 1, {
            gap_ahead_s: i === 0 ? null : 1.5,
            gap_leader_s: i * 1.5,
            last_lap_time_s: 90 + i + lap / 10,
            tyre_age_laps: lap,
            undercut_flag: lap === 3 && id === "oscar_piastri",
            undercut_prob: lap === 3 && id === "oscar_piastri" ? 0.55 : null,
          }),
        ]),
      ),
      order: IDS.map((driver_id, i) => ({ driver_id, position: i + 1 })),
      tyres: { max_verstappen: { lap, tyre_life_laps: lap + 3, tyre_life_at_start_laps: 3, updated_at: "x" } },
    });
  }
  return {
    schema_version: 1,
    meta: {
      season: 2024,
      round: 5,
      race_name: "Chinese Grand Prix",
      circuit_name: null,
      race_date: "2024-04-21",
      race_start_utc: "2024-04-21T07:00:00Z",
      laps: 4,
      synthetic: true,
      source: "sample",
      n_partitions: 3,
      micro_batch: "leader_lap",
      clock: "simulated",
      model: { version: "deploy_real_G3.5_k2", scorer_sha256: "a".repeat(64), feature_set: "real", g: 3.5, k: 2 },
      builder: { git_sha: null, git_dirty: null },
    },
    entrants: [],
    snapshots,
    messages,
    decisions: [],
    track: [1, 2, 3, 4].map((lap) => ({
      lap,
      is_sc_lap: lap === 2 || lap === 3,
      is_vsc_lap: lap === 4,
      is_red_flag_lap: false,
      is_neutralised_lap: lap >= 2,
      neutralised_source: "track_status",
      track_status: null,
    })),
    race_control: [
      { seq: 0, lap: 2, time_utc: null, category: "SafetyCar", message: "SAFETY CAR DEPLOYED", status: null, flag: null, scope: null, driver_id: null, driver_code: null, kind: "sc_deployed", is_key: true },
      { seq: 1, lap: 4, time_utc: null, category: "Flag", message: "CHEQUERED FLAG", status: null, flag: null, scope: null, driver_id: null, driver_code: null, kind: "chequered", is_key: false },
    ],
  };
}

const bundle = (): ArchiveBundle => {
  const b = toArchiveBundle(rawBundle());
  if (b === undefined) throw new Error("fixture rejected");
  return b;
};

describe("toArchiveBundle", () => {
  it("accepts schema v1 and frames each message as its SSE data line", () => {
    const b = bundle();
    expect(b.meta).toMatchObject({ season: 2024, round: 5, laps: 4, synthetic: true, modelVersion: "deploy_real_G3.5_k2" });
    expect(b.snapshots.map((s) => s.lap)).toEqual([1, 2, 3, 4]);
    const first = JSON.parse(b.messages[0]?.raw as string);
    expect(first.event_id).toBe(b.messages[0]?.eventId);
    expect(first.type).toBe("lap");
    expect(b.raceControl).toHaveLength(2);
  });

  it.each([
    ["another schema version", (d: Doc) => (d.schema_version = 3)],
    ["a v2 bundle without status", (d: Doc) => (d.schema_version = 2)],
    ["a v1 bundle with timing", (d: Doc) => (d.snapshots[0].timing = { max_verstappen: { lap: 1, pit_stops: 0 } })],
    ["unsorted snapshots", (d: Doc) => d.snapshots.reverse()],
    ["meta.laps is not the last lap", (d: Doc) => (d.meta.laps = 9)],
    ["a message of another race", (d: Doc) => (d.messages[0].message.round = 6)],
    ["a message on a lap without a snapshot", (d: Doc) => (d.messages[0].lap = 7)],
    ["a bad event id", (d: Doc) => (d.messages[0].event_id = "x")],
    ["an unknown message type", (d: Doc) => (d.messages[0].message.type = "snapshot")],
    ["a driver hash missing a field", (d: Doc) => delete d.snapshots[0].drivers.max_verstappen.position],
    ["a bad tyre hash", (d: Doc) => (d.snapshots[0].tyres.max_verstappen.lap = 0)],
    ["no snapshots", (d: Doc) => (d.snapshots = [])],
    ["a bad race-control row", (d: Doc) => (d.race_control[0].kind = "nope")],
  ])("rejects %s", (_name, mutate) => {
    const d = rawBundle();
    mutate(d);
    expect(toArchiveBundle(d)).toBeUndefined();
  });

  it("parses the listing", () => {
    const list = toArchiveList({
      races: [{ season: 2024, round: 5, race_name: null, laps: 56, synthetic: true, model_version: "m", size_bytes: 10, sha256: "x" }],
    });
    expect(list).toEqual([{ season: 2024, round: 5, raceName: null, laps: 56, synthetic: true, modelVersion: "m", sizeBytes: 10 }]);
    expect(toArchiveList({ races: [{ season: 2024 }] })).toBeUndefined();
  });
});

describe("the view at a lap (the live reducer, unchanged)", () => {
  it("shows exactly the lap's snapshot in the tower", () => {
    const b = bundle();
    for (const lap of [1, 2, 3, 4]) {
      const rows = towerRows(stateAtLap(b, lap));
      const snap = b.snapshots[lap - 1];
      expect(rows.map((r) => r.driverId)).toEqual(IDS);
      for (const r of rows) {
        const h = snap?.drivers[r.driverId];
        expect([r.position, r.gapAheadS, r.gapLeaderS, r.lastLapTimeS, r.tyreAgeLaps, r.undercutFlag, r.undercutProb]).toEqual([
          h?.position,
          h?.gap_ahead_s,
          h?.gap_leader_s,
          h?.last_lap_time_s,
          h?.tyre_age_laps,
          h?.undercut_flag,
          h?.undercut_prob,
        ]);
      }
      expect(rows[0]?.lap).toBe(lap);
      expect(rows[0]?.tyreLifeLaps).toBe(lap + 3);
    }
  });

  it("builds the gap history, pits and alert groups from the lap's messages, and never speaks", () => {
    const b = bundle();
    const s2 = stateAtLap(b, 2);
    expect(Object.keys(s2.history).map(Number)).toEqual([1, 2]);
    expect(s2.drivers.lando_norris?.inPit).toBe(true);
    expect(alertGroups(s2)).toEqual([]);
    const s3 = stateAtLap(b, 3);
    expect(s3.drivers.lando_norris?.inPit).toBe(false);
    expect(alertGroups(s3)).toHaveLength(1);
    expect(alertGroups(s3)[0]).toMatchObject({ reason: "attempt", count: 3 });
    expect(s3.announcements).toEqual([]);
    expect(s3.sessionEnded).toBe(false);
    expect(s3.malformed + s3.duplicates + s3.foreign).toBe(0);
    // each lap's snapshot follows its messages, so lap 1's cars arrive before the first snapshot
    // (a diagnostic counter only; the post-race view does not show it)
    expect(s3.unknownDrivers).toBe(IDS.length);
    const s4 = stateAtLap(b, 4);
    expect(s4.sessionEnded).toBe(true);
    expect(towerRows(s4)[2]?.undercutFlag).toBe(false); // the last snapshot clears the stale flag
  });

  it("seeks forward incrementally and back from scratch with the same result", () => {
    const b = bundle();
    const one = seek(null, b, 1);
    const three = seek(one, b, 3);
    expect(three.state).toEqual(stateAtLap(b, 3));
    expect(seek(three, b, 3).state).toBe(three.state);
    expect(seek(three, b, 1).state).toEqual(stateAtLap(b, 1));
    expect(advance(initialState(2024, 5), b, 0, 0)).toEqual(initialState(2024, 5));
  });

  it("clamps a lap to the latest snapshot at or before it", () => {
    const d = rawBundle();
    d.snapshots.splice(2, 1); // no snapshot for lap 3
    d.messages = d.messages.filter((m: Doc) => m.lap !== 3);
    const b = toArchiveBundle(d) as ArchiveBundle;
    expect(clampLap(b, 3)).toBe(2);
    expect(clampLap(b, 0)).toBe(1);
    expect(clampLap(b, 99)).toBe(4);
  });

  it("archiveStep moves the view with the playback", () => {
    const b = bundle();
    let v = initialArchiveView(b, null);
    expect(v.pb).toEqual({ lap: 1, playing: false, speed: 60 });
    v = archiveStep(v, { type: "step", by: 1 }, b);
    expect(v.view.lap).toBe(2);
    expect(v.view.state).toEqual(stateAtLap(b, 2));
    expect(archiveStep(v, { type: "speed", speed: 60 }, b)).toBe(v);
    expect(initialArchiveView(b, 3).view.state).toEqual(stateAtLap(b, 3));
  });
});

describe("markers", () => {
  it("marks pit laps, the start of each flag period and the announced alerts, with text codes", () => {
    const m = markers(bundle(), (id) => id.slice(0, 3).toUpperCase());
    expect(m.map((x) => [x.lap, x.kind, x.code])).toEqual([
      [2, "sc", "SC"],
      [2, "pit", "P"],
      [3, "alert", "A"],
      [4, "vsc", "VSC"],
    ]);
    // the name starts with the visible code (WCAG 2.5.3; Step 5, finding 9)
    expect(m[1]?.label).toBe("P, lap 2: 1 pit stop (LAN). Jump to lap 2");
    expect(m[2]?.label).toBe("A, lap 3: 1 undercut attempt and 1 probability crossing. Jump to lap 3");
    expect(m[2]?.count).toBe(2); // the new_candidate alert is not announced, so not marked
  });

  it("marks an estimated neutralisation when the lake has no race-control flags", () => {
    const d = rawBundle();
    d.track = d.track.map((t: Doc) => ({ ...t, is_sc_lap: null, is_vsc_lap: null, neutralised_source: "heuristic" }));
    const m = markers(toArchiveBundle(d) as ArchiveBundle).filter((x) => x.kind === "neutral");
    expect(m.map((x) => x.lap)).toEqual([2]);
    expect(m[0]?.label).toContain("estimated from lap times");
  });

  it("lays markers out in rows that never overlap", () => {
    const laps = [1, 2, 3, 10, 11, 30];
    const rows = markerRows(laps, 1, 30, 300, 24);
    for (let i = 0; i < laps.length; i += 1) {
      for (let j = i + 1; j < laps.length; j += 1) {
        const dx = (Math.abs((laps[i] as number) - (laps[j] as number)) / 29) * 300;
        if (rows[i] === rows[j]) expect(dx).toBeGreaterThanOrEqual(24);
      }
    }
    expect(rows[0]).toBe(0);
    expect(markerRows([5], 5, 5, 300, 24)).toEqual([0]);
  });
});

describe("playback", () => {
  const laps = [1, 2, 3, 4];
  const at = (lap: number, playing = false): Playback => ({ lap, playing, speed: 60 });

  it("plays to the last lap and stops there; play at the end restarts", () => {
    let s = playback(at(3), { type: "toggle" }, laps);
    expect(s).toEqual(at(3, true));
    s = playback(s, { type: "tick" }, laps);
    expect(s).toEqual(at(4, false));
    expect(playback(s, { type: "tick" }, laps)).toBe(s);
    expect(playback(s, { type: "toggle" }, laps)).toEqual(at(1, true));
    expect(playback(at(2, true), { type: "toggle" }, laps)).toEqual(at(2));
    expect(playback(at(2, true), { type: "pause" }, laps)).toEqual(at(2));
  });

  it("steps and seeks within the laps, pausing", () => {
    expect(playback(at(1, true), { type: "step", by: -1 }, laps)).toEqual(at(1));
    expect(playback(at(4), { type: "step", by: 1 }, laps)).toEqual(at(4));
    expect(playback(at(2, true), { type: "step", by: 1 }, laps)).toEqual(at(3));
    expect(playback(at(2), { type: "seek", lap: 99 }, laps)).toEqual(at(4));
    expect(playback(at(2), { type: "seek", lap: -3 }, laps)).toEqual(at(1));
    expect(playback(at(2), { type: "seek", lap: 3 }, [1, 2, 4])).toEqual(at(2));
    expect(playback(at(2), { type: "speed", speed: 10 }, laps)).toEqual({ lap: 2, playing: false, speed: 10 });
  });

  it("a lap lasts the next lap's leader lap time at the speed", () => {
    const b = bundle();
    expect(lapDurationMs(b, 1, 1)).toBe(90_200);
    expect(lapDurationMs(b, 1, 60)).toBe(Math.round(90_200 / 60));
    expect(lapDurationMs(b, 4, 10)).toBe(9_000); // no next lap: the 90 s fallback
  });
});

describe("URL and text", () => {
  it("keeps the mode and the archive lap in the query", () => {
    expect(parseRaceQuery({})).toEqual({ mode: "live", lap: null });
    expect(parseRaceQuery({ mode: "archive", lap: "23" })).toEqual({ mode: "archive", lap: 23 });
    expect(parseRaceQuery({ mode: "archive", lap: "0" })).toEqual({ mode: "archive", lap: null });
    expect(parseRaceQuery({ mode: "live", lap: "5" })).toEqual({ mode: "live", lap: null });
    expect(raceSearch({ mode: "archive", lap: 7 })).toBe("?mode=archive&lap=7");
    expect(raceSearch({ mode: "live", lap: 7 })).toBe("");
  });

  it("names the lap for screen readers and filters race control up to the lap", () => {
    expect(lapValueText(23, 56)).toBe("Lap 23 of 56");
    const b = bundle();
    expect(raceControlUpTo(b, 3).map((m) => m.seq)).toEqual([0]);
    expect(raceControlUpTo(b, 4)).toHaveLength(2);
  });
});

describe("ArchiveControls", () => {
  it("renders a labelled slider, text buttons and a toolbar of named markers", () => {
    const b = bundle();
    const html = renderToStaticMarkup(
      createElement(ArchiveControls, {
        laps: [1, 2, 3, 4],
        total: 4,
        state: { lap: 2, playing: false, speed: 10 },
        dispatch: () => undefined,
        markers: markers(b),
      }),
    );
    expect(html).toContain('<label for="archive-lap"');
    expect(html).toMatch(/type="range"[^>]*min="1"[^>]*max="4"/);
    expect(html).toContain('aria-valuetext="Lap 2 of 4"');
    expect(html).toContain('aria-label="−1 lap (previous lap)">−1 lap</button>');
    expect(html).toContain('aria-label="+1 lap (next lap)">+1 lap</button>');
    expect(html).toContain(">Play</button>");
    expect(html).toContain('role="toolbar" aria-label="Race events: jump to a lap"');
    expect(html).toContain('aria-label="SC, lap 2: safety car. Jump to lap 2"');
    expect(html).toContain('aria-current="true"');
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1); // one tab stop for the markers
    expect(html).toContain('checked="" value="10"');
    expect(html).toContain(">Paused</p>");
  });
});

describe("schema v2 (Feature 5): timing in the snapshots and the per-lap status", () => {
  const v2 = (): Doc => {
    const d = rawBundle();
    d.schema_version = 2;
    d.status = d.snapshots.map((s: Doc) => ({
      lap: s.lap,
      status: s.lap === 2 ? "sc" : "green",
      source: "track_status",
      message: s.lap >= 2 ? "SAFETY CAR DEPLOYED" : null,
      message_lap: s.lap >= 2 ? 2 : null,
    }));
    for (const s of d.snapshots) {
      s.timing = { max_verstappen: { lap: s.lap, sector1_s: 28 + s.lap / 10, pb_sector1_s: 28.1, pit_stops: 0, updated_at: "x" } };
    }
    return d;
  };

  it("is read with its status per lap; the view's tower gets the timing through the reducer", () => {
    const b = toArchiveBundle(v2());
    expect(b?.schemaVersion).toBe(2);
    if (b === undefined) return;
    expect(hasTowerExtras(b)).toBe(true);
    expect(statusAtLap(b, 2)).toMatchObject({ lap: 2, status: "sc", message: "SAFETY CAR DEPLOYED" });
    expect(statusAtLap(b, 99)?.lap).toBe(4); // clamped like the snapshot
    const row = stateAtLap(b, 3).drivers.max_verstappen;
    expect(row?.timingLap).toBe(3);
    expect(row?.timing.sectors[0]).toBeCloseTo(28.3);
  });

  it("v1 bundles still load without the extras", () => {
    const b = bundle();
    expect(b.schemaVersion).toBe(1);
    expect(hasTowerExtras(b)).toBe(false);
    expect(statusAtLap(b, 2)).toBeNull();
    expect(b.snapshots.every((s) => Object.keys(s.timing).length === 0)).toBe(true);
  });

  it.each([
    ["status laps that differ from the snapshots", (d: Doc) => d.status.pop()],
    ["a bad status", (d: Doc) => (d.status[0].status = "yellow")],
    ["a timing entry without a lap", (d: Doc) => (d.snapshots[0].timing.max_verstappen.lap = 0)],
  ])("rejects %s", (_name, mutate) => {
    const d = v2();
    mutate(d);
    expect(toArchiveBundle(d)).toBeUndefined();
  });
});
