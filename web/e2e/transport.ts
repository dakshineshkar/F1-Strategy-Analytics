import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { API, type Replays } from "./replay";

/** Shared checks of the status strip's inline replay transport (the replay popover that covered the call is gone). */

export interface StripMetrics {
  /** the strip's height (px) */
  height: number;
  /** the transport shares the first line with the mode chip */
  oneLine: boolean;
  /** the transport is on a line below the mode chip */
  transportBelow: boolean;
  /** the transport's width as a share of the strip's inner width */
  transportShare: number;
  /** document scrollWidth - viewport width */
  pageOverflow: number;
  /** strip boxes whose content is wider than the box (a cut value) */
  cut: string[];
  /** strip controls and cells not wholly inside the viewport */
  outside: string[];
  /** the smallest transport target, width and height (px) */
  minTarget: { w: number; h: number };
  /** the transport's visible control labels, in DOM order */
  labels: string[];
}

export async function stripMetrics(page: Page): Promise<StripMetrics> {
  return page.evaluate(() => {
    const strip = document.querySelector(".status-strip") as HTMLElement;
    const tp = document.querySelector(".transport") as HTMLElement;
    const mode = document.querySelector(".ss-mode") as HTMLElement;
    const s = strip.getBoundingClientRect();
    const t = tp.getBoundingClientRect();
    const m = mode.getBoundingClientRect();
    const cs = getComputedStyle(strip);
    const inner = strip.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const visible = (e: Element) => e.getBoundingClientRect().width > 1 && !e.closest("[hidden]");
    const cut = [...strip.querySelectorAll("*"), strip]
      .filter((e) => visible(e) && getComputedStyle(e).display !== "inline" && e.scrollWidth > e.clientWidth)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}: ${(e.textContent ?? "").trim().slice(0, 30)} (${e.scrollWidth} > ${e.clientWidth})`);
    const outside = [...strip.querySelectorAll(".ss-mode, .ss-cell, .stamp, button, .tp-speed span, .tp-reason")]
      .filter(visible)
      .filter((e) => {
        const b = e.getBoundingClientRect();
        return b.left < 0 || b.right > window.innerWidth + 0.5 || b.top < 0 || b.bottom > window.innerHeight + 0.5;
      })
      .map((e) => (e.textContent ?? "").trim().slice(0, 30));
    const targets = [...tp.querySelectorAll("button, .tp-speed span")].filter(visible).map((e) => e.getBoundingClientRect());
    return {
      height: Math.round(s.height),
      oneLine: Math.abs((t.top + t.bottom) / 2 - (m.top + m.bottom) / 2) < 4,
      transportBelow: t.top >= m.bottom,
      transportShare: t.width / inner,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      cut,
      outside,
      minTarget: {
        w: Math.min(...targets.map((b) => Math.round(b.width))),
        h: Math.min(...targets.map((b) => Math.round(b.height))),
      },
      labels: [...tp.querySelectorAll("button, .tp-speed span, .tp-reason")].filter(visible).map((e) => (e.textContent ?? "").trim()),
    };
  });
}

/** What covers the call: replay controls whose box intersects the call's box, and points of a grid over the call
 * (inside the viewport) where the topmost element is not part of the call. Both must be empty in every state. */
export async function callCover(page: Page): Promise<{ intersecting: string[]; covered: string[] }> {
  return page.evaluate(() => {
    const call = document.getElementById("the-call");
    if (call === null) return { intersecting: ["no #the-call"], covered: [] };
    const c = call.getBoundingClientRect();
    const hit = (b: DOMRect) => b.width > 0 && b.height > 0 && b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top;
    const intersecting = [...document.querySelectorAll(".transport, .transport *, .transport-error")]
      .filter((e) => hit(e.getBoundingClientRect()))
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    const covered: string[] = [];
    // inset past the panel's rounded corners (a corner point lies outside the call's painted box)
    const inset = 10;
    const top = Math.max(c.top + inset, 0);
    const bottom = Math.min(c.bottom - inset, window.innerHeight - 1);
    for (let i = 0; i <= 8; i += 1) {
      for (let j = 0; j <= 8; j += 1) {
        const x = c.left + inset + ((c.width - 2 * inset) * i) / 8;
        const y = top + ((bottom - top) * j) / 8;
        if (y < 0 || y >= window.innerHeight || x < 0 || x >= window.innerWidth) continue;
        const el = document.elementFromPoint(x, y);
        if (el !== null && !call.contains(el)) covered.push(`${Math.round(x)},${Math.round(y)}: ${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
      }
    }
    return { intersecting, covered };
  });
}

/** axe's serious and critical violations of the page as it is now (WCAG 2.0/2.1/2.2 A and AA, best practices). */
export async function seriousViolations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join("; ")})`);
}

/** A replay of 2024 R5 in the shape of GET /api/replays. */
export function job(over: Partial<Replays["running"][number]> & Record<string, unknown> = {}) {
  return {
    season: 2024,
    round: 5,
    speed: 60,
    run_id: "2024_5_20261121T000000.000Z",
    state: "running",
    error: null,
    started_at: "2026-11-21T00:00:00.000Z",
    ended_at: null,
    paused: false,
    lap: 14,
    note: null,
    paused_at: null,
    ...over,
  };
}

export const STATES = {
  idle: { enabled: true, max_running: 1, running: [], recent: [] },
  running: { enabled: true, max_running: 1, running: [job()], recent: [] },
  paused: { enabled: true, max_running: 1, running: [job({ state: "paused", paused: true })], recent: [] },
  stopped: { enabled: true, max_running: 1, running: [], recent: [job({ state: "stopped" })] },
  finished: { enabled: true, max_running: 1, running: [], recent: [job({ state: "finished", lap: 56 })] },
  blocked: { enabled: true, max_running: 1, running: [job({ round: 6 })], recent: [] },
} as const;
export type StubState = keyof typeof STATES;

/**
 * Serve GET /api/replays from ``body()`` (the real response's headers, so CORS holds) and answer every replay
 * action (start, stop, pause, resume, speed) locally, recording it: a stubbed page never starts, stops or changes a
 * real replay. Returns the recorded action paths.
 */
export async function stubReplays(page: Page, body: () => unknown): Promise<string[]> {
  const actions: string[] = [];
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(`${API}/api/replays`, async (route: Route) => {
    const real = await route.fetch().catch(() => null);
    if (real === null) await route.fulfill({ json: body(), headers: { "access-control-allow-origin": "*" } });
    else await route.fulfill({ response: real, json: body() });
  });
  await page.route(new RegExp(`^${API.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/races/\\d+/\\d+/replay(/.*)?$`), async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": req.headers()["origin"] ?? "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
      return;
    }
    actions.push(new URL(req.url()).pathname);
    await route.fulfill({ status: 200, json: job(), headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" } });
  });
  return actions;
}

/**
 * Start a replay of the open race from the strip at ``speed``: in the idle phase choose the speed, then Start replay;
 * after an earlier run of the race (the over phase: finished or stopped, while the API still lists it) the strip
 * offers Replay again, which restarts at that run's speed, so the speed is set once the new run is active. Returns
 * the phase the strip was in before the start.
 */
export async function startFromStrip(page: Page, speed: 1 | 10 | 60): Promise<"idle" | "over"> {
  const transport = page.locator(".transport.phase-idle, .transport.phase-over");
  await transport.first().waitFor({ timeout: 15_000 });
  const idle = (await page.locator(".transport.phase-idle").count()) > 0;
  if (idle) {
    await page.getByLabel(`${speed}×`).check();
    await page.getByRole("button", { name: "Start replay" }).click();
  } else {
    await page.getByRole("button", { name: /Replay again/ }).click();
    await page.locator(".transport.phase-active").waitFor({ timeout: 30_000 });
    const radio = page.getByLabel(`${speed}×`);
    if (!(await radio.isChecked())) await radio.check();
  }
  return idle ? "idle" : "over";
}
