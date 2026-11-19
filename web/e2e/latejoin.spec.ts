import { expect, test } from "@playwright/test";

import { API, replays, stopReplay, waitForIdle } from "./replay";

/**
 * F09 (Step 3): a page opened mid-race already shows the run's earlier alerts, from the connect snapshot's
 * ``recent_alerts``, below "Received before you opened the page"; and after the next live alert no alert is
 * counted twice. Against the real API with replay enabled (either lake). The spec starts a 10× replay of
 * 2024 R5 through the API, opens the page once the leader is on lap 12, and stops the replay afterwards.
 *
 * The page's own EventSource is wrapped (an init script, before the app loads), so the test sees exactly the
 * snapshot-0 history and the live alert frames the reducer received. Each pair's count in the feed must be the
 * number of distinct event ids of that pair across both, and every pair appears once.
 */

const RACE = "/race/2024/5";
const JOIN_LAP = 12;
let started = false;

interface Seen {
  snapshots0: number;
  history: { id: string; key: string; lap: number }[];
  live: { id: string; key: string; lap: number }[];
}

declare global {
  interface Window {
    __f09?: Seen;
  }
}

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

test("late join: the feed already holds the run's earlier alerts, none twice after the next live one", async ({ page, request }) => {
  test.setTimeout(480_000);
  const status = await replays(request);
  test.skip(!status.enabled, "replay is disabled on the API: run 'make api-up REPLAY=1'");
  expect(await waitForIdle(request, 150_000), "another replay is still running").toBe(true);

  started = true;
  const r = await request.post(`${API}/api/races/2024/5/replay`, { data: { speed: 10 } });
  expect(r.status(), await r.text()).toBe(202);
  await expect
    .poll(async () => (await replays(request)).running.find((j) => j.season === 2024 && j.round === 5)?.lap ?? 0, {
      timeout: 300_000,
      intervals: [2000],
    })
    .toBeGreaterThanOrEqual(JOIN_LAP);

  await page.addInitScript(() => {
    const seen: Seen = { snapshots0: 0, history: [], live: [] };
    window.__f09 = seen;
    const Orig = window.EventSource;
    type Frame = { event_id: string; payload: { attacker_id: string; defender_id: string; decision_lap: number } };
    const entry = (f: Frame) => ({ id: f.event_id, key: `${f.payload.attacker_id}>${f.payload.defender_id}`, lap: f.payload.decision_lap });
    class Recording extends Orig {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("snapshot", (e) => {
          const d = JSON.parse((e as MessageEvent<string>).data) as { event_id: string; recent_alerts?: Frame[] };
          if (d.event_id !== "snapshot-0") return;
          seen.snapshots0 += 1;
          for (const a of d.recent_alerts ?? []) seen.history.push(entry(a));
        });
        this.addEventListener("undercut_alert", (e) => {
          seen.live.push(entry(JSON.parse((e as MessageEvent<string>).data) as Frame));
        });
      }
    }
    window.EventSource = Recording;
  });
  await page.goto(RACE);

  const seen = async (): Promise<Seen> => page.evaluate(() => window.__f09 ?? { snapshots0: 0, history: [], live: [] });
  await expect.poll(async () => (await seen()).snapshots0, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const before = await seen();
  expect(before.history.length, "the API sent the run's earlier alerts with the connect snapshot").toBeGreaterThan(0);
  expect(new Set(before.history.map((h) => h.id)).size).toBe(before.history.length);
  // only alerts already emitted: no decision lap beyond the leader's lap at the join
  const lapNow = (await replays(request)).running[0]?.lap ?? 0;
  for (const h of before.history) expect(h.lap).toBeLessThanOrEqual(lapNow);

  // the feed already shows them, below the quiet divider, and none of them is "new"
  const feed = page.getByRole("region", { name: "Undercut alert list" });
  const divider = feed.locator(".alert-divider-before_open");
  await expect(divider).toHaveText("Received before you opened the page");
  const historyPairs = new Set(before.history.map((h) => h.key));
  await expect.poll(async () => feed.locator(".alert.is-history").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await feed.locator(".alert.is-history.is-new").count(), "a history alert is never new").toBe(0);

  // wait for the next live alert, then compare every pair's count with its distinct ids
  await expect.poll(async () => (await seen()).live.length, { timeout: 240_000, intervals: [1000] }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const s = await seen();
        const ids = new Map<string, Set<string>>();
        for (const a of [...s.history, ...s.live]) ids.set(a.key, (ids.get(a.key) ?? new Set()).add(a.id));
        const shown = await feed.locator("li.alert").evaluateAll((lis) =>
          lis.map((li) => {
            const n = li.querySelector(".alert-count .num")?.textContent ?? "";
            return { key: li.getAttribute("data-flip") ?? "", count: n === "" ? 1 : Number(n.replace("×", "")) };
          }),
        );
        const keys = shown.map((x) => x.key);
        const problems: string[] = [];
        if (new Set(keys).size !== keys.length) problems.push(`a pair is shown twice: ${keys.join(",")}`);
        for (const [key, set] of ids) {
          const row = shown.find((x) => x.key === key);
          if (!row) problems.push(`${key} missing`);
          else if (row.count !== set.size) problems.push(`${key}: shows ${row.count}, ${set.size} distinct alerts`);
        }
        for (const x of shown) if (!ids.has(x.key)) problems.push(`${x.key} shown without an alert`);
        return problems;
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toEqual([]);
  const after = await seen();
  const overlap = after.live.filter((l) => before.history.some((h) => h.id === l.id)).length;
  test.info().annotations.push({
    type: "f09",
    description: `history ${before.history.length} alerts (${historyPairs.size} pairs) at lap ${lapNow}; live ${after.live.length}; live also in history ${overlap}`,
  });
});
