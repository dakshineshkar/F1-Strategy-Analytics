import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

/**
 * The live race view's layout contract (redesign Step 2, docs/design/DESIGN.md), against the real API in
 * either lake mode with replay enabled. It starts a 10× replay of 2024 R5 when none is running (a start
 * clears that race's race:2024:5:* keys, Feature 7) and checks, at 1440×900:
 *   - no horizontal page scroll, and the tower scrolls neither (every column fits; critique F01);
 *   - all 20 tower rows, the call and the alert feed sit inside the first viewport, in both themes (F02);
 *   - during the replay no panel or region moves: the status strip, the call, the feed, the what-if and the
 *     tower keep their boxes, and no layout-shift entry names one of them (reserved sizes; PRODUCT.md
 *     principle 4). What remains are sub-pixel reflows inside a line when a value changes width (a tyre
 *     age going from 9 to 10 laps); their CLS outside the tower's rows must stay under 0.01, a tenth of
 *     the browser's "good" limit (0.1), and the measured value is reported as an annotation.
 *   - one loud element: at most 2 tower rows carry the signal band, and they are the call's attacker and defender
 *     (2026-11-19 polish round);
 *   - no tower cell and no alert line is cut off: nothing has scrollWidth > clientWidth (no ellipsis on data).
 * The first-viewport, clipping and layout-shift checks run in both themes.
 * And at 390×844 (2026-11-19 screenshot review): no horizontal page scroll; the race head and the status strip wrap,
 * so every header and strip control is wholly inside the viewport and none is cut (no "GREE"); the call comes before
 * the tower and starts within 200 px.
 * At both widths the call's pit loss is the race's, as the engineer API states it (the same value on a phone and a
 * desktop, also right after a late join), and at 1440 px the what-if has no empty gap under its status line.
 * The layout-shift check runs with motion on, because tower reorders are FLIP moves (transform only);
 * under prefers-reduced-motion a reorder is an instant move, which the browser records as a shift of the
 * moved rows only.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const RACE = "/race/2024/5";
/** True once this spec started a replay: it stops it at the end, so the other specs find the API idle. */
let started = false;

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

async function lap(page: Page): Promise<number> {
  return Number((await page.locator(".lc-now").first().textContent()) ?? "0") || 0;
}

async function waitForRows(page: Page): Promise<void> {
  await expect.poll(async () => page.locator("table.tower tbody tr").count(), { timeout: 150_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
  await expect.poll(async () => lap(page), { timeout: 120_000, intervals: [1000] }).toBeGreaterThanOrEqual(2);
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const b = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    const wrap = document.querySelector(".tower-wrap");
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      towerOverflow: wrap === null ? null : wrap.scrollWidth - wrap.clientWidth,
      lastRow: b("table.tower tbody tr:last-child"),
      tower: b(".tower-wrap"),
      undercut: b("table.tower thead .c-uc"),
      // cells and feed lines whose content is wider than their box (cut off or ellipsed)
      clipped: [...document.querySelectorAll("table.tower td, table.tower th, .alert-line, .alert-meta")]
        .filter((e) => e.scrollWidth > e.clientWidth)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}: ${(e.textContent ?? "").trim().slice(0, 40)} (${e.scrollWidth} > ${e.clientWidth})`),
      // the call's fixed-height blocks and the alert rows never cut their last line
      clippedV: [...document.querySelectorAll(".call-pair, .call-estimate, .gauge, .call-reasons, .alert")]
        .filter((e) => e.scrollHeight > e.clientHeight + 1)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}: ${e.scrollHeight} > ${e.clientHeight}`),
      banded: [...document.querySelectorAll("table.tower tbody tr.is-call")].map((r) => ({
        driver: (r as HTMLElement).dataset.driver ?? "",
        role: r.classList.contains("is-call-attacker") ? "attacker" : r.classList.contains("is-call-defender") ? "defender" : "none",
      })),
      call: b("#the-call"),
      feed: b(".alert-panel"),
      strip: b(".status-strip"),
      whatif: b("#whatif"),
    };
  });
}

/** The call's gauge states the race's pit loss as the engineer API gives it (per race, so any car's response).
 * Skipped when the call shows no gauge (no pair with a gap) or the lake has no pit-loss prior. */
async function expectRacePitLoss(page: Page, request: APIRequestContext): Promise<void> {
  const id = await page.locator("table.tower tbody tr[data-driver]").first().getAttribute("data-driver");
  expect(id, "a tower row").not.toBeNull();
  const res = await request.get(`${API}/api/races/2024/5/engineer/${encodeURIComponent(id ?? "")}`);
  if (!res.ok()) return;
  const loss = ((await res.json()) as { rejoin?: { pit_loss_s?: number | null } }).rejoin?.pit_loss_s ?? null;
  if (loss === null || (await page.locator("#the-call .gauge-src").count()) === 0) return;
  await expect(page.locator("#the-call .gauge-src")).toContainText(`pit loss ${loss.toFixed(1)} s`);
}

test.afterAll(async ({ request }) => {
  if (started) await request.post(`${API}/api/races/2024/5/replay/stop`).catch(() => null);
});

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' (or FULL=1 REPLAY=1) first`);
});

test.describe("live race view at 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });

  test("tower, call and alerts in the first viewport, no horizontal scroll, both themes", async ({ page, request }) => {
    await ensureReplay(request);
    await page.goto(RACE);
    await waitForRows(page);
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const m = await boxes(page);
      expect(m.pageOverflow, `${theme}: page scrolls sideways`).toBeLessThanOrEqual(0);
      expect(m.towerOverflow, `${theme}: the tower scrolls sideways`).toBeLessThanOrEqual(0);
      for (const [name, box] of [
        ["last tower row", m.lastRow],
        ["tower", m.tower],
        ["the call", m.call],
        ["alert feed", m.feed],
        ["Undercut column", m.undercut],
      ] as const) {
        expect(box, name).not.toBeNull();
        expect(box!.top, `${theme}: ${name} top`).toBeGreaterThanOrEqual(0);
        expect(box!.bottom, `${theme}: ${name} bottom`).toBeLessThanOrEqual(m.vh);
        expect(box!.right, `${theme}: ${name} right`).toBeLessThanOrEqual(m.vw);
      }
      await expect(page.locator("table.tower tbody tr")).toHaveCount(20);
      expect(m.clipped, `${theme}: cut-off cells or alert lines`).toEqual([]);
      expect(m.clippedV, `${theme}: cut-off blocks in the call or the feed`).toEqual([]);
      // one loud element: only the call's pair is on the band, one attacker and one defender at most
      expect(m.banded.length, `${theme}: banded rows ${JSON.stringify(m.banded)}`).toBeLessThanOrEqual(2);
      expect(m.banded.filter((r) => r.role === "none")).toEqual([]);
      expect(new Set(m.banded.map((r) => r.role)).size).toBe(m.banded.length);
    }
    await expectRacePitLoss(page, request);
    // the what-if's height follows its content: no reserved gap under the one-line status
    const gap = await page.evaluate(() => {
      const a = document.querySelector(".whatif-status");
      const b = document.querySelector(".wi-summary");
      return a && b ? b.getBoundingClientRect().top - a.getBoundingClientRect().bottom : null;
    });
    expect(gap, "what-if: gap between the status line and the summary").not.toBeNull();
    expect(gap!).toBeLessThanOrEqual(12);
    // the theme switch is a named radio group, and the choice survives a reload (kept per browser)
    await page.getByRole("radio", { name: "Dark" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("radio", { name: "Light" }).check();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("radio", { name: "Dark" }).check();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`no layout shift outside the tower's rows during the replay; panels keep their boxes (${theme})`, async ({ page, request }) => {
      await ensureReplay(request);
      await page.addInitScript((t) => {
        try {
          localStorage.setItem("f1sa.theme", t);
        } catch {
          // blocked storage: the page stays dark
        }
      }, theme);
      await page.addInitScript(() => {
        const w = window as unknown as { __shifts: { value: number; sources: string[] }[] };
        w.__shifts = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] }[]) {
            if (e.hadRecentInput) continue;
            const sources = (e.sources ?? []).map((s) => {
              const n = s.node instanceof Element ? s.node : (s.node?.parentElement ?? null);
              if (n === null) return "removed node";
              if (n.closest("table.tower tbody")) return "tower-row";
              const where = n.parentElement?.closest("[class]");
              return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}.${[...n.classList].join(".")} in .${where ? [...where.classList].join(".") : "?"}`;
            });
            w.__shifts.push({ value: e.value, sources });
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(RACE);
      await waitForRows(page);
      await page.waitForTimeout(1500); // fonts and the first snapshots settle before the measured window
      await page.evaluate(() => ((window as unknown as { __shifts: unknown[] }).__shifts = []));
      const before = await boxes(page);
      const startLap = await lap(page);
      await page.waitForTimeout(20_000);
      const after = await boxes(page);
      expect(await lap(page), "the replay advanced during the window").toBeGreaterThan(startLap);
      const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; sources: string[] }[] }).__shifts);
      // a source the browser reports as already detached cannot be attributed; it is counted, not failed
      const outside = shifts.filter((s) => s.sources.some((x) => x !== "tower-row" && x !== "removed node"));
      const cls = shifts.reduce((a, s) => a + s.value, 0);
      test.info().annotations.push({
        type: "layout shift",
        description: `CLS ${cls.toFixed(4)} over 20 s; ${shifts.length} entries; ${outside.length} outside the tower rows (CLS ${outside.reduce((a, s) => a + s.value, 0).toFixed(4)})`,
      });
      console.log(`[layout shift] CLS ${cls.toFixed(4)}, outside tower rows ${outside.reduce((a, s) => a + s.value, 0).toFixed(4)} (${outside.length} entries)`);
      const regions = /^(section|div)[.#](status-strip|the-call|alert-panel|whatif|tower-wrap|feed|dash)/;
      const regionShifts = shifts.filter((s) => s.sources.some((x) => regions.test(x)));
      expect(regionShifts, JSON.stringify(regionShifts.slice(0, 5))).toEqual([]);
      const outsideCls = outside.reduce((a, s) => a + s.value, 0);
      expect(outsideCls, JSON.stringify(outside.slice(0, 5))).toBeLessThan(0.01);
      for (const k of ["strip", "call", "feed", "whatif", "tower"] as const) expect(after[k], k).toEqual(before[k]);
      // at most two banded rows at the end of the window too
      expect(after.banded.length).toBeLessThanOrEqual(2);
    });
  }
});

test.describe("live race view at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no horizontal page scroll; the call comes right after the status strip, before the tower", async ({ page, request }) => {
    await ensureReplay(request);
    await page.goto(RACE);
    await waitForRows(page);
    const m = await boxes(page);
    expect(m.pageOverflow).toBeLessThanOrEqual(0);
    expect(m.strip!.bottom).toBeLessThanOrEqual(m.call!.top);
    expect(m.call!.top).toBeLessThan(m.vh);
    // 200 px for the real view; the sample deployment's honesty stamps (SMOKE TEST in the strip, the wrapped
    // SYNTHETIC DEMO DATA notice) add a line each, so it gets 240 px (user decision 2026-11-19)
    const stamped = (await page.locator(".status-strip .stamp-smoke, .data-banner.is-synthetic").count()) > 0;
    expect(m.call!.top, `the call starts within ${stamped ? 240 : 200} px (the head and the strip wrap)`).toBeLessThanOrEqual(stamped ? 240 : 200);
    // every header and strip control is wholly on screen: nothing is cut at the right edge or scrolled away
    const controls = page.locator(
      ".race-head-live a, .race-head-live [role=tab], .race-head-live h1, .status-strip .ss-mode, .status-strip .ss-cell, .status-strip .stamp, .status-strip button:visible",
    );
    const n = await controls.count();
    expect(n, "header and strip controls").toBeGreaterThanOrEqual(12);
    for (let i = 0; i < n; i += 1) {
      const c = controls.nth(i);
      const label = ((await c.textContent()) ?? "").trim().slice(0, 30);
      await expect(c, `in the viewport: ${label}`).toBeInViewport({ ratio: 1 });
      const b = await c.boundingBox();
      expect(b, label).not.toBeNull();
      expect(b!.x, `${label}: left edge`).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width, `${label}: right edge`).toBeLessThanOrEqual(m.vw);
    }
    for (const name of ["Live", "Post-race (archive)", "Race", "Engineer"]) {
      await expect(page.getByRole("tab", { name, exact: true }), `${name} tab`).toBeInViewport({ ratio: 1 });
    }
    // no box in the head or the strip is wider than its content allows (a cut "GREE"); visually hidden full labels
    // (1 px, read by screen readers) are not boxes on screen
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll(".data-banner, .data-banner *, .race-head-live, .race-head-live *, .status-strip, .status-strip *")]
        .filter((e) => !e.closest("[hidden], .replay-drawer-panel") && e.getBoundingClientRect().width > 1)
        .filter((e) => getComputedStyle(e).display !== "inline" && e.scrollWidth > e.clientWidth)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}: ${(e.textContent ?? "").trim().slice(0, 30)} (${e.scrollWidth} > ${e.clientWidth})`),
    );
    expect(cut, "cut or scrolling boxes in the data notice, the head or the strip").toEqual([]);
    await expectRacePitLoss(page, request);
    expect(m.call!.bottom).toBeLessThanOrEqual(m.feed!.top);
    expect(m.feed!.bottom).toBeLessThanOrEqual(m.tower!.top);
    // keyboard: the skip link leads to the call
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to the undercut call" });
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#the-call$/);
  });
});
