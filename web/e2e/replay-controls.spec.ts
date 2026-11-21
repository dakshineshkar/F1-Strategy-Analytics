import { expect, test } from "@playwright/test";

import { API, replays, stopReplay, waitForIdle } from "./replay";
import { callCover, seriousViolations, startFromStrip, stripMetrics } from "./transport";

/**
 * The status strip's inline replay transport (Feature 7) against the real API in sample mode with replay enabled
 * (`make api-up REPLAY=1`): start the sample race 2024 R5 at 1×, switch to 60×, pause (the lap reached stays put),
 * resume, and stop with two presses (the first only arms "Confirm stop"; Escape and the timeout cancel it), all
 * from the strip; then "Replay again" is offered. In every state (idle, running, paused, Stop armed, stopped) the
 * call is never covered by a replay control, the strip keeps one height and axe reports no serious or critical
 * violation. A replay writes only data/demo/<run_id> and the race's Redis keys.
 */

/** True once this spec clicked Start: it stops its own replay at the end, and afterEach / afterAll stop it
 * through the API when the test failed before that. */
let started = false;

test.afterEach(async ({ request }) => {
  if (started) await stopReplay(request, 2024, 5);
  started = false;
});

test.afterAll(async ({ request }) => {
  if (started) await stopReplay(request, 2024, 5);
});

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' first`);
});

test.use({ viewport: { width: 1440, height: 900 } });

test("sample race: start at 1×, switch to 60×, pause, resume and a two-press stop; the call is never covered", async ({ page, request }) => {
  test.setTimeout(300_000);
  const status = await replays(request);
  test.skip(!status.enabled, "replay is disabled on the API: run 'make api-up REPLAY=1'");
  expect(await waitForIdle(request, 240_000), "another replay is still running").toBe(true);

  await page.goto("/race/2024/5");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Chinese Grand Prix");
  // the controls are inline in the status strip: there is no popover to open
  await expect(page.getByRole("button", { name: "Replay controls" })).toHaveCount(0);
  const replayStatus = page.locator("#replay-status");
  const lapNow = page.locator(".status-strip .ss-lap .lc-now");
  const start = page.getByRole("button", { name: "Start replay" });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  const stop = page.locator(".tp-stop");

  const heights: Record<string, number> = {};
  const problems: string[] = [];
  /** the call is never covered, and axe is clean, in this state; the strip's height is recorded */
  const check = async (state: string) => {
    const cover = await callCover(page);
    problems.push(...cover.intersecting.map((x) => `${state}: control over the call: ${x}`));
    problems.push(...cover.covered.map((x) => `${state}: call covered at ${x}`));
    problems.push(...(await seriousViolations(page)).map((v) => `${state}: ${v}`));
    const m = await stripMetrics(page);
    problems.push(...m.cut.map((x) => `${state}: cut ${x}`));
    heights[state] = m.height;
  };

  // Before a run: Start and the speed choice (idle), or Replay again and the archive after an earlier run of this race
  // that the API still lists (over); no Pause or Stop. The status is not shown as text, only announced (one hidden
  // polite region).
  await expect(page.locator(".transport.phase-idle, .transport.phase-over")).toHaveCount(1, { timeout: 15_000 });
  const before = (await page.locator(".transport.phase-idle").count()) > 0 ? "idle" : "over";
  if (before === "idle") await expect(start).toBeEnabled();
  else await expect(page.getByRole("button", { name: /Replay again/ })).toBeEnabled();
  await expect(pause).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await expect(replayStatus).toHaveClass(/visually-hidden/);
  await expect(page.locator(".ss-model .ss-v")).not.toHaveText("unavailable");
  await check(before);

  started = true; // before the click: a stop with nothing running is a harmless 409
  await startFromStrip(page, 1);
  await expect(replayStatus).toContainText(/Starting|Running at 1×/, { timeout: 20_000 });
  await expect(start).toHaveCount(0);
  await expect(stop).toBeEnabled();
  await expect(replayStatus).toHaveText("Running at 1×.", { timeout: 120_000 });

  // Change the speed while it runs: the API's speed is shown, the run continues; the strip's chip says so.
  await page.getByLabel("60×").check();
  await expect(replayStatus).toHaveText("Running at 60×.", { timeout: 15_000 });
  await expect(page.getByLabel("60×")).toBeChecked();
  await expect(page.locator(".ss-mode")).toContainText("REPLAY 60×");
  await expect.poll(async () => Number((await lapNow.textContent()) ?? 0), { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  await check("running");

  // Pause with the keyboard: the state is announced, the lap reached stays put.
  await pause.focus();
  await page.keyboard.press("Enter");
  await expect(replayStatus).toHaveText(/^Paused at lap \d+ \(60×\)\.$/, { timeout: 15_000 });
  await expect(page.locator(".ss-mode")).toContainText("PAUSED");
  await expect(resume).toBeEnabled();
  await expect(resume).toBeFocused();
  const pausedAt = (await replays(request)).running[0];
  expect(pausedAt?.state).toBe("paused");
  await page.waitForTimeout(4000);
  const stillPaused = (await replays(request)).running[0];
  expect(stillPaused?.lap).toBe(pausedAt?.lap);
  await check("paused");

  // Resume, then Stop: the first press only arms it ("Confirm stop"); Escape cancels; nothing was stopped.
  await resume.click();
  await expect(replayStatus).toHaveText("Running at 60×.", { timeout: 15_000 });
  await stop.click();
  await expect(stop).toHaveText("Confirm stop");
  await check("armed");
  await page.keyboard.press("Escape");
  await expect(stop).toHaveText("Stop");
  // the timeout cancels too
  await stop.click();
  await expect(stop).toHaveText("Confirm stop");
  await page.waitForTimeout(4500);
  await expect(stop).toHaveText("Stop");
  expect((await replays(request)).running[0]?.state).toBe("running");

  // Two presses (keyboard) stop: no session_end is faked, the state names the lap reached.
  await stop.focus();
  await page.keyboard.press("Space");
  await expect(stop).toHaveText("Confirm stop");
  await page.keyboard.press("Space");
  await expect(replayStatus).toHaveText(/^Stopped at lap \d+\.$/, { timeout: 30_000 });
  await expect(page.locator(".ss-mode")).toContainText("STOPPED");
  const again = page.getByRole("button", { name: /Replay again/ });
  await expect(again).toBeEnabled();
  await expect(again).toBeFocused();
  await check("stopped");
  started = false;

  expect(problems).toEqual([]);
  expect(new Set(Object.values(heights)).size, `strip heights ${JSON.stringify(heights)}`).toBe(1);

  const after = await replays(request);
  expect(after.running).toEqual([]);
  const last = after.recent[0];
  expect(last?.state).toBe("stopped");
  expect(last?.season).toBe(2024);
  expect(last?.speed).toBe(60);
  expect(last?.lap ?? 0).toBeGreaterThanOrEqual(stillPaused?.lap ?? 0);
});

