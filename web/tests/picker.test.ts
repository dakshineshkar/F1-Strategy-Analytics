/** Race picker, redesign step 4A (critique F36): the "Start here" choice for a grader. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RacePicker } from "@/components/RacePicker";
import type { Race } from "@/lib/api";
import { DEMO_RACE, type RunningReplay, startHere } from "@/lib/races";

const race = (season: number, round: number, name: string, laps = 57): Race => ({ season, round, name, laps, synthetic: false });
const RACES: Race[] = [race(2023, 5, "Miami Grand Prix"), race(2024, 1, "Bahrain Grand Prix"), race(2024, 5, "Chinese Grand Prix", 56)];
const job = (season: number, round: number, lap: number | null, paused = false): RunningReplay => ({ season, round, state: "running", paused, lap });

describe("startHere", () => {
  it("offers the race replaying now, with its lap and pause state", () => {
    const pick = startHere(RACES, [job(2024, 1, 12, true)], [{ season: 2024, round: 1 }]);
    expect(pick).toMatchObject({ why: "replaying", lap: 12, paused: true, archived: true });
    expect(pick?.race.name).toBe("Bahrain Grand Prix");
  });

  it("falls back to the demo race (make demo's 2024 R5) when nothing replays, with its archive state", () => {
    expect(DEMO_RACE).toEqual({ season: 2024, round: 5 });
    const pick = startHere(RACES, [], null);
    expect(pick).toMatchObject({ why: "demo", lap: null, paused: false, archived: false });
    expect(pick?.race.round).toBe(5);
    expect(startHere(RACES, [], [{ season: 2024, round: 5 }])?.archived).toBe(true);
  });

  it("ignores a replay of a race that is not listed, and uses the newest season without the demo race", () => {
    expect(startHere(RACES, [job(2021, 9, 3)], [])?.why).toBe("demo");
    const noDemo = RACES.filter((r) => r.round !== 5);
    expect(startHere(noDemo, [], [])).toMatchObject({ why: "newest", race: { season: 2024, round: 1 } });
    expect(startHere([], [], [])).toBeNull();
  });
});

describe("RacePicker", () => {
  it("reserves the Start here card while the races load, before the search", () => {
    const m = renderToStaticMarkup(createElement(RacePicker));
    expect(m).toContain('<section class="panel start-here" aria-labelledby="start-h" aria-busy="true">');
    expect(m.indexOf("start-here")).toBeLessThan(m.indexOf("race-search"));
    expect(m).toContain("Loading races…");
  });
});
