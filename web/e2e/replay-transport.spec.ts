import { expect, type Page, test } from "@playwright/test";

import { API } from "./replay";
import { callCover, seriousViolations, STATES, type StubState, stripMetrics, stubReplays } from "./transport";

/**
 * The status strip's inline replay transport (it replaced the replay popover, which covered the call), checked
 * deterministically: GET /api/replays is stubbed to each phase and every replay action is answered locally, so the
 * spec never starts, stops or changes a real replay (it runs against the real API for everything else, in either
 * lake mode, whatever replay is running).
 *   - at 1440, 1280, 1024, 768 and 390 px, in every state (idle, running, paused, Stop armed, stopped, finished,
 *     another race replaying): the strip has the same height; no horizontal page scroll; nothing in the strip is
 *     cut or outside the viewport; the call is never covered by a replay control; targets are at least 24 px
 *     (44 px on a phone); one line at 1280 px and wider, the transport on the strip's second line below that, and
 *     its own full-width line on a phone;
 *   - the Engineer tab shares the strip: the same phases and height at 1440 and 390 px, and its controls work;
 *   - finished: the call says "Race ended at lap N" with no button; "Open the post-race archive" is offered once,
 *     in the strip, next to Replay again;
 *   - Stop takes two presses (Escape and the timeout cancel); a replay that finishes on its own while Stop is armed
 *     disarms it and no stop is sent;
 *   - keyboard: the transport comes after the strip's cells, with a visible focus ring; axe reports no serious or
 *     critical violation in any state, in both themes.
 */

const RACE = "/race/2024/5";
const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;
const ORDER: readonly (StubState | "armed")[] = ["idle", "running", "paused", "armed", "stopped", "finished", "blocked"];

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' (or FULL=1 REPLAY=1) first`);
});

const PHASE: Record<StubState | "armed", string> = {
  idle: "idle",
  running: "active",
  paused: "active",
  armed: "active",
  stopped: "over",
  finished: "over",
  blocked: "blocked",
};

/** Open the race page (or a tab of it) in ``state`` (stubbed), with Stop armed for "armed". */
async function open(page: Page, state: StubState | "armed", tab: "Race" | "Engineer" = "Race"): Promise<string[]> {
  const body = STATES[state === "armed" ? "running" : state];
  const actions = await stubReplays(page, () => body);
  await page.goto(RACE);
  await expect(page.locator(`.transport.phase-${PHASE[state]}`)).toBeVisible({ timeout: 30_000 });
  if (tab === "Engineer") {
    await page.getByRole("tab", { name: "Engineer" }).click();
    await expect(page.getByRole("tab", { name: "Engineer" })).toHaveAttribute("aria-selected", "true");
  }
  // the strip's widths settle once the model id (from /api/health) and the fonts are in
  await expect(page.locator(".ss-model .ss-v")).not.toHaveText("unavailable", { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  if (state === "armed") {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm stop" })).toBeVisible();
  }
  return actions;
}

for (const vp of WIDTHS) {
  test.describe(`the replay transport at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("every state: the same strip height, nothing cut, no page scroll, the call never covered", async ({ page }) => {
      const heights: Record<string, number> = {};
      for (const state of ORDER) {
        await open(page, state);
        const m = await stripMetrics(page);
        heights[state] = m.height;
        expect(m.pageOverflow, `${state}: page scrolls sideways`).toBeLessThanOrEqual(0);
        expect(m.cut, `${state}: cut boxes in the strip`).toEqual([]);
        expect(m.outside, `${state}: strip controls outside the viewport`).toEqual([]);
        const phone = vp.width <= 640;
        expect(m.minTarget.h, `${state}: target height`).toBeGreaterThanOrEqual(phone ? 44 : 24);
        expect(m.minTarget.w, `${state}: target width`).toBeGreaterThanOrEqual(phone ? 44 : 24);
        if (vp.width >= 1280) expect(m.oneLine, `${state}: the strip is one line`).toBe(true);
        else expect(m.transportBelow, `${state}: the transport is on its own line`).toBe(true);
        if (phone) expect(m.transportShare, `${state}: full-width transport line`).toBeGreaterThan(0.98);
        const cover = await callCover(page);
        expect(cover.intersecting, `${state}: replay controls over the call`).toEqual([]);
        expect(cover.covered, `${state}: points of the call covered`).toEqual([]);
        // the status is not shown as text: the strip's chip and lap show it; one hidden polite region announces it
        await expect(page.locator("#replay-status")).toHaveClass(/visually-hidden/);
        await expect(page.locator(".ss-mode")).not.toHaveAttribute("aria-live", /.*/);
        if (state === "finished") {
          // the call says the race ended and why, with no button of its own: the archive is offered once, in the strip
          await expect(page.locator("#the-call .call-none")).toHaveText(/^Race ended( at lap \d+)?$/);
          await expect(page.locator("#the-call .call-line-text")).toHaveText("The live call stops at the chequered flag.");
          await expect(page.locator("#the-call .call-body button")).toHaveCount(0);
          const archive = page.getByRole("button", { name: "Open the post-race archive" });
          expect(await archive.count(), "the archive button, at most once").toBeLessThanOrEqual(1);
          if ((await archive.count()) === 1) await expect(page.locator(".transport .tp-archive")).toBeVisible();
        }
      }
      test.info().annotations.push({ type: "strip height", description: JSON.stringify(heights) });
      expect(new Set(Object.values(heights)).size, `strip heights ${JSON.stringify(heights)}`).toBe(1);
    });
  });
}

for (const vp of [WIDTHS[0], WIDTHS[4]]) {
  test.describe(`the Engineer tab's transport at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("same phases and strip height as the Race tab; no overflow, nothing cut, controls in the viewport", async ({ page }) => {
      const heights = new Set<number>();
      for (const state of ["idle", "running", "paused", "stopped"] as const) {
        await open(page, state);
        const race = await stripMetrics(page);
        await open(page, state, "Engineer");
        await expect(page.getByRole("region", { name: "Engineer view" })).toBeVisible({ timeout: 30_000 });
        const eng = await stripMetrics(page);
        expect(eng.labels, `${state}: the same controls`).toEqual(race.labels);
        expect(eng.height, `${state}: the same strip height`).toBe(race.height);
        expect(eng.pageOverflow, `${state}: page scrolls sideways`).toBeLessThanOrEqual(0);
        expect(eng.cut, `${state}: cut boxes`).toEqual([]);
        expect(eng.outside, `${state}: controls outside the viewport`).toEqual([]);
        for (const b of await page.locator(".transport button").all()) await expect(b).toBeInViewport({ ratio: 1 });
        heights.add(eng.height);
      }
      expect(heights.size).toBe(1);
    });

    test("the controls work there: pause, then a two-press stop", async ({ page }) => {
      let body: unknown = STATES.running;
      const actions = await stubReplays(page, () => body);
      await page.goto(RACE);
      await page.getByRole("tab", { name: "Engineer" }).click();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => actions.filter((a) => a.endsWith("/replay/pause")).length).toBe(1);
      body = STATES.paused;
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible({ timeout: 15_000 });
      const stop = page.locator(".tp-stop");
      await stop.click();
      await expect(stop).toHaveText("Confirm stop");
      expect(actions.filter((a) => a.endsWith("/replay/stop"))).toEqual([]);
      await stop.click();
      await expect.poll(() => actions.filter((a) => a.endsWith("/replay/stop")).length).toBe(1);
    });
  });
}

test.describe("Stop at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("two presses; Escape and the timeout cancel; nothing is sent until the second press", async ({ page }) => {
    const actions = await open(page, "running");
    const stop = page.locator(".tp-stop");
    const stops = () => actions.filter((a) => a.endsWith("/replay/stop")).length;
    await stop.click();
    await expect(stop).toHaveText("Confirm stop");
    await expect(stop).toHaveAttribute("aria-describedby", /.+/);
    await page.keyboard.press("Escape");
    await expect(stop).toHaveText("Stop");
    // the timeout (about 4 s) cancels too
    await stop.click();
    await expect(stop).toHaveText("Confirm stop");
    await page.waitForTimeout(4500);
    await expect(stop).toHaveText("Stop");
    expect(stops()).toBe(0);
    // keyboard: two presses stop
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(stop).toHaveText("Confirm stop");
    await page.keyboard.press("Enter");
    await expect.poll(stops).toBe(1);
  });

  test("a replay that finishes on its own while Stop is armed: the button returns to normal, no stop is sent", async ({ page }) => {
    let body: unknown = STATES.running;
    const actions = await stubReplays(page, () => body);
    await page.goto(RACE);
    const stop = page.locator(".tp-stop");
    await stop.click();
    await expect(stop).toHaveText("Confirm stop");
    body = STATES.finished; // the next status poll (1 s while a replay runs) says it finished
    await expect(page.locator(".transport.phase-over")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Confirm stop" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Replay again/ })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(actions.filter((a) => a.endsWith("/replay/stop"))).toEqual([]);
    // the same for a failure while armed
    body = STATES.running;
    await page.reload();
    await stop.click();
    await expect(stop).toHaveText("Confirm stop");
    body = { ...STATES.finished, recent: [{ ...STATES.finished.recent[0], state: "failed", error: "stream job exited" }] };
    await expect(page.locator(".transport.phase-over")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".transport-error")).toHaveText("Replay failed: stream job exited");
    expect(actions.filter((a) => a.endsWith("/replay/stop"))).toEqual([]);
  });

  test("the cover check has teeth: a control placed over the call is reported", async ({ page }) => {
    await open(page, "running");
    await page.evaluate(() => {
      const c = document.getElementById("the-call")!.getBoundingClientRect();
      const probe = document.createElement("button");
      probe.className = "btn btn-small tp-probe";
      probe.textContent = "probe";
      probe.style.cssText = `position:fixed;left:${c.left + 40}px;top:${c.top + 60}px;width:${c.width - 80}px;height:120px;z-index:50`;
      document.querySelector(".transport")!.appendChild(probe);
    });
    const cover = await callCover(page);
    expect(cover.intersecting).toContain("button.btn.btn-small.tp-probe");
    expect(cover.covered.length).toBeGreaterThan(0);
  });

  test("keyboard: the transport after the strip's cells, with a visible focus ring", async ({ page }) => {
    await open(page, "running");
    await page.getByRole("link", { name: "Drivers" }).focus();
    for (const name of ["Pause", "Stop"]) {
      await page.keyboard.press("Tab");
      const focused = page.getByRole("button", { name, exact: true });
      await expect(focused).toBeFocused();
      const ring = await focused.evaluate((e) => {
        const s = getComputedStyle(e);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(ring.style, `${name}: focus ring`).not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
    }
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("60×")).toBeFocused();
    const ring = await page.locator(".tp-speed input:focus-visible + span").evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(ring).not.toBe("none");
  });
});

for (const theme of ["dark", "light"] as const) {
  test.describe(`axe on every transport state, ${theme} theme`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("no serious or critical violation", async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem("f1sa.theme", t);
        } catch {
          /* blocked storage: the page stays dark */
        }
      }, theme);
      const found: string[] = [];
      for (const state of ORDER) {
        await open(page, state);
        found.push(...(await seriousViolations(page)).map((v) => `${state}: ${v}`));
      }
      expect(found).toEqual([]);
    });
  });
}
