import type { APIRequestContext } from "@playwright/test";

/** Shared replay helpers of the e2e specs. Every spec that starts a replay stops it again through the API
 * (afterEach / afterAll), so a later `make web-up` or `make api-up` is not refused by the replay guard. */

export const API = process.env.E2E_API_URL ?? "http://localhost:8000";

export interface ReplayJob {
  run_id: string;
  season: number;
  round: number;
  state: string;
  speed: number;
  paused: boolean;
  lap: number | null;
}

export interface Replays {
  enabled: boolean;
  running: ReplayJob[];
  recent: ReplayJob[];
}

export async function replays(request: APIRequestContext): Promise<Replays> {
  return (await (await request.get(`${API}/api/replays`)).json()) as Replays;
}

/** True once no replay runs (polled every 2 s), false after ``timeoutMs``. */
export async function waitForIdle(request: APIRequestContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await replays(request)).running.length === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Stop the race's replay. It returns once both processes are gone; 409 (none running) is fine, and an
 * unreachable API is ignored (the spec has already failed then). */
export async function stopReplay(request: APIRequestContext, season: number, round: number): Promise<void> {
  await request.post(`${API}/api/races/${season}/${round}/replay/stop`, { timeout: 60_000 }).catch(() => null);
}
