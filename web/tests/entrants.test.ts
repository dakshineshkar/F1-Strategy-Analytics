import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DriversView } from "@/components/DriversView";
import { TeamBadge } from "@/components/TeamBadge";
import { TimingTower } from "@/components/TimingTower";
import RootLayout from "@/app/layout";
import {
  byGrid,
  colourSourceText,
  type Entrant,
  fullName,
  gridLabel,
  indexEntrants,
  teamHighlight,
  teammates,
  teamTitle,
  toEntrant,
  toEntrants,
} from "@/lib/entrants";
import type { DriverRow } from "@/lib/reducer";
import { contrastRatio, dark, light } from "@/lib/theme";
import { NO_TIMING } from "@/lib/timing";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** Invented entrants (no F1 data). */
const entrant = (id: string, more: Partial<Entrant> = {}): Entrant => ({
  driver_id: id,
  code: id.slice(0, 3).toUpperCase(),
  given_name: "Given",
  family_name: id.charAt(0).toUpperCase() + id.slice(1),
  car_number: 10,
  grid: 1,
  constructor_id: "ferrari",
  team_name: "Ferrari",
  team_code: "FER",
  team_lineage_id: "ferrari",
  team_colour_hex: "#D9142B",
  team_text_hex: "#FFFFFF",
  colour_source: "ti_race",
  nationality: "Monegasque",
  nationality_code: "MON",
  ...more,
});

const HAAS = {
  constructor_id: "haas",
  team_name: "Haas F1 Team",
  team_code: "HAA",
  team_lineage_id: "haas",
  team_colour_hex: "#FFFFFF",
  team_text_hex: "#000000",
} as const;

const LIST: Entrant[] = [
  entrant("alpha", { grid: 2, car_number: 16 }),
  entrant("bravo", { ...HAAS, grid: 0, car_number: 20, colour_source: "ti_neighbour_round_4", nationality: "Danish", nationality_code: "DEN" }),
  entrant("charlie", { grid: 1, car_number: 55 }),
  entrant("delta", { ...HAAS, grid: null, car_number: 27, colour_source: "project_palette" }),
];
const INDEX = indexEntrants(LIST);

describe("entrants guard", () => {
  it("accepts a valid response and keeps every field", () => {
    const body = { season: 2024, round: 5, entrants: LIST };
    expect(toEntrants(body)).toEqual(body);
  });

  it.each([
    ["bad colour", { team_colour_hex: "red" }],
    ["lower-case hex", { team_colour_hex: "#d9142b" }],
    ["unknown text colour", { team_text_hex: "#777777" }],
    ["unknown colour source", { colour_source: "tracinginsights" }],
    ["round 0 neighbour", { colour_source: "ti_neighbour_round_0" }],
    ["long team code", { team_code: "FERR" }],
    ["bad nationality code", { nationality_code: "Monaco" }],
    ["bad driver id", { driver_id: "Max-Verstappen" }],
    ["fractional car number", { car_number: 1.5 }],
  ])("rejects %s", (_name, bad) => {
    expect(toEntrant({ ...entrant("alpha"), ...bad })).toBeUndefined();
  });

  it("rejects a duplicate driver and a non-list", () => {
    expect(toEntrants({ season: 2024, round: 5, entrants: [LIST[0], LIST[0]] })).toBeUndefined();
    expect(toEntrants({ season: 2024, round: 5, entrants: {} })).toBeUndefined();
  });

  it("accepts nulls where the API allows them", () => {
    const e = toEntrant({ ...entrant("alpha"), code: null, grid: null, car_number: null, nationality_code: null });
    expect(e?.grid).toBeNull();
    expect(e?.nationality_code).toBeNull();
  });
});

describe("entrants helpers", () => {
  it("sorts by grid with pit-lane and unknown slots last", () => {
    expect([...LIST].sort(byGrid).map((e) => e.driver_id)).toEqual(["charlie", "alpha", "bravo", "delta"]);
    expect(gridLabel(0)).toBe("Pit lane");
    expect(gridLabel(null)).toBe("—");
    expect(gridLabel(7)).toBe("7");
  });

  it("links teammates of the same race only", () => {
    expect(teammates(INDEX, "alpha").map((e) => e.driver_id)).toEqual(["charlie"]);
    expect(teammates(INDEX, "bravo").map((e) => e.driver_id)).toEqual(["delta"]);
    expect(teammates(INDEX, "nobody")).toEqual([]);
    expect(teamTitle(INDEX, "alpha")).toBe("Ferrari · teammate: Given Charlie (CHA)");
    expect(teamTitle(INDEX, "nobody")).toBeNull();
    expect(fullName(entrant("x", { given_name: null, family_name: null }))).toBe("x");
  });

  it("highlights the hovered row solidly and its teammate dashed", () => {
    expect(teamHighlight(INDEX, null, "alpha")).toBeUndefined();
    expect(teamHighlight(INDEX, "alpha", "alpha")).toBe("is-team-hover");
    expect(teamHighlight(INDEX, "alpha", "charlie")).toBe("is-teammate");
    expect(teamHighlight(INDEX, "alpha", "bravo")).toBeUndefined();
    expect(teamHighlight(INDEX, "ghost", "ghost")).toBeUndefined();
    expect(teamHighlight(INDEX, "ghost", "alpha")).toBeUndefined();
  });

  it("names every colour source in words", () => {
    expect(colourSourceText("ti_race")).toBe("colour from this race's timing data");
    expect(colourSourceText("ti_neighbour_round_12")).toBe("colour from round 12 (this race's timing data has none)");
    expect(colourSourceText("project_palette")).toBe("project palette colour (no timing data for this team)");
  });

  it("badge text meets 4.5:1 on every fixture colour, and the outline 3:1 on every background", () => {
    for (const e of LIST) expect(contrastRatio(e.team_text_hex, e.team_colour_hex)).toBeGreaterThanOrEqual(4.5);
    for (const t of [dark, light]) {
      for (const bg of [t.bg, t.surface, t.surface2]) expect(contrastRatio(t.border, bg)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("TeamBadge", () => {
  const m = html(createElement(TeamBadge, { entrant: LIST[1] as Entrant }));

  it("is a text swatch with the team name, never an image", () => {
    expect(m).toContain('title="Haas F1 Team"');
    expect(m).toContain('<span aria-hidden="true">HAA</span>');
    expect(m).toContain('<span class="visually-hidden">Haas F1 Team, </span>');
    expect(m).toContain("--team:#FFFFFF");
    expect(m).toContain("--team-ink:#000000");
    expect(m).not.toMatch(/<img|<svg|url\(/);
  });
});

describe("DriversView", () => {
  const m = html(createElement(DriversView, { entrants: LIST }));
  const body = m.slice(m.indexOf("<tbody>"));

  it("is a captioned table sorted by grid", () => {
    expect(m).toContain('<caption id="drivers-title">Drivers');
    const order = [...body.matchAll(/data-driver="([a-z]+)"/g)].map((x) => x[1]);
    expect(order).toEqual(["charlie", "alpha", "bravo", "delta"]);
    expect(body).toContain('<td class="c-grid">Pit lane</td>');
  });

  it("shows badge, code, name, nationality code, team name and car number as text", () => {
    expect(body).toContain('<span class="code">CHA</span> <span class="name">Given Charlie</span>');
    expect(body).toContain('<abbr title="Danish">DEN</abbr>');
    expect(body).toContain('<td class="c-team">Haas F1 Team</td>');
    expect(body).toContain('<td class="c-car">27</td>');
    expect(body).toContain('<span class="visually-hidden">, teammate of Given Alpha</span>');
    expect(m).not.toMatch(/<img|<svg/);
  });

  it("explains the colour sources in text", () => {
    expect(m).toContain("not official logos");
    expect(m).toContain("Badge colour from round 4 (this race&#x27;s timing data has none).");
    expect(m).toContain("Badge project palette colour");
  });
});

const row = (id: string, position: number): DriverRow => ({
  driverId: id,
  position,
  gapAheadS: null,
  gapLeaderS: 0,
  lastLapTimeS: 90,
  compound: "SOFT",
  tyreAgeLaps: 3,
  tyreLifeLaps: null,
  tyreLifeAtStartLaps: null,
  tyreLifeLap: null,
  timing: NO_TIMING,
  timingLap: null,
  undercutFlag: false,
  undercutProb: null,
  lap: 3,
  raceTimeS: 270,
  jolpicaPosition: position,
  inPit: false,
  stops: 0,
  lastPitLap: null,
  known: true,
});

describe("timing tower with entrants", () => {
  const m = html(
    createElement(TimingTower, {
      rows: [row("alpha", 1), row("charlie", 2), row("max_verstappen", 3)],
      lapsDown: () => 0,
      entrants: INDEX,
    }),
  );

  it("shows the team badge, the real code and the teammate in the tooltip and in text", () => {
    expect(m).toContain('title="Ferrari · teammate: Given Charlie (CHA)"');
    expect(m).toContain('data-team="ferrari"');
    expect(m).toContain('<span class="code">ALP</span> <span class="name">Alpha</span>');
    expect(m).toContain('<span class="visually-hidden">, teammate of Charlie</span>');
    expect(m).toMatch(/class="team-badge"[^>]*aria-describedby="tip-team"/);
  });

  it("falls back to the guessed code for a driver without an entrant", () => {
    expect(m).toContain('<span class="code">VER</span> <span class="name">Verstappen</span>');
  });
});

describe("layout footer", () => {
  it("carries the unofficial-project note", () => {
    const m = html(createElement(RootLayout, null, null));
    expect(m).toContain('<footer class="site-footer"><p>Unofficial project; not associated with the Formula 1 companies.</p></footer>');
  });
});
