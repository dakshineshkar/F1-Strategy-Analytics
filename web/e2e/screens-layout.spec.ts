import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

import { API, stopReplay } from "./replay";

/**
 * Redesign step 4A: the race picker, the post-race archive and the engineer tab on the design system.
 * At 1440×900 (dark and light) and at 390×844:
 *   - no horizontal page scroll;
 *   - no text box is cut (scrollWidth > clientWidth) in the screen's own parts;
 *   - the key controls are wholly inside the first viewport (the picker's search and "Start here" link; the
 *     archive's lap slider, Play, ±1 lap and event markers; the engineer's focus select and focus card);
 *   - the archive keeps the signal amber off its controls (slider and markers are neutral; F05, F35).
 * The engineer test needs a replay: it starts a 10× replay of 2024 R5 through the API when none runs and stops
 * it in afterAll. Runs against the sample (`make api-up REPLAY=1`) or the full lake (`FULL=1 REPLAY=1`).
 */

const RACE = "/race/2024/5";
const VIEWPORTS = [
  { name: "1440 dark", width: 1440, height: 900, theme: "dark" },
  { name: "1440 light", width: 1440, height: 900, theme: "light" },
  { name: "390 dark", width: 390, height: 844, theme: "dark" },
] as const;

let started = false;

test.afterAll(async ({ request }) => {
  if (started) await stopReplay(request, 2024, 5);
  started = false;
});

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' (or FULL=1 REPLAY=1) first`);
});

async function useTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("f1sa.theme", t);
    } catch {
      /* blocked storage: the page stays dark */
    }
  }, theme);
}

/** Page overflow and the boxes under ``selector`` whose content is wider than the box (visually hidden 1 px
 * labels and inline runs, which wrap, are not boxes on screen). */
async function layout(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const cut = [...document.querySelectorAll(sel)]
      .filter((e) => !e.closest("[hidden]") && e.getBoundingClientRect().width > 1)
      .filter((e) => getComputedStyle(e).display !== "inline" && e.scrollWidth > e.clientWidth)
      // scroll regions, and the marker tracks (positioning boxes: a marker centred on the last lap overhangs its
      // track by design and is checked against the panel instead)
      .filter((e) => !e.matches(".tower-wrap, .arc-feed, .feed, .alerts, .gkey-panel, .ac-track"))
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}: ${(e.textContent ?? "").trim().slice(0, 40)} (${e.scrollWidth} > ${e.clientWidth})`);
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, cut };
  }, selector);
}

async function inFirstViewport(locators: [string, ReturnType<Page["locator"]>][]): Promise<void> {
  for (const [label, l] of locators) await expect(l, `in the first viewport: ${label}`).toBeInViewport({ ratio: 1 });
}

async function ensureReplay(request: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    const body = (await (await request.get(`${API}/api/replays`)).json()) as {
      enabled: boolean;
      running: { season: number; round: number }[];
    };
    test.skip(!body.enabled, "replay is disabled on the API: run 'make api-up REPLAY=1'");
    if (body.running.some((r) => r.season === 2024 && r.round === 5)) return;
    if (body.running.length === 0) {
      const r = await request.post(`${API}/api/races/2024/5/replay`, { data: { speed: 10 } });
      expect(r.status(), await r.text()).toBe(202);
      started = true;
      return;
    }
    if (Date.now() > deadline) throw new Error("another race is still replaying");
    await new Promise((res) => setTimeout(res, 2000));
  }
}

for (const vp of VIEWPORTS) {
  test.describe(`race picker at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Start here and the search in the first viewport; no overflow, nothing cut", async ({ page }) => {
      await useTheme(page, vp.theme);
      await page.goto("/");
      await expect(page.locator("#race-count")).toContainText(/\d+ of \d+ races/);
      const start = page.getByRole("region", { name: "Start here" });
      await expect(start).toContainText(/Chinese Grand Prix|Replaying now|newest race/);
      await inFirstViewport([
        ["Start here", start],
        ["Open the race", start.locator(".start-open")],
        ["Search races", page.getByLabel("Search races")],
      ]);
      const m = await layout(page, ".start-here, .start-here *, .picker-search, .picker-search *, .race-link, .race-link *");
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.cut).toEqual([]);
      // keyboard: the first race in the list is reachable with Home from any race link
      const first = page.locator("#race-list a.race-link").first();
      await page.locator("#race-list a.race-link").nth(1).focus();
      await page.keyboard.press("Home");
      await expect(first).toBeFocused();
    });
  });

  test.describe(`post-race archive at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("transport in the first viewport, no overflow, nothing cut, no amber on the controls", async ({ page, request }) => {
      const listing = (await (await request.get(`${API}/api/archive`)).json()) as { races: { season: number; round: number }[] };
      test.skip(!listing.races.some((r) => r.season === 2024 && r.round === 5), "no post-race bundle for 2024 R5");
      await useTheme(page, vp.theme);
      await page.goto(`${RACE}?mode=archive&lap=30`);
      await expect(page.locator("table.tower tbody tr")).toHaveCount(20, { timeout: 30_000 });
      const strip = page.getByRole("region", { name: "Race status" });
      await expect(strip.locator(".ss-lap")).toHaveText(/^Lap\s*30\/\d+$/);
      await expect(strip.locator(".ss-rc")).toContainText("Track status");
      await inFirstViewport([
        ["mode tabs", page.getByRole("tab", { name: "Post-race (archive)" })],
        ["lap slider", page.getByRole("slider", { name: "Lap" })],
        ["Play", page.getByRole("button", { name: "Play" })],
        ["Previous lap", page.getByRole("button", { name: "Previous lap" })],
        ["Next lap", page.getByRole("button", { name: "Next lap" })],
        ["event markers", page.getByRole("toolbar", { name: "Race events: jump to a lap" })],
      ]);
      const m = await layout(
        page,
        ".race-head-arc, .race-head-arc *, .status-strip, .status-strip *, .archive-controls, .archive-controls *, .arc-panel *, .alert-line, .alert-meta",
      );
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.cut).toEqual([]);
      // every event marker lies wholly inside the transport panel's content box (none overhangs its edge)
      const outside = await page.evaluate(() => {
        const panel = document.querySelector(".archive-controls")!;
        const p = panel.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(panel).paddingLeft);
        return [...document.querySelectorAll(".ac-marker")]
          .map((e) => ({ r: e.getBoundingClientRect(), label: e.getAttribute("aria-label") ?? "" }))
          .filter(({ r }) => r.left < p.left + pad - 0.5 || r.right > p.right - pad + 0.5)
          .map(({ label }) => label);
      });
      expect(outside).toEqual([]);
      // the amber is the call's: the slider's accent and the alert markers are neutral
      const amber = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--signal-mark)";
        document.body.append(probe);
        const signal = getComputedStyle(probe).color;
        probe.style.color = "var(--signal-ink)";
        const ink = getComputedStyle(probe).color;
        probe.remove();
        const slider = getComputedStyle(document.querySelector(".ac-slider")!).accentColor;
        const markers = [...document.querySelectorAll(".ac-marker")].map((e) => getComputedStyle(e).borderTopColor);
        return { slider: [signal, ink].includes(slider), markers: markers.filter((c) => c === signal || c === ink).length };
      });
      expect(amber).toEqual({ slider: false, markers: 0 });
      // keyboard: the skip link leads to the lap controls
      const skip = page.getByRole("link", { name: "Skip to the lap controls" });
      await skip.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#archive-controls$/);
    });
  });
}

for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
  test.describe(`engineer tab at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("focus select and the focus card in the first viewport; no overflow, nothing cut", async ({ page, request }) => {
      await ensureReplay(request);
      await useTheme(page, vp.theme);
      await page.goto(RACE);
      await expect.poll(async () => page.locator("table.tower tbody tr").count(), { timeout: 150_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
      await page.getByRole("tab", { name: "Engineer" }).click();
      const eng = page.getByRole("region", { name: "Engineer view" });
      await expect(eng.locator(".eng-card")).toHaveCount(3, { timeout: 60_000 });
      await inFirstViewport([
        ["focus select", eng.getByLabel("Focus driver (kept in this browser)")],
        ["focus card heading", eng.locator(".eng-card.is-focus h3")],
      ]);
      const m = await layout(page, ".engineer, .engineer *");
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.cut).toEqual([]);
      // the rejoin labels never overlap (F20)
      const overlaps = await page.evaluate(() => {
        const r = [...document.querySelectorAll(".rejoin-mark")].map((e) => e.getBoundingClientRect());
        let n = 0;
        for (let i = 0; i < r.length; i += 1)
          for (let j = i + 1; j < r.length; j += 1) {
            const a = r[i]!;
            const b = r[j]!;
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) n += 1;
          }
        return n;
      });
      expect(overlaps).toBe(0);
      // the sparkline sits beside its sentence at 1440 (F21): same row, top-aligned
      if (vp.width >= 1080 && (await eng.locator(".eng-pair").count()) > 0) {
        const p = await eng.locator(".eng-pair p").first().boundingBox();
        const f = await eng.locator(".eng-pair .eng-spark").first().boundingBox();
        expect(Math.abs(p!.y - f!.y)).toBeLessThanOrEqual(4);
        expect(f!.x).toBeGreaterThan(p!.x + p!.width - 1);
      }
    });
  });
}

/**
 * Redesign step 4B: every race-analysis tab and the drivers view, at 1440 dark, 1440 light and 390 dark:
 *   - no horizontal page scroll; no HTML box cut; every SVG chart label inside its chart (nothing cut off);
 *   - the whole tab bar visible at once (it wraps on a phone, never scrolls a tab out of view);
 *   - the tabs work from the keyboard (arrows, Home, End), and each chart's hover readout opens from the keyboard
 *     and stays inside the page;
 *   - no signal amber on the tab bar or "Show table" (the amber is the live call's).
 * Telemetry renders its own state when the lake has no traces (the layout is checked either way).
 */
const ANALYSIS_TABS = [
  "Tyre strategy",
  "Lap times",
  "Tyre degradation",
  "Positions",
  "Compare",
  "Pit stops",
  "Race control",
  "Telemetry",
] as const;

/** SVG text elements of the analysis charts that reach outside their SVG's box (a cut label). */
async function cutChartText(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".analysis-view svg.chart")].flatMap((svg) => {
      const box = svg.getBoundingClientRect();
      return [...svg.querySelectorAll("text")]
        .map((t) => ({ t, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0)
        .filter(({ r }) => r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)
        .map(({ t, r }) => `"${t.textContent}" ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)}`);
    }),
  );
}

async function amberOn(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const colours = ["--signal", "--signal-mark", "--signal-ink"].map((v) => {
      probe.style.color = `var(${v})`;
      return getComputedStyle(probe).color;
    });
    probe.remove();
    return [...document.querySelectorAll(sel)].filter((e) => {
      const s = getComputedStyle(e);
      return [s.color, s.borderBottomColor, s.backgroundColor].some((c) => colours.includes(c));
    }).length;
  }, selector);
}

for (const vp of VIEWPORTS) {
  test.describe(`race analysis at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("every tab: no overflow, nothing cut, the tab bar whole and neutral", async ({ page }) => {
      test.setTimeout(120_000);
      await useTheme(page, vp.theme);
      await page.goto(`${RACE}/analysis`);
      const tablist = page.getByRole("tablist", { name: "Race analysis views" });
      await expect(tablist.getByRole("tab")).toHaveCount(ANALYSIS_TABS.length, { timeout: 30_000 });
      for (const name of ANALYSIS_TABS) await expect(tablist.getByRole("tab", { name }), `tab visible: ${name}`).toBeInViewport({ ratio: 1 });
      for (const name of ANALYSIS_TABS) {
        await tablist.getByRole("tab", { name }).click();
        const panel = page.getByRole("tabpanel");
        await expect(panel.locator("section.analysis-view")).toBeVisible();
        await expect(panel).not.toContainText(/Loading the (comparison|telemetry)/, { timeout: 30_000 });
        // HTML boxes only: SVG text has no meaningful scrollWidth and is checked against its chart below
        const m = await layout(
          page,
          ".race-head-sub, .race-head-sub *, .analysis-tabs, .analysis-tabs *, .analysis-panel, .analysis-panel *:not(svg, svg *), .analysis-notes *, .legend",
        );
        expect(m.overflow, `${name}: page overflow`).toBeLessThanOrEqual(0);
        expect(m.cut, `${name}: cut boxes`).toEqual([]);
        expect(await cutChartText(page), `${name}: cut chart labels`).toEqual([]);
      }
      expect(await amberOn(page, ".analysis-tabs [role=tab], .chart-table summary")).toBe(0);
    });

    test("tabs by keyboard (arrows, Home, End) and the hover readout from the keyboard", async ({ page }) => {
      await useTheme(page, vp.theme);
      await page.goto(`${RACE}/analysis?view=strategy`);
      const tab = (name: string) => page.getByRole("tab", { name, exact: true });
      await tab("Tyre strategy").focus();
      await page.keyboard.press("ArrowRight");
      await expect(tab("Lap times")).toHaveAttribute("aria-selected", "true");
      await expect(tab("Lap times")).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(tab("Tyre strategy")).toBeFocused();
      await page.keyboard.press("End");
      await expect(tab("Telemetry")).toHaveAttribute("aria-selected", "true");
      await expect(tab("Telemetry")).toBeFocused();
      await page.keyboard.press("Home");
      await expect(tab("Tyre strategy")).toHaveAttribute("aria-selected", "true");
      await expect(tab("Tyre strategy")).toBeFocused();
      // the lap-times readout: focus the chart's slider, step a lap, read every chosen driver
      await tab("Lap times").click();
      const slider = page.getByRole("slider", { name: "Lap times: read a lap" });
      await slider.focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowRight");
      await expect(slider).toHaveAttribute("aria-valuetext", /^Lap 2, /);
      const tip = page.locator(".chart-tip");
      await expect(tip).toBeVisible();
      const r = await tip.boundingBox();
      expect(r!.x).toBeGreaterThanOrEqual(0);
      expect(r!.x + r!.width).toBeLessThanOrEqual(vp.width);
      await page.keyboard.press("Tab");
      await expect(tip).toHaveCount(0);
    });
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`drivers view at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the table fits: no overflow, nothing cut, the head in the live order", async ({ page }) => {
      await useTheme(page, vp.theme);
      await page.goto(`${RACE}/drivers`);
      const drivers = page.getByRole("table", { name: /Drivers/ });
      await expect(drivers.locator("tbody tr")).toHaveCount(20, { timeout: 30_000 });
      const views = page.getByRole("navigation", { name: "Race views" });
      await expect(views.getByRole("link", { name: "Drivers" })).toHaveAttribute("aria-current", "page");
      await expect(views.getByRole("link", { name: "Live race" })).toHaveAttribute("href", RACE);
      const m = await layout(page, ".race-head-sub, .race-head-sub *, .drivers-panel, .drivers-panel *");
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.cut).toEqual([]);
      // the table needs no sideways scroll inside its region either
      const wide = await page.evaluate(() => {
        const w = document.querySelector(".drivers-wrap")!;
        return w.scrollWidth - w.clientWidth;
      });
      expect(wide).toBeLessThanOrEqual(0);
      // no cell paints over the next one (each row's cells are side by side, none overlapping)
      const overlaps = await page.evaluate(() =>
        [...document.querySelectorAll(".drivers-table tr")].flatMap((tr) => {
          const cells = [...tr.children].map((c) => c.getBoundingClientRect());
          return cells.slice(1).filter((c, i) => c.left < (cells[i] as DOMRect).right - 1).map(() => tr.getAttribute("data-driver") ?? "head");
        }),
      );
      expect(overlaps).toEqual([]);
    });
  });
}
