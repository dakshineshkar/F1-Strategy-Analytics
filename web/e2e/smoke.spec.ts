import { expect, type APIRequestContext, test } from "@playwright/test";

/**
 * Smoke test against the real API in sample mode with replay enabled (`make api-up REPLAY=1`):
 * open the sample race 2024 R5 from the picker with the keyboard, start a replay at 60×, and see
 * the tower fill (20 cars) and at least one lap update. A replay writes only data/demo/<run_id>.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:8000";

async function waitForIdle(request: APIRequestContext, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = (await (await request.get(`${API}/api/replays`)).json()) as { running: unknown[] };
    if (body.running.length === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/api/health`).catch(() => null);
  test.skip(health === null, `API not reachable at ${API}: run 'make api-up REPLAY=1' first`);
});

test("sample race: a 60× replay fills the tower and updates laps", async ({ page, request }) => {
  const status = (await (await request.get(`${API}/api/replays`)).json()) as { enabled: boolean };
  test.skip(!status.enabled, "replay is disabled on the API: run 'make api-up REPLAY=1'");
  expect(await waitForIdle(request, 150_000), "another replay is still running").toBe(true);

  await page.goto("/");
  await expect(page.getByRole("note", { name: "Data notice" })).toContainText("SYNTHETIC DEMO DATA");
  await expect(page.locator("#race-count")).toContainText("of 2 races");

  // Keyboard only: search, move into the list with the arrow keys, open with Enter.
  await page.getByLabel("Search races").fill("chinese");
  await expect(page.locator("#race-count")).toContainText("1 of 2 races");
  const link = page.getByRole("link", { name: /Chinese Grand Prix/ });
  await link.focus();
  await page.keyboard.press("Home");
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/race\/2024\/5$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Chinese Grand Prix");

  await page.getByLabel("60×").check();
  const start = page.getByRole("button", { name: "Start replay" });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page.locator("#replay-status")).toContainText(/Starting|Running/, { timeout: 20_000 });
  await expect(start).toBeDisabled();

  // The tower fills from the stream (the stream job needs ~20-40 s to be ready).
  const rows = page.locator("table.tower tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 120_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
  await expect(page.locator(".conn")).toContainText("Live");

  // How to read this: the legend opens by keyboard and explains the markers in text.
  const legend = page.locator("details.legend");
  await legend.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(legend).toHaveAttribute("open", "");
  await expect(legend.getByText(/Calibrated model probability that an undercut/)).toBeVisible();
  await expect(legend.getByText(/assumes a new set/)).toBeVisible();
  await expect(legend.getByText(/just become an undercut candidate/)).toBeVisible();

  // Column tooltips: keyboard focus shows the text and it is the button's accessible description;
  // Escape hides it, Enter (a click) opens it again.
  const tipButton = page.getByRole("button", { name: "About Undercut" });
  const tipText = page.locator("#tip-undercut");
  await expect(tipText).toBeHidden();
  await tipButton.focus();
  await expect(tipButton).toHaveAccessibleDescription(/calibrated model probability/i);
  await expect(tipText).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tipText).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(tipText).toBeVisible();
  await expect(tipButton).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(tipButton).toHaveAttribute("aria-expanded", "false");
  for (const name of ["About Int", "About Gap", "About Age", "About tyre age", "About the undercut flag", "About Opportunity", "About Attempt"]) {
    await expect(page.getByRole("button", { name })).toHaveAccessibleDescription(/\w+/);
  }

  // At least one lap update after the tower filled.
  const lapNow = page.locator(".lc-now");
  const before = (await lapNow.textContent())?.trim() ?? "";
  await expect.poll(async () => (await lapNow.textContent())?.trim(), { timeout: 60_000 }).not.toBe(before);

  // What-if (S15), keyboard only: the defender defaults to the car ahead; run with Enter.
  const panel = page.getByRole("region", { name: "What-if: pit strategy" });
  const attacker = panel.getByLabel("Attacker");
  await attacker.focus();
  await page.keyboard.press("ArrowDown"); // the car in P3 (its defender is P2)
  const chosen = await attacker.inputValue();
  expect(chosen).not.toBe("");
  await expect(panel.getByLabel("Defender (car ahead)")).not.toHaveValue("");
  await panel.getByRole("button", { name: "Run what-if" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator("#whatif-status")).toContainText(/at lap \d+/, { timeout: 20_000 });
  const table = panel.getByRole("table");
  for (const name of ["Pit now", "Pit next lap", "Stay out (overcut)"]) {
    await expect(table.getByRole("rowheader", { name: new RegExp(name.replace(/[()]/g, "\\$&")) }).first()).toBeVisible();
  }
  await expect(table.locator("tbody").first()).toContainText(/\d+%|Not possible/);
  await expect(panel).toContainText("Model (calibrated LR, from the stream):");
  await expect(panel.getByRole("alert")).toHaveText("");

  // 375 px: no horizontal page scroll (the tower scrolls inside its own region).
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Entrants (display only): team badges in the tower, the footer note, the Drivers view.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("footer.site-footer")).toHaveText(
    "Unofficial project; not associated with the Formula 1 companies.",
  );
  await expect.poll(async () => page.locator("table.tower tbody .team-badge").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(20);
  const firstRow = page.locator("table.tower tbody tr").first();
  await firstRow.hover();
  await expect(page.locator("table.tower tbody tr.is-team-hover")).toHaveCount(1);
  await expect(page.locator("table.tower tbody tr.is-teammate")).toHaveCount(1);
  await page.getByRole("navigation", { name: "Race views" }).getByRole("link", { name: "Drivers" }).click();
  await expect(page).toHaveURL(/\/race\/2024\/5\/drivers$/);
  const drivers = page.getByRole("table", { name: /Drivers/ });
  await expect(drivers.locator("tbody tr")).toHaveCount(20);
  await expect(drivers.locator("tbody .team-badge")).toHaveCount(20);
  await expect(drivers.locator("tbody tr").first().locator(".c-grid")).toHaveText("1");
  // 2024 season display names (Jolpica's "RB F1 Team" and "Sauber" are mapped per season).
  await expect(drivers.locator("td.c-team", { hasText: /^RB$/ })).toHaveCount(2);
  await expect(drivers.locator("td.c-team", { hasText: /^Kick Sauber$/ })).toHaveCount(2);
  await expect(drivers.locator("img, svg")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow2).toBeLessThanOrEqual(0);

  // Race analysis (display only, Feature 2): the tab from the race page, keyboard tabs, the sample's
  // synthetic tyre note, a two-driver comparison, the race-control empty state and lap links.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/race/2024/5");
  await page.getByRole("navigation", { name: "Race views" }).getByRole("link", { name: "Race analysis" }).click();
  await expect(page).toHaveURL(/\/race\/2024\/5\/analysis/);
  const tabs = page.getByRole("tablist", { name: "Race analysis views" }).getByRole("tab");
  await expect(tabs).toHaveCount(7);
  const strategy = page.getByRole("tab", { name: "Tyre strategy" });
  await expect(strategy).toHaveAttribute("aria-selected", "true");
  const panelA = page.getByRole("tabpanel");
  await expect(panelA).toContainText("SYNTHETIC: not real tyre data.");
  await expect(page.locator(".analysis-notes")).toContainText("SYNTHETIC");
  await panelA.getByText("Show table").click();
  await expect(page.getByRole("table", { name: "Stints by driver" }).locator("tbody tr")).toHaveCount(20);
  await strategy.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Lap times" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Lap times" })).toBeFocused();
  await expect(page).toHaveURL(/view=laps/);
  await expect(panelA.getByRole("group", { name: /Drivers/ }).getByRole("checkbox")).toHaveCount(20);
  await page.keyboard.press("ArrowRight");
  await expect(panelA).toContainText("A lap-time proxy, not tyre wear");
  await expect(panelA).toContainText(/s\/lap|no fit/);
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Race control" })).toHaveAttribute("aria-selected", "true");
  await expect(panelA).toContainText("No race-control messages in this lake for this race.");
  await page.getByRole("tab", { name: "Compare" }).click();
  await expect(panelA.locator(".compare-summary")).toContainText(/was faster on \d+/, { timeout: 15_000 });
  await expect(panelA.getByRole("combobox", { name: "Driver a" })).toBeVisible();
  await expect(panelA).toContainText("No sector times in this lake.");
  await page.getByRole("tab", { name: "Pit stops" }).click();
  const firstStop = page.getByRole("table", { name: "Pit stops by lap" }).locator("tbody tr").first().getByRole("link");
  const stopLap = (await firstStop.textContent())?.trim() ?? "";
  await firstStop.click();
  await expect(page).toHaveURL(new RegExp(`view=laps&lap=${stopLap}$`));
  await expect(page.locator(".lap-mark")).toContainText(`Lap ${stopLap}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow3 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow3).toBeLessThanOrEqual(0);
});
