import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

import { API, stopReplay } from "./replay";

/**
 * Step 5 (final audit, 2026-11-19), against the real API in either lake mode with replay enabled:
 *   - the timing tower's Driver column is present at 1440, 1280, 1024, 768 and 390 px, in the live race and in the
 *     post-race archive: its head and every row's cell are wider than 0 and hold the car's code (it collapsed to
 *     0 px at 768 and 1100–1366 px: finding 1). No horizontal page scroll. At 1280×800 the tower, the call and the
 *     alert feed are in the first viewport;
 *   - axe (WCAG 2.0/2.1/2.2 A and AA, plus best practices) on every screen in both themes reports no serious or
 *     critical violation: the race picker, the live race and its engineer tab, the post-race archive, the 8 race
 *     analysis tabs and the drivers view.
 * It starts a 10× replay of 2024 R5 when none runs and stops it at the end, so a later `make api-up` or
 * `make web-up` is not refused by the replay guard.
 */

const RACE = "/race/2024/5";
const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;
const THEMES = ["dark", "light"] as const;
const ANALYSIS_TABS = ["Tyre strategy", "Lap times", "Tyre degradation", "Positions", "Compare", "Pit stops", "Race control", "Telemetry"];

let started = false;

test.afterAll(async ({ request }) => {
  if (started) await stopReplay(request, 2024, 5);
  started = false;
});

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' (or FULL=1 REPLAY=1) first`);
});

async function ensureReplay(request: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    const body = (await (await request.get(`${API}/api/replays`)).json()) as { enabled: boolean; running: { season: number; round: number }[] };
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

async function hasArchive(request: APIRequestContext): Promise<boolean> {
  const listing = (await (await request.get(`${API}/api/archive`)).json()) as { races: { season: number; round: number }[] };
  return listing.races.some((r) => r.season === 2024 && r.round === 5);
}

async function useTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("f1sa.theme", t);
    } catch {
      /* blocked storage: the page stays dark */
    }
  }, theme);
}

/** The Driver column: the head cell's width, and every body row's cell width and text. */
async function driverColumn(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector("table.tower thead th.c-drv");
    const cells = [...document.querySelectorAll("table.tower tbody tr td.c-drv, table.tower tbody tr th.c-drv")];
    return {
      headWidth: head === null ? 0 : Math.round(head.getBoundingClientRect().width),
      rows: cells.length,
      narrow: cells.filter((c) => c.getBoundingClientRect().width < 1).length,
      empty: cells.filter((c) => !/[A-Z]{3}/.test(c.textContent ?? "")).length,
      // the code is drawn inside the cell, not clipped away (its box lies inside the cell's box)
      hidden: cells.filter((c) => {
        const code = c.querySelector(".code");
        if (code === null) return true;
        const a = code.getBoundingClientRect();
        const b = c.getBoundingClientRect();
        return a.width < 1 || a.left < b.left - 0.5 || a.right > b.right + 0.5;
      }).length,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const vp of WIDTHS) {
  test.describe(`the tower's Driver column at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("live race: present, non-zero, the car's code in every row; no page scroll", async ({ page, request }) => {
      await ensureReplay(request);
      await page.goto(RACE);
      await expect.poll(async () => page.locator("table.tower tbody tr").count(), { timeout: 150_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
      const d = await driverColumn(page);
      expect(d.headWidth, "Driver head width").toBeGreaterThanOrEqual(80);
      expect(d.rows).toBeGreaterThanOrEqual(20);
      expect(d.narrow, "Driver cells of 0 px").toBe(0);
      expect(d.empty, "Driver cells without a code").toBe(0);
      expect(d.hidden, "Driver codes cut off").toBe(0);
      expect(d.pageOverflow).toBeLessThanOrEqual(0);
      if (vp.name === "1280") {
        // the first-viewport rule at 1280×800: the call, the alert feed and the tower to its last row. Checked on the
        // boxes, not with toBeInViewport: below 1440 px the row is wider than the tower's own scroll box (its right-hand
        // columns scroll inside it), which an intersection ratio would count as "cut".
        for (const [label, sel] of [
          ["the call", "#the-call"],
          ["alert feed", ".alert-panel"],
          ["last tower row", "table.tower tbody tr:last-child"],
        ] as const) {
          const box = await page.locator(sel).first().boundingBox();
          expect(box, label).not.toBeNull();
          expect(box!.y, `${label}: top in the first viewport`).toBeGreaterThanOrEqual(0);
          expect(box!.y + box!.height, `${label}: bottom in the first viewport`).toBeLessThanOrEqual(vp.height);
        }
        // and the tower's own box, with its right edge inside the page
        const wrap = await page.locator(".tower-wrap").boundingBox();
        expect(wrap!.x + wrap!.width).toBeLessThanOrEqual(vp.width);
      }
    });

    test("post-race archive: present, non-zero, the car's code in every row; no page scroll", async ({ page, request }) => {
      test.skip(!(await hasArchive(request)), "no post-race bundle for 2024 R5");
      await page.goto(`${RACE}?mode=archive&lap=30`);
      await expect(page.locator("table.tower tbody tr")).toHaveCount(20, { timeout: 30_000 });
      const d = await driverColumn(page);
      expect(d.headWidth, "Driver head width").toBeGreaterThanOrEqual(80);
      expect(d.narrow, "Driver cells of 0 px").toBe(0);
      expect(d.empty, "Driver cells without a code").toBe(0);
      expect(d.hidden, "Driver codes cut off").toBe(0);
      expect(d.pageOverflow).toBeLessThanOrEqual(0);
    });
  });
}

/** axe's serious and critical violations of the page as it is now, in a readable form. */
async function serious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join("; ")})`);
}

for (const theme of THEMES) {
  test.describe(`axe, ${theme} theme, 1440×900`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("race picker, drivers view and every race analysis tab: no serious or critical violation", async ({ page }) => {
      await useTheme(page, theme);
      const found: string[] = [];
      await page.goto("/");
      await expect(page.locator(".start-here")).toBeVisible({ timeout: 30_000 });
      found.push(...(await serious(page)).map((v) => `picker: ${v}`));
      await page.goto(`${RACE}/drivers`);
      await expect(page.locator("table.drivers-table tbody tr").first()).toBeVisible({ timeout: 30_000 });
      found.push(...(await serious(page)).map((v) => `drivers: ${v}`));
      await page.goto(`${RACE}/analysis`);
      await expect(page.getByRole("tab", { name: "Tyre strategy" })).toBeVisible({ timeout: 30_000 });
      for (const tab of ANALYSIS_TABS) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await expect(page.locator(".analysis-view").first()).toBeVisible({ timeout: 30_000 });
        found.push(...(await serious(page)).map((v) => `analysis ${tab}: ${v}`));
      }
      expect(found).toEqual([]);
    });

    test("live race, engineer tab and post-race archive: no serious or critical violation", async ({ page, request }) => {
      await ensureReplay(request);
      await useTheme(page, theme);
      const found: string[] = [];
      await page.goto(RACE);
      await expect.poll(async () => page.locator("table.tower tbody tr").count(), { timeout: 150_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
      found.push(...(await serious(page)).map((v) => `live race: ${v}`));
      await page.getByRole("tab", { name: "Engineer" }).click();
      await expect(page.getByRole("region", { name: "Engineer view" }).locator(".eng-card")).toHaveCount(3, { timeout: 60_000 });
      found.push(...(await serious(page)).map((v) => `engineer: ${v}`));
      if (await hasArchive(request)) {
        await page.goto(`${RACE}?mode=archive&lap=30`);
        await expect(page.locator("table.tower tbody tr")).toHaveCount(20, { timeout: 30_000 });
        found.push(...(await serious(page)).map((v) => `archive: ${v}`));
      }
      expect(found).toEqual([]);
    });
  });
}
