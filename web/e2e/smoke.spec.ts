import { expect, test } from "@playwright/test";

import { API, stopReplay, waitForIdle } from "./replay";

/**
 * Smoke test against the real API in sample mode with replay enabled (`make api-up REPLAY=1`):
 * open the sample race 2024 R5 from the picker with the keyboard, start a replay at 60×, and see
 * the tower fill (20 cars) and at least one lap update. A replay writes only data/demo/<run_id>.
 */

/** True once this spec clicked Start: afterEach / afterAll stop the replay through the API, so it never outlives
 * the spec (a running replay makes the replay guard refuse a later `make web-up`). */
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
  // the race list's own link (the Start here card above the search links the demo race too)
  const link = page.locator("#race-list").getByRole("link", { name: /Chinese Grand Prix/ });
  await link.focus();
  await page.keyboard.press("Home");
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/race\/2024\/5$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Chinese Grand Prix");

  // the replay controls live in a drawer under the status strip (redesign: demo controls, not race state)
  await page.getByRole("button", { name: "Replay controls", exact: true }).click();
  await page.getByLabel("60×").check();
  const start = page.getByRole("button", { name: "Start replay" });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  started = true; // before the click: a stop with nothing running is a harmless 409
  await start.click();
  await expect(page.locator("#replay-status")).toContainText(/Starting|Running/, { timeout: 20_000 });
  await expect(start).toBeDisabled();

  // The tower fills from the stream (the stream job needs ~20-40 s to be ready).
  const rows = page.locator("table.tower tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 120_000, intervals: [1000] }).toBeGreaterThanOrEqual(20);
  await expect(page.locator(".conn")).toContainText("Stream connected");
  await expect(page.getByRole("region", { name: "Race status" }).locator(".ss-mode")).toContainText(/REPLAY 60×/);
  await page.keyboard.press("Escape"); // close the replay drawer

  // How to read this: the legend opens by keyboard and explains the markers in text.
  const legend = page.locator("details.legend");
  await legend.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(legend).toHaveAttribute("open", "");
  await expect(legend.getByText(/Calibrated model probability that an undercut/)).toBeVisible();
  await expect(legend.getByText(/assumes a new set/)).toBeVisible();
  await expect(legend.getByText(/just passed the undercut rule/)).toBeVisible();

  // The tower's one key (redesign, critique F29/F30): Enter opens it, the entries are the row markers'
  // descriptions, Escape closes it and returns focus to the button.
  const keyButton = page.getByRole("button", { name: "Key to the timing tower" });
  const tipText = page.locator("#tip-undercut");
  await expect(tipText).toBeHidden();
  await keyButton.focus();
  await page.keyboard.press("Enter");
  await expect(keyButton).toHaveAttribute("aria-expanded", "true");
  await expect(tipText).toBeVisible();
  await expect(tipText).toContainText(/calibrated model probability/i);
  await page.keyboard.press("Escape");
  await expect(keyButton).toHaveAttribute("aria-expanded", "false");
  await expect(keyButton).toBeFocused();
  await expect(tipText).toBeHidden();
  await expect(page.locator("table.tower tbody .undercut-none, table.tower tbody .flag").first()).toHaveAccessibleDescription(/\w+/);
  await expect(page.getByRole("button", { name: "Key to the alert types" })).toBeVisible();
  await expect(page.getByRole("button", { name: "About the call" })).toHaveAccessibleDescription(/highest calibrated probability/);

  // At least one lap update after the tower filled.
  const lapNow = page.locator(".lc-now");
  const before = (await lapNow.textContent())?.trim() ?? "";
  await expect.poll(async () => (await lapNow.textContent())?.trim(), { timeout: 60_000 }).not.toBe(before);

  // Feature 5 (display only): the new tower columns, the sample's "no sector data" note, real pit
  // counts and the race-status banner (estimated in the sample: no race-control feed).
  const towerHead = page.locator("table.tower thead");
  for (const h of ["Pin", "S1", "S2", "S3", "Trap", "Pits"]) {
    await expect(towerHead.getByRole("columnheader", { name: new RegExp(`^${h}\\b`) })).toBeVisible();
  }
  await expect(page.locator(".tower-best")).toContainText("No sector or speed-trap data for this race");
  await expect(page.locator('table.tower td[data-col="pits"]').first()).toHaveText(/^\d+$/);
  // the race status now lives in the status strip (one band): its code, its source in the title, the lap
  const banner = page.getByRole("region", { name: "Race status" });
  await expect(banner.locator(".race-status-code")).toHaveText(/^(GREEN|SC \/ VSC|UNKNOWN)/);
  await expect(banner.locator(".ss-track")).toHaveAttribute("title", /estimated from lap times/, { timeout: 30_000 });
  await expect(banner).toContainText(/Lap\s*\d+/);
  await expect(banner.locator(".ss-model")).toContainText(/deploy_real_G3\.5_k2/);

  // Columns, keyboard only: the Minimal preset hides S1; pin one car (one at a time).
  const columnsBtn = page.getByRole("button", { name: /^Columns: / });
  await expect(columnsBtn).toHaveText("Columns: Full");
  await columnsBtn.focus();
  await page.keyboard.press("Enter");
  await expect(columnsBtn).toHaveAttribute("aria-expanded", "true");
  const minimal = page.getByRole("radio", { name: "Minimal" });
  await minimal.focus();
  await page.keyboard.press("Space");
  await expect(minimal).toBeChecked();
  await expect(columnsBtn).toHaveText("Columns: Minimal");
  await expect(towerHead.getByRole("columnheader", { name: /^S1\b/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(columnsBtn).toHaveAttribute("aria-expanded", "false");
  await expect(columnsBtn).toBeFocused();
  const pins = page.locator("table.tower tbody .pin-btn");
  const pinRow = page.locator("table.tower tbody tr").nth(4);
  const pinnedId = (await pinRow.getAttribute("data-driver")) ?? "";
  expect(pinnedId).not.toBe("");
  await pinRow.locator(".pin-btn").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`table.tower tbody tr[data-driver="${pinnedId}"]`)).toHaveClass(/is-pinned/);
  await expect(page.locator(`table.tower tbody tr[data-driver="${pinnedId}"] .pin-btn`)).toHaveAttribute("aria-pressed", "true");
  await expect(pins.and(page.locator('[aria-pressed="true"]'))).toHaveCount(1);

  // What-if (S15). Until the viewer picks a car, the attacker follows The Call (polish round): with a call
  // the Attacker is the call's attacker and the Defender its defender, without one it is empty. Which case
  // applies depends on the replay's timing, so each check reads the panel and the call in one snapshot and
  // polls until they agree (both change at each lap). Option labels are "CODE · Name"; the defender is the
  // car directly ahead in the race order, i.e. the option before the chosen one (P2's defender is the leader,
  // who has no option).
  const panel = page.getByRole("region", { name: "What-if: pit strategy" });
  const attacker = panel.getByLabel("Attacker");
  const codeOf = (label: string | null | undefined) => (label ?? "").split(" · ")[0]?.trim() ?? "";
  const snapshot = () =>
    page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>("#whatif select");
      const i = sel?.selectedIndex ?? -1;
      const callCodes = Array.from(document.querySelectorAll("#the-call .call-pair .call-code"), (e) => e.textContent?.trim() ?? "");
      return {
        value: sel?.value ?? "",
        selected: i >= 0 ? (sel?.options[i]?.text ?? "") : "",
        ahead: i >= 2 ? (sel?.options[i - 1]?.text ?? null) : null,
        defender: document.querySelector("#whatif .wi-defender-value")?.textContent?.trim() ?? "",
        call: callCodes.length === 2 ? { attacker: callCodes[0] ?? "", defender: callCodes[1] ?? "" } : null,
      };
    });
  await expect
    .poll(async () => {
      const s = await snapshot();
      if (s.call === null) return s.value === "" ? "ok" : `no call, but the attacker is ${s.value}`;
      const got = `${codeOf(s.selected)}>${codeOf(s.defender)}`;
      return got === `${s.call.attacker}>${s.call.defender}` ? "ok" : `call ${s.call.attacker}>${s.call.defender}, what-if ${got}`;
    }, { timeout: 30_000, intervals: [250] })
    .toBe("ok");

  // An explicit choice: a car other than the call's attacker, with a car ahead that has an option of its own.
  const chosen = await page.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>("#whatif select");
    const callAttacker = document.querySelector("#the-call .call-pair .call-code")?.textContent?.trim() ?? null;
    const options = Array.from(sel?.options ?? []).slice(2);
    return options.find((o) => o.text.split(" · ")[0]?.trim() !== callAttacker)?.value ?? "";
  });
  expect(chosen, "a car in P3 or below that is not the call's attacker").not.toBe("");
  await attacker.selectOption(chosen);
  // the defender follows the car directly ahead of the chosen attacker
  await expect
    .poll(async () => {
      const s = await snapshot();
      if (s.value !== chosen) return `the attacker changed to ${s.value}`;
      if (s.defender === "—" || s.defender === "") return "no defender";
      return s.ahead === null || s.defender === s.ahead ? "ok" : `defender ${s.defender}, car ahead ${s.ahead}`;
    }, { timeout: 15_000, intervals: [250] })
    .toBe("ok");
  // ...and the selection no longer follows The Call: it stays on the chosen car over the next laps
  await expect(panel.locator("#whatif-status")).not.toContainText("preselected from the call");
  const lapAtChoice = Number((await page.locator(".lc-now").textContent())?.trim() ?? "0");
  await expect
    .poll(async () => Number((await page.locator(".lc-now").textContent())?.trim() ?? "0"), { timeout: 30_000, intervals: [500] })
    .toBeGreaterThanOrEqual(lapAtChoice + 2);
  await expect(attacker).toHaveValue(chosen);
  await panel.getByRole("button", { name: "Run what-if" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator("#whatif-status")).toContainText(/from lap \d+/, { timeout: 20_000 });
  const table = panel.getByRole("table");
  for (const name of ["Pit now", "Pit next lap", "Stay out (overcut)"]) {
    await expect(table.getByRole("rowheader", { name: new RegExp(name.replace(/[()]/g, "\\$&")) }).first()).toBeVisible();
  }
  await expect(table.locator("tbody").first()).toContainText(/\d+%|Not possible/);
  await expect(panel).toContainText("Model estimate (calibrated, from the stream");
  await expect(panel).toContainText("Share of sim runs ahead");
  await expect(panel.getByRole("alert")).toHaveText("");

  // Engineer view (display only, Feature 3), during the replay: keyboard tab, a focus driver,
  // three cards, calls labelled as display rules, a lap update, and the lock kept after a reload.
  const raceTab = page.getByRole("tab", { name: "Race", exact: true });
  await raceTab.focus();
  await page.keyboard.press("ArrowRight");
  const engTab = page.getByRole("tab", { name: "Engineer" });
  await expect(engTab).toHaveAttribute("aria-selected", "true");
  const eng = page.getByRole("region", { name: "Engineer view" });
  const focusPick = eng.getByLabel("Focus driver (kept in this browser)");
  await focusPick.focus();
  await page.keyboard.press("ArrowDown"); // P2: a car ahead and a car behind
  const focusId = await focusPick.inputValue();
  expect(focusId).not.toBe("");
  await expect(eng.locator(".eng-card")).toHaveCount(3, { timeout: 20_000 });
  await expect(eng.locator(".eng-card.is-focus")).toContainText(/Focus: P\d+/);
  await expect(eng.getByRole("region", { name: "Strategy calls" })).toContainText("not model output.");
  await expect(eng.getByRole("region", { name: "Pit-rejoin estimate" })).toContainText(/Pit loss [\d.]+ s: /);
  const engLap = eng.locator(".eng-status");
  const lapBefore = (await engLap.textContent()) ?? "";
  await expect.poll(async () => (await engLap.textContent()) ?? "", { timeout: 60_000 }).not.toBe(lapBefore);
  await page.setViewportSize({ width: 375, height: 812 });
  const engOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(engOverflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("tab", { name: "Engineer" }).click();
  await expect(page.getByRole("region", { name: "Engineer view" }).getByLabel("Focus driver (kept in this browser)")).toHaveValue(focusId);
  await page.getByRole("tab", { name: "Race", exact: true }).click();
  await expect.poll(async () => page.locator("table.tower tbody tr").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(20);
  // Feature 5: the preset and the pin are kept in this browser across the reload; then back to Full.
  await expect(page.getByRole("button", { name: /^Columns: / })).toHaveText("Columns: Minimal");
  await expect(page.locator("table.tower thead").getByRole("columnheader", { name: /^S1\b/ })).toHaveCount(0);
  await expect(page.locator(`table.tower tbody tr[data-driver="${pinnedId}"] .pin-btn`)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Columns: / }).click();
  await page.getByRole("radio", { name: "Full" }).check();
  await expect(page.getByRole("button", { name: /^Columns: / })).toHaveText("Columns: Full");
  await page.keyboard.press("Escape");

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
  await expect(tabs).toHaveCount(8);
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
  await expect(page.getByRole("tab", { name: "Telemetry" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
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

test("telemetry: two laps overlaid, crosshair by keyboard, 2024 only", async ({ page, request }) => {
  // Feature 6 (display only). The sample has no telemetry: `make telemetry-trace-sample` builds a
  // SYNTHETIC 2024 R5 fixture table, which the sample-mode API serves.
  const probe = await request.get(`${API}/api/races/2024/5/telemetry/laps?driver=VER`);
  test.skip(probe.status() !== 200, "no telemetry traces in this lake: run 'make telemetry-trace-sample' first");
  const other = await request.get(`${API}/api/races/2023/5/telemetry/laps?driver=VER`);
  expect(other.status()).toBe(404);
  expect(((await other.json()) as { detail: string }).detail).toBe("telemetry traces are available for 2024 only");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/race/2024/5/analysis");
  await page.getByRole("tab", { name: "Tyre strategy" }).focus();
  await page.keyboard.press("End");
  const tab = page.getByRole("tab", { name: "Telemetry" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeFocused();
  await expect(page).toHaveURL(/view=telemetry/);
  const panel = page.getByRole("tabpanel");
  for (const name of ["Lap A (solid line)", "Lap B (dashed line)"]) {
    const lap = panel.getByRole("group", { name }).getByRole("combobox", { name: "Lap" });
    await expect(lap.locator("option:checked")).toContainText("(fastest)");
  }
  await expect(panel.locator(".analysis-notes")).toContainText("SYNTHETIC");
  await expect(panel.locator(".telemetry-summary")).toContainText("At the line");
  await expect(panel.locator(".telemetry-summary")).toContainText("Top speed:");
  await expect(panel.locator(".telemetry-lane")).toHaveCount(7);
  const slider = panel.getByRole("slider", { name: "Crosshair along the lap" });
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  const caption = panel.getByRole("table").first().locator("caption");
  await expect(caption).toContainText("Values at 0 m");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "5");
  await expect(caption).toContainText("Values at 5 m");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "55");
  await page.keyboard.press("End");
  const max = await slider.getAttribute("aria-valuemax");
  await expect(slider).toHaveAttribute("aria-valuenow", max ?? "");
  await expect(slider).toHaveAttribute("aria-valuetext", /m: [A-Z]{3} \d+\.\d km\/h, [A-Z]{3} \d+\.\d km\/h, delta [+−±]\d\.\d{3} s/);
  // pick another lap for B: the URL keeps it and the comparison reloads
  const bLap = panel.getByRole("group", { name: "Lap B (dashed line)" }).getByRole("combobox", { name: "Lap" });
  await bLap.selectOption({ index: 1 });
  await expect(page).toHaveURL(/tblap=\d+/);
  await expect(panel.locator(".telemetry-summary")).toContainText("At the line", { timeout: 15_000 });
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // another season: the note, and no telemetry request at all
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/telemetry/")) asked.push(r.url());
  });
  await page.goto("/race/2023/5/analysis?view=telemetry");
  await expect(page.getByRole("tabpanel")).toContainText("Telemetry traces are available for 2024 races only");
  expect(asked).toEqual([]);
});

test("post-race archive: open the mode by keyboard and scrub the race", async ({ page, request }) => {
  const listing = (await (await request.get(`${API}/api/archive`)).json()) as { races: { season: number; round: number }[] };
  test.skip(
    !listing.races.some((r) => r.season === 2024 && r.round === 5),
    "no post-race bundle for 2024 R5: run 'make archive-sample' (or 'make demo')",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/race/2024/5");

  // Keyboard only: from the Live tab to the post-race mode; the URL records the mode and the lap.
  const live = page.getByRole("tab", { name: "Live" });
  await expect(live).toHaveAttribute("aria-selected", "true");
  await live.focus();
  await page.keyboard.press("ArrowRight");
  const archive = page.getByRole("tab", { name: "Post-race (archive)" });
  await expect(archive).toBeFocused();
  await expect(archive).toHaveAttribute("aria-selected", "true");
  // the archive's status strip (step 4A): the mode chip replaces the old "Post-race (archive)" pill
  const arcStrip = page.getByRole("region", { name: "Race status" });
  await expect(arcStrip.locator(".ss-mode")).toContainText("POST-RACE");
  await expect(page).toHaveURL(/\/race\/2024\/5\?mode=archive&lap=1$/);
  await expect(page.locator("table.tower tbody tr")).toHaveCount(20, { timeout: 15_000 });
  await expect(page.getByText(/SYNTHETIC tyre data/)).toBeVisible();
  // Feature 5 (schema v2 bundle): the race status per lap from the bundle, now in the archive's status strip (the
  // banner is gone): the lap, the track code chip, and the source as visible text; and the pit counts.
  await expect(arcStrip.locator(".ss-lap")).toHaveText(/^Lap\s*1\/56$/);
  await expect(arcStrip.locator(".ss-track .race-status-code")).toHaveText(/^(GREEN|SC \/ VSC|UNKNOWN)/);
  // lap 1: the source is visible text (at lap 1 the sample has too few laps to estimate yet)
  await expect(arcStrip.locator(".ss-rc")).toContainText(/Track status (from the track-status feed|estimated from lap times|not enough laps yet)/);
  await expect(arcStrip).not.toContainText("schema v1");
  await expect(page.locator('table.tower td[data-col="pits"]').first()).toHaveText(/^\d+$/);

  // The slider: arrow keys step one lap, and its value is read as text.
  const slider = page.getByRole("slider", { name: "Lap" });
  await expect(slider).toHaveAttribute("aria-valuetext", "Lap 1 of 56");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "Lap 2 of 56");
  await expect(page.locator(".lc-now")).toHaveText("2");
  await page.getByRole("button", { name: "Next lap" }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Lap 3 of 56");
  await page.getByRole("button", { name: "Previous lap" }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Lap 2 of 56");

  // A marker jumps to its lap (the sample's laps 21-31 are neutralised, estimated from lap times);
  // the markers are one toolbar: End moves to the last one.
  const neutral = page.getByRole("button", { name: /^Lap 21: neutralised \(estimated from lap times\)/ });
  await expect(neutral).toHaveText("N");
  await neutral.click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Lap 21 of 56");
  await expect(page).toHaveURL(/lap=21$/);
  await expect(arcStrip.locator(".ss-lap")).toHaveText(/^Lap\s*21\/56$/);
  await expect(arcStrip.locator(".ss-track .race-status-code")).toHaveText("SC / VSC est.");
  await expect(arcStrip.locator(".ss-rc")).toContainText("Track status estimated from lap times");
  await expect(page.getByRole("toolbar", { name: "Race events: jump to a lap" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.locator(".ac-marker").last()).toBeFocused();
  await page.getByRole("button", { name: /^Lap \d+: \d+ pit stops? / }).first().click();
  const pitLap = Number(await page.locator(".lc-now").textContent());
  expect(pitLap).toBeGreaterThan(0);

  // Play at 60x (one leader lap time per 60, client-side), then pause.
  await page.getByLabel("60×").check();
  await neutral.click();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.locator(".ac-status")).toHaveText("Playing at 60×");
  await expect
    .poll(async () => Number(await page.locator(".lc-now").textContent()), { timeout: 30_000, intervals: [500] })
    .toBeGreaterThan(21);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".ac-status")).toHaveText("Paused");

  // The reload keeps the mode and the lap; then no horizontal page scroll at 375 px.
  const lap = Number(await page.locator(".lc-now").textContent());
  await page.reload();
  await expect(page.getByRole("tab", { name: "Post-race (archive)" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("slider", { name: "Lap" })).toHaveAttribute("aria-valuetext", `Lap ${lap} of 56`);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator("table.tower tbody tr")).toHaveCount(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // Back to Live by keyboard: the live view (and its stream) returns.
  await page.getByRole("tab", { name: "Post-race (archive)" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Live" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/race\/2024\/5$/);
});
