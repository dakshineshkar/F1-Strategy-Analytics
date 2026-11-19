import { expect, type APIRequestContext, test } from "@playwright/test";

/**
 * Replay controls (Feature 7) against the real API in sample mode with replay enabled
 * (`make api-up REPLAY=1`): start the sample race 2024 R5 at 1×, switch to 60×, pause (the lap
 * reached stays put), resume and stop, all from the dashboard. The pause and the stop are done
 * with the keyboard. A replay writes only data/demo/<run_id> and the race's Redis keys.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:8000";

interface ReplayJob {
  run_id: string;
  season: number;
  round: number;
  state: string;
  speed: number;
  paused: boolean;
  lap: number | null;
}

async function replays(request: APIRequestContext): Promise<{ enabled: boolean; running: ReplayJob[]; recent: ReplayJob[] }> {
  return (await (await request.get(`${API}/api/replays`)).json()) as { enabled: boolean; running: ReplayJob[]; recent: ReplayJob[] };
}

async function waitForIdle(request: APIRequestContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await replays(request)).running.length === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' first`);
});

test("sample race: start at 1×, switch to 60×, pause, resume and stop", async ({ page, request }) => {
  test.setTimeout(300_000);
  const status = await replays(request);
  test.skip(!status.enabled, "replay is disabled on the API: run 'make api-up REPLAY=1'");
  expect(await waitForIdle(request, 240_000), "another replay is still running").toBe(true);

  await page.goto("/race/2024/5");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Chinese Grand Prix");
  // the replay controls live in a drawer under the status strip (redesign); it stays open while used
  await page.getByRole("button", { name: "Replay controls" }).click();
  const replayStatus = page.locator("#replay-status");
  const lapLine = page.locator(".replay-lap");
  const start = page.getByRole("button", { name: "Start replay" });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });

  // Idle: only Start (and the speed choice) is offered.
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await expect(pause).toBeDisabled();
  await expect(stop).toBeDisabled();

  await page.getByLabel("1×").check();
  await start.click();
  await expect(replayStatus).toContainText(/Starting|Running at 1×/, { timeout: 20_000 });
  await expect(start).toBeDisabled();
  await expect(stop).toBeEnabled();
  await expect(replayStatus).toHaveText("Running at 1×.", { timeout: 120_000 });

  // Change the speed while it runs: the API's speed is shown, the run continues.
  await page.getByLabel("60×").check();
  await expect(replayStatus).toHaveText("Running at 60×.", { timeout: 15_000 });
  await expect(page.getByLabel("60×")).toBeChecked();
  await expect(lapLine).toHaveText(/Lap \d+ sent\./, { timeout: 60_000 });
  await expect
    .poll(async () => Number((await lapLine.textContent())?.match(/\d+/)?.[0] ?? 0), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(3);

  // Pause with the keyboard: the state is announced, the lap reached stays put.
  await pause.focus();
  await page.keyboard.press("Enter");
  await expect(replayStatus).toHaveText(/^Paused at lap \d+ \(60×\)\.$/, { timeout: 15_000 });
  await expect(resume).toBeEnabled();
  const pausedAt = (await replays(request)).running[0];
  expect(pausedAt?.state).toBe("paused");
  await page.waitForTimeout(4000);
  const stillPaused = (await replays(request)).running[0];
  expect(stillPaused?.lap).toBe(pausedAt?.lap);

  // Resume, then stop (keyboard): no session_end is faked, the state names the lap reached.
  await resume.click();
  await expect(replayStatus).toHaveText("Running at 60×.", { timeout: 15_000 });
  await stop.focus();
  await page.keyboard.press("Space");
  await expect(replayStatus).toHaveText(/^Stopped at lap \d+\.$/, { timeout: 30_000 });
  await expect(start).toBeEnabled();
  await expect(pause).toBeDisabled();
  await expect(stop).toBeDisabled();

  const after = await replays(request);
  expect(after.running).toEqual([]);
  const last = after.recent[0];
  expect(last?.state).toBe("stopped");
  expect(last?.season).toBe(2024);
  expect(last?.speed).toBe(60);
  expect(last?.lap ?? 0).toBeGreaterThanOrEqual(stillPaused?.lap ?? 0);
});
