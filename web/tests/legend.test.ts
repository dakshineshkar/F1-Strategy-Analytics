import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AlertFeed } from "@/components/AlertFeed";
import { InfoTip } from "@/components/InfoTip";
import { Legend } from "@/components/Legend";
import { TimingTower } from "@/components/TimingTower";
import { TyrePanel } from "@/components/TyrePanel";
import { WhatIfPanel } from "@/components/WhatIfPanel";
import { dismissesTip, GLOSSARY, glossary, THRESHOLD_PCT, tipId } from "@/lib/legend";
import type { AlertGroup, DriverRow } from "@/lib/reducer";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** React escapes text: compare against the escaped form of a glossary sentence. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const row = (id: string, more: Partial<DriverRow> = {}): DriverRow => ({
  driverId: id,
  position: 1,
  gapAheadS: null,
  gapLeaderS: 0,
  lastLapTimeS: 90,
  compound: "SOFT",
  tyreAgeLaps: 13,
  tyreLifeLaps: null,
  tyreLifeAtStartLaps: null,
  tyreLifeLap: null,
  undercutFlag: false,
  undercutProb: null,
  lap: 30,
  raceTimeS: 2700,
  jolpicaPosition: 1,
  inPit: false,
  stops: 0,
  lastPitLap: null,
  known: true,
  ...more,
});

const ROWS = [
  row("max_verstappen", { tyreLifeLaps: 16, tyreLifeAtStartLaps: 3 }),
  row("perez", { position: 2, gapAheadS: 1.2, gapLeaderS: 1.2, undercutFlag: true, undercutProb: 0.62 }),
  row("sargeant", { position: 3, inPit: true }),
];

const GROUPS: AlertGroup[] = [
  {
    key: "perez>max_verstappen",
    attackerId: "perez",
    defenderId: "max_verstappen",
    reason: "attempt",
    trigger: "pit_in",
    prob: 0.62,
    threshold: 0.5,
    decisionLap: 29,
    gapS: 1.2,
    count: 2,
    seq: 1,
  },
];

function ids(markup: string): string[] {
  return [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
}
function describedBy(markup: string): string[] {
  return [...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
}
function tipButtons(markup: string): { label: string; describedby: string; expanded: string }[] {
  return [...markup.matchAll(/<button type="button" class="info-tip-btn" aria-label="([^"]+)" aria-describedby="([^"]+)" aria-expanded="([^"]+)"/g)].map(
    (m) => ({ label: m[1]!, describedby: m[2]!, expanded: m[3]! }),
  );
}

describe("glossary", () => {
  it("has unique ids and a non-empty text for every marker the dashboard shows", () => {
    const all = GLOSSARY.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(
      expect.arrayContaining(["flag", "undercut", "age", "int", "gap", "lapsDown", "opportunity", "attempt", "alertProb", "whatif"]),
    );
    for (const e of GLOSSARY) expect(e.text.length).toBeGreaterThan(20);
    expect(glossary("undercut").text).toMatch(/calibrated model probability/i);
    expect(glossary("undercut").text).toContain("—");
    expect(glossary("age").text).toMatch(/used/);
    expect(glossary("age").text).toMatch(/est\./);
    expect(glossary("opportunity").text).toContain(`${THRESHOLD_PCT}%`);
    expect(glossary("whatif").text).toMatch(/simulator/);
    expect(glossary("whatif").text).toMatch(/calibrated outcome estimate/);
    expect(() => glossary("nope" as never)).toThrow();
  });

  it("tip ids are scoped and only Escape dismisses", () => {
    expect(tipId("age")).toBe("tip-age");
    expect(tipId("age", "panel")).toBe("tip-age-panel");
    expect(["Escape", "Esc"].map(dismissesTip)).toEqual([true, true]);
    expect(["Enter", " ", "Tab", "a"].map(dismissesTip)).toEqual([false, false, false, false]);
  });
});

describe("InfoTip", () => {
  it("is a focusable button named 'About …', described by an always-present tooltip", () => {
    const m = html(createElement(InfoTip, { id: "undercut" }));
    expect(tipButtons(m)).toEqual([{ label: "About Undercut", describedby: "tip-undercut", expanded: "false" }]);
    expect(m).toContain(`<span role="tooltip" id="tip-undercut" class="info-tip-text">${esc(glossary("undercut").text)}</span>`);
    expect(m).toContain('<span aria-hidden="true">?</span>'); // the glyph is decorative
    expect(m).not.toContain("data-open"); // closed until hovered, focused or clicked
    expect(html(createElement(InfoTip, { id: "age", scope: "panel", align: "end" }))).toContain('id="tip-age-panel"');
  });
});

describe("Legend: How to read this", () => {
  it("is a native, collapsed <details> with every glossary entry, grouped", () => {
    const m = html(createElement(Legend));
    expect(m.startsWith('<details class="legend panel"><summary>How to read this</summary>')).toBe(true);
    expect(m).not.toContain("<details open");
    for (const e of GLOSSARY) {
      expect(m).toContain(`${esc(e.term)}</dt><dd>${esc(e.text)}</dd>`);
    }
    for (const g of ["Timing tower", "Undercut alerts", "What-if"]) expect(m).toContain(`aria-label="${g}"><h3>${g}</h3>`);
    // the yellow bar is shown next to its text, never alone
    expect(m).toContain('<dt><span class="legend-bar" aria-hidden="true"></span>▲ and yellow left bar</dt>');
    expect(ids(m)).toEqual([]); // no ids: the tooltips own them, so nothing is duplicated
  });
});

describe("timing tower", () => {
  const m = html(createElement(TimingTower, { rows: ROWS, lapsDown: (id: string) => (id === "sargeant" ? 1 : 0) }));

  it("has a tooltip on the Pos, Driver, Int, Gap, Age and Undercut headers", () => {
    expect(tipButtons(m).map((b) => b.label)).toEqual([
      "About the undercut flag",
      "About the driver tags",
      "About Int",
      "About Gap",
      "About Age",
      "About Undercut",
    ]);
    const thead = m.slice(m.indexOf("<thead>"), m.indexOf("</thead>"));
    for (const id of ["flag", "lapsDown", "int", "gap", "age", "undercut"] as const) {
      expect(thead).toContain(`role="tooltip" id="${tipId(id)}"`);
    }
  });

  it("row markers point to the header tooltips and say what they are in text", () => {
    const body = m.slice(m.indexOf("<tbody>"));
    expect(body).toContain(`<span class="flag" title="${esc(glossary("flag").text)}" aria-describedby="tip-flag">`);
    expect(body).toContain('<span class="visually-hidden">Undercut opportunity on the car ahead, </span>');
    expect(body).toContain('62%<span class="visually-hidden"> undercut success probability</span>');
    expect(body).toContain('<span class="visually-hidden">not a candidate</span>');
    expect(body).toMatch(/class="tyre-age tyre-age-real"[^>]*aria-describedby="tip-age"/);
    expect(body).toMatch(/class="tyre-age tyre-age-estimated"[^>]*aria-describedby="tip-age"/);
    expect(body).toContain('aria-describedby="tip-lapsDown">+1 L');
    expect(body).toContain('aria-describedby="tip-lapsDown">IN PIT');
  });

  it("every aria-describedby resolves to an element of the tower", () => {
    const own = new Set(ids(m));
    for (const ref of describedBy(m)) expect(own.has(ref), ref).toBe(true);
  });
});

describe("alerts and what-if", () => {
  it("the alert panel keys Opportunity, Attempt and the percentage in text and tooltips", () => {
    const m = html(createElement(AlertFeed, { groups: GROUPS, announcement: null }));
    expect(m).toContain(`Opportunity</span> new candidate or ≥ ${THRESHOLD_PCT}%`);
    expect(m).toContain("Attempt</span> attacker pitted");
    expect(m).toContain("% = success probability");
    expect(tipButtons(m).map((b) => b.label)).toEqual(["About Opportunity", "About Attempt", "About the alert percentage"]);
    expect(m).toContain('<span class="badge badge-attempt" aria-describedby="tip-attempt">Attempt</span>');
    expect(m).toContain('aria-describedby="tip-alertProb">62%<span class="visually-hidden"> success probability</span>');
    const own = new Set(ids(m));
    for (const ref of describedBy(m)) expect(own.has(ref), ref).toBe(true);
  });

  it("the what-if panel explains its rows in one line", () => {
    const m = html(createElement(WhatIfPanel, { season: 2024, round: 5, order: [] }));
    expect(m).toContain(`<p id="whatif-note" class="panel-note">${esc(glossary("whatif").text)}</p>`);
  });

  it("the whole dashboard's tooltip ids are unique (tower, tyre panel, alerts, what-if)", () => {
    const all = [
      html(createElement(TimingTower, { rows: ROWS, lapsDown: () => 0 })),
      html(createElement(TyrePanel, { rows: ROWS })),
      html(createElement(AlertFeed, { groups: GROUPS, announcement: null })),
      html(createElement(WhatIfPanel, { season: 2024, round: 5, order: [] })),
      html(createElement(Legend)),
    ].join("");
    const list = ids(all).filter((i) => i.startsWith("tip-") || i === "whatif-note");
    expect(new Set(list).size).toBe(list.length);
    const own = new Set(ids(all));
    for (const ref of describedBy(all)) expect(own.has(ref), ref).toBe(true);
    // the tyre panel carries its own Age tip and its rows point to it
    expect(all).toMatch(/class="tyre-age tyre-age-real"[^>]*aria-describedby="tip-age-panel"/);
    // no two tooltip buttons share an accessible name
    const names = tipButtons(all).map((b) => b.label);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("About tyre age");
  });
});
