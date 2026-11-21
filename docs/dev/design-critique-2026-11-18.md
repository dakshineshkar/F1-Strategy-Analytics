# Design critique: live race view, 2026-11-18

Input to the full UI redesign of the Pit Wall race view. **No code was changed in this pass.** Every finding below
is a requirement for the redesign, not a fix to apply on the current layout. Product truth comes from
[the product brief](../design/product-brief.md).

**Hard constraint for the redesign:** the Redis key contract in [docs/architecture.md](../architecture.md#redis-serving-servingkeyspy-servingredis_storepy) is off-limits. Every
requirement here must be met in the UI, or through API data that already exists.

## How the review was run

- **Target:** the live race page `/race/2024/5` (source `web/src/app/race/[season]/[round]/page.tsx`,
  `web/src/components/RaceDashboard.tsx`). The race picker `/`, the drivers page, `/race/2024/5/analysis` and
  the post-race archive (`?mode=archive&lap=30`) were checked for consistency only.
- **Stack state:**
  - Full mode (HDFS lake, real timing data), model `deploy_real_G3.5_k2`.
  - A 10x replay of 2024 R5, watched at laps 9–13 (design review) and later (detector).
  - Sample mode was not running, so sample-only labels were judged from the code.
- **Method: two isolated assessments, run in parallel.**
  - **A, design review.** Playwright screenshots and measurements; Nielsen heuristics; cognitive load;
    emotional journey; personas.
  - **B, deterministic evidence.**
    - An automated anti-pattern scan (CLI) of `web/src/app` and `web/src/components`.
    - The `detect.js` overlay injected on 6 pages at 1440×900.
- **Viewports:** desktop **1440×900** and mobile **390×844**, in dark and light themes.
- **Verification:** before the report, three claims were re-checked against the source:
  - the clipped Undercut column (the screenshot shows TRAP as the last visible column);
  - no SMOKE TEST label anywhere in `web/src`;
  - the reducer sets alerts only from `undercut_alert` events.

### Evidence locations

Seven screenshots are committed in [before/](../design/before/) (`docs/design/before/`): `d-dark-fold.png`,
`d-light-fold.png`, `m-dark-fold.png`, `d-dark-whatif.png`, `d-dark-engineer.png`, `d-dark-picker.png` and
`d-dark-analysis.png`. All other screenshots and raw results stayed in a local scratch folder. They are
**not committed and may be cleared** by a reboot. Re-capture them with the scripts listed below if they are gone.

- `A/` = the local scratch folder of assessment A, `critiqueA/shots/`
  (script `../shoot.js`; measurements, Tab walk and layout shift in `A/notes.json`)
- `B/` = the local scratch folder of assessment B, `critiqueB/`
  (script `overlay.js`; raw results `overlay-results.json`, `console-dump.txt`, CLI output `detect.json`)

Files marked "committed copy" are copied unchanged into [before/](../design/before/), so they don't depend on the scratch
folder.

| File | Screen, width, theme |
|---|---|
| [before/d-dark-fold.png](../design/before/d-dark-fold.png) (committed copy of `A/d-dark-fold.png`) | Live race, 1440×900, dark: first viewport |
| `A/d-dark-full.png` | Live race, 1440×900, dark: full page |
| [before/d-light-fold.png](../design/before/d-light-fold.png) (committed copy of `A/d-light-fold.png`) | Live race, 1440×900, light: first viewport |
| `A/d-light-full.png` | Live race, 1440×900, light: full page |
| [before/m-dark-fold.png](../design/before/m-dark-fold.png) (committed copy of `A/m-dark-fold.png`) | Live race, 390×844, dark: first viewport |
| `A/m-dark-full.png` | Live race, 390×844, dark: full page |
| `A/m-light-fold.png`, `A/m-light-full.png` | Live race, 390×844, light |
| [before/d-dark-engineer.png](../design/before/d-dark-engineer.png) (committed copy of `A/d-dark-engineer.png`) | Engineer tab, 1440×1270, dark |
| `A/d-light-engineer.png` | Engineer tab, 1440×900, light |
| [before/d-dark-whatif.png](../design/before/d-dark-whatif.png) (committed copy of `A/d-dark-whatif.png`) | What-if after one run with the default pair, 1040×634 crop, dark |
| `A/d-dark-side.png` | Sidebar (Replay, alerts, Tyres), 1440×900, dark |
| `A/d-dark-tip.png` | Alert-key tooltip on hover, 1440×900, dark |
| `A/d-dark-legend.png`, `A/d-dark-columns.png` | Legend open; Columns panel open |
| `A/d-dark-focus-skip.png`, `-focus-8`, `-focus-20`, `-focus-40` | Keyboard focus at Tab stops 0, 8, 20, 40 |
| [before/d-dark-picker.png](../design/before/d-dark-picker.png) (committed copy of `A/d-dark-picker.png`) | Race picker, 1440×900, dark |
| [before/d-dark-analysis.png](../design/before/d-dark-analysis.png) (committed copy of `A/d-dark-analysis.png`) | Analysis tab, 1440×900, dark |
| `B/live-dark.png`, `B/live-dark-full.png` | Overlay on live race, 1440×900, dark |
| `B/live-light.png`, `B/live-light-full.png` | Overlay on live race, 1440×900, light |
| `B/archive-dark.png`, `B/archive-dark-full.png` | Overlay on post-race archive, 1440×900, dark |
| `B/analysis-dark.png`, `B/drivers-dark.png`, `B/picker-dark.png` | Overlay on analysis, drivers, picker |

## Scores

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | A late joiner sees an empty alert feed beside flagged rows; pipeline status is a 12 px footer line |
| 2 | Match with the real world | 3 | "Opportunity" on 20–32% alerts; two interval sign conventions; raw `global_prior` |
| 3 | User control and freedom | 3 | Defaults pick teammates (what-if) and the leader (engineer) |
| 4 | Consistency and standards | 2 | Solid accent means four things; navigation order differs from analysis; tyres shown twice |
| 5 | Error prevention | 2 | The defender select lists cars behind the attacker; the default pair is excluded by the rule |
| 6 | Recognition over recall | 3 | Alerts are driver codes only |
| 7 | Flexibility and efficiency | 2 | No path from alert to what-if; alerts are about the 50th Tab stop |
| 8 | Aesthetic and minimalist design | 2 | Columns button is the loudest element; 528 px empty what-if; duplicate Tyres panel; 17 "?" buttons |
| 9 | Error recognition and recovery | 2 | "Model: —" unexplained; raw snapshot error text; no guidance on 0% |
| 10 | Help and documentation | 3 | Strong glossary; no hint where the undercut call lives |
| | **Total** | **25/40** | **Acceptable** (first run, no trend) |

- **Cognitive load:** 5 of 8 checks fail (high). Single focus, chunking, visual hierarchy, minimal choices
  and working memory fail. Grouping (with a caveat), one-thing-at-a-time and progressive disclosure pass.
- **Design specificity:** the content is specific to this product (alert pairs, pit-lap timelines, rejoin
  call, causal PB/OB), but the composition is a generic motorsport dashboard. The product's own object, the
  attacker→defender pair with a probability, has no visual form of its own.

## Severity scale

- **P0:** defeats the product's first purpose (the product brief's success #1) in the demo viewport.
- **P1:** breaks trust or a product-truth requirement.
- **P2:** real difficulty or an accessibility failure, with a workaround.
- **P3:** polish.

## Findings

Each finding lists the screen and width where it was seen, the evidence, and the requirement it sets for the
redesign. Line numbers refer to the code at commit `48ee7a2`.

### Call placement and hierarchy

**F01 · P0 · The Undercut % column is cut off on desktop.**
- **Screen:** live race, 1440×900, dark and light.
- **Evidence:**
  - [before/d-dark-fold.png](../design/before/d-dark-fold.png): TRAP is the last visible column.
  - `web/src/app/globals.css:489` `.tower { min-width: 76rem }` (1216 px) sits in a column about 1040 px wide.
  - `A/d-dark-focus-20.png`: the column only scrolls into view when keyboard focus reaches its "?".
- **Requirement:** the undercut probability for every car is visible without horizontal scrolling at 1440 px
  and above. Below that width, it stays next to the driver identity, never at the far right.

**F02 · P0 · The alerts are not where the eye starts.**
- **Screens:**
  - live race, 1440×900: the alerts sit under the Replay box in `.dash-side`;
  - live race, 390×844: the alerts start about 2,766 px down, after the tower, gap chart, empty what-if and
    Replay.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png), `A/d-dark-side.png`, `A/m-dark-full.png`, `A/notes.json` (layout
  boxes); `RaceDashboard.tsx` LiveRaceView renders `<ReplayControl>` before `<AlertFeed>`.
- **Requirement:** the live undercut call (the current alerts or flagged pairs) is in the first viewport at
  both widths. On mobile it comes directly after the race status.

**F03 · P1 · The attacker→defender pair has no visual form of its own.**
- **Screen:** live race, all widths.
- **Evidence:**
  - [before/d-dark-fold.png](../design/before/d-dark-fold.png): the pair shows only as a 4 px yellow inset bar (`globals.css:151`
    `.tower tr.is-flagged .c-pos`) and as text cards in the sidebar.
  - A grader's first read is "timing screen with an undercut column".
  - There is no first-run hint about where the call lives.
- **Requirement:** the redesign gives the pair a primary form:
  - attacker → defender, probability, gap and its trend, which rule checks pass, and an action to simulate
    it;
  - it reads as "undercut detector" from the first viewport;
  - the timing tower becomes supporting evidence.

**F04 · P2 · Too many choices and columns compete at once.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/d-dark-columns.png`, `A/notes.json`.
  - The default "Full" preset shows 14 columns.
  - Decision points with more than 4 visible options:
    - Columns panel: 13 checkboxes and 2 presets;
    - what-if: attacker × defender selects, 19 × 19;
    - gap-chart Highlight: 21 options;
    - Replay: 6 controls.
  - 7 navigation targets in the top 260 px across three layers: Live / Post-race; All races / Drivers /
    Race analysis; Race / Engineer.
- **Requirement:**
  - The default view shows only what the undercut call needs; further columns are opt-in.
  - No more than 4 primary choices at any one decision point.
  - The navigation layers collapse into one clear structure.
- **Analysis (Step 4B):** not reduced. The 8 analysis tabs are distinct views; they wrap rather than scroll on a
  phone.

**F05 · P2 · The accent colour is spent on controls instead of the call.**
- **Screen:** live race, 1440×900, dark and light.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png).
  - Solid accent fills: "COLUMNS: FULL" (`TowerColumns` `.btn`), the selected 10× speed, and Run what-if.
  - The undercut flag gets only a 4 px bar.
  - "COLUMNS: FULL" is the loudest element on the page.
- **Requirement:** solid accent is reserved for the undercut call (flag, alert, live pair). Controls use a
  secondary treatment. A flagged row is unmistakable without depending on colour alone.
- **Analysis (Step 4B, 2026-11-19):** the selected analysis tab and "Show table" were amber (`--accent-ink`).
  They are now text ink: an underline and a chevron. An e2e test checks for no amber on either.

**F06 · P2 · The pipeline layer leads and the race layer follows.**
- **Screen:** live race, 1440×900 and 390×844.
- **Evidence:**
  - `A/d-dark-side.png`: Replay heads the sidebar.
  - Pipeline health is only "N events applied · 0 malformed" in 12 px at the bottom, with no latency.
- **Requirement (the product brief's principle 2):**
  - Replay controls move to a compact demo drawer or strip.
  - Pipeline status becomes a compact status and latency strip, plus a "how it works" panel.
  - Neither sits above the race call.

**F07 · P2 · The Tyres panel duplicates the tower.**
- **Screen:** live race, 1440×900 (about 615 px tall), and 390×844.
- **Evidence:** `A/d-dark-side.png`, `A/d-dark-full.png`; the tower already has Tyre and Age columns.
- **Requirement:** each fact appears once in the default view. The space goes to call-relevant content, for
  example the pairs within 3.5 s.
- **Archive (Step 4A, 2026-11-19):** the archive's Tyres panel is removed (user decision). The tower and the
  alert rows carry the tyres. `TyrePanel` is deleted.

**F08 · P2 · The race page and the analysis page order their navigation differently.**
- **Screen:** live race against `/race/2024/5/analysis`, 1440×900.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png) (Live / Post-race tabs above the breadcrumb); [before/d-dark-analysis.png](../design/before/d-dark-analysis.png)
  (breadcrumb first).
- **Requirement:** one navigation structure, used in the same order on every race page.
- **Archive (Step 4A, 2026-11-19):** the archive head now uses the live order: crumbs, h1, mode tabs, then
  Race analysis and Drivers. A status strip follows. The analysis page keeps its own head until Step 4B.
- **Analysis and drivers (Step 4B, 2026-11-19):** both use `RaceSubHead` (crumbs, h1, then "Live race",
  "Race analysis", "Drivers"), in the live order. Every race page now shares one structure.

### Trust and honesty labels

**F09 · P1 · Fixed (2026-11-19, Step 3) · The alert feed is empty after a late join or a reconnect.**
- **Screen:** live race, every width. Seen at 390×844 at lap 13 ([before/m-dark-fold.png](../design/before/m-dark-fold.png)): the feed was empty
  while the tower showed ▲ flags.
- **Evidence:** `web/src/lib/reducer.ts` sets `alerts` only from SSE `undercut_alert` events (line 338). The
  snapshot restores drivers and order but not alerts.
- **Requirement:**
  - The call area never contradicts the tower.
  - Without alert history, it says so ("No alerts since you opened this page (lap N)") and lists the pairs
    flagged now, from the driver state already received.
  - **Do not add alert history to the snapshot or Redis:** the Redis contract is off-limits.
- **Resolution (2026-11-19, Step 3):**
  - **Step 2c (client):** the pairs flagged now, and "No alerts since you opened this page".
  - **Step 3 (API):** the connect snapshot carries `recent_alerts`, the current API replay run's newest 50
    alerts. They come from the API's own race-channel recorder (`api/lap_log.py`).
    - The stream job and the Redis contract are unchanged.
    - Each item is the live frame with the same `event_id`, and the client deduplicates by that id.
  - **Feed:** the history sits below "Received before you opened the page". It is muted, never "new" and never
    announced.
  - **Tests:** `tests/unit/test_api_alert_history.py`, `tests/integration/test_alert_history_live.py`,
    `web/tests/history.test.ts` and `web/e2e/latejoin.spec.ts`.
  - **Limit:** the history is in memory, so an API restart (which also stops its replays) loses it, and the
    Step 2c text returns.

**F10 · P1 · Fixed (2026-11-19, Step 3) · There is no SMOKE TEST stamp or model identity in the UI.**
- **Screen:** every page, every width. Judged from the code, because the stack ran in full mode.
- **Evidence:**
  - `grep -ri smoke web/src` finds nothing.
  - The health parser in `web/src/lib/api.ts` (around line 196) keeps only `lake` and drops
    `checks.model.model_version`.
  - `DataBanner.tsx` shows only the synthetic-data notice.
- **Requirement:**
  - The UI always shows which model is scoring (version, feature set, G, k).
  - When the sample deployment model is active, it carries a visible SMOKE TEST stamp next to the SYNTHETIC
    DEMO DATA banner.
- **Resolution (2026-11-19):**
  - **Step 2:** model identity from the parsed health check.
  - **Step 3:** `/api/health` `checks.model` adds `smoke_test`, `trained_on`, `model_id` and `stamp`, all
    additive.
  - The UI takes SMOKE TEST from `smoke_test`, and uses the `sample_` prefix rule only when the field is
    missing.
  - **Test:** a contract test (`tests/unit/test_api_health.py`) checks that every pre-existing health field is
    unchanged.

**F11 · P1 · The what-if is presented as calibrated odds.**
- **Screen:** live race, what-if panel, 1440×900.
- **Evidence:**
  - `web/src/components/WhatIfPanel.tsx:158` column header "P(attacker ahead)".
  - The caption reads "Chance the attacker is ahead …".
  - The `whatif` glossary entry gives no calibration caveat (simulator 2025 ECE 0.207 against 0.107 for the
    model).
- **Requirement:**
  - Simulator output reads as a comparison between pit now / next lap / stay out from the same state (for
    example "share of sim runs ahead").
  - The caveat is visible where the numbers are: less well calibrated than the model; not odds.

**F12 · P2 · Unexplained dashes and raw error text.**
- **Screen:** live race, what-if and engineer, 1440×900.
- **Evidence:**
  - [before/d-dark-whatif.png](../design/before/d-dark-whatif.png): "Model (calibrated LR, from the stream): —" with no reason.
  - The snapshot error appears as raw text (from the code).
  - A 0% / 0% / 0% result gets no guidance.
- **Requirement:** every empty or missing value says why ("not a candidate at lap N: teammates", "gap above
  3.5 s"), and every error says what to do next.

**F13 · P2 · Alert labels and strength are misleading.**
- **Screen:** live race, alert feed, 1440×900. Archive, 1440×900.
- **Evidence:**
  - [before/d-dark-fold.png](../design/before/d-dark-fold.png), `B/archive-dark-full.png`: "Opportunity" labels alerts at 20–32%.
  - An 18% Attempt and a 75% Opportunity get the same yellow bar and the same size.
  - No base rate (0.347 on 2025) or uncertainty appears next to the probability.
- **Requirement:**
  - Alert type and strength are visually distinct.
  - The words match the meaning (a low-probability new candidate is not presented as an opportunity).
  - The probability is shown with its context (base rate, calibration).
- **Archive (Step 4A, 2026-11-19):** the archive feed uses the redesigned feed with both cars' tyres. Amber
  appears only on alerts from the scrubbed lap or the one before (none after the finish), and the alert markers
  are neutral.

### Exploration flow (what-if and engineer)

**F14 · P2 · There is no path from an alert to the what-if.**
- **Screen:** live race, 1440×900 and 390×844.
- **Evidence:** to simulate an alert pair you must remember it, scroll past the gap chart and pick both cars
  again in two selects (`A/d-dark-full.png`).
- **Requirement:** opening an alert or a pair leads straight to its what-if, with the pair filled in. The
  what-if is a consequence of the call, not a separate form.

**F15 · P2 · The default what-if pair produces a result that looks broken.**
- **Screen:** live race, what-if, 1440×900.
- **Evidence:** [before/d-dark-whatif.png](../design/before/d-dark-whatif.png): the default is P2→P1, PER→VER, teammates 8 s apart, giving
  0% / 0% / 0% and "Model: —".
- **Requirement:** never default to a pair the rule excludes. Default to the newest alert pair, or show
  nothing until a pair is chosen.

**F16 · P2 · The defender select allows invalid pairs.**
- **Screen:** live race, what-if, 1440×900.
- **Evidence:** "Defender (car ahead)" lists every car, including cars behind the attacker.
- **Requirement:** the defender choices are limited to valid pairs (car ahead, not a teammate), or the
  reason a pair is invalid is shown before running.

**F17 · P2 · The what-if empty state wastes space.**
- **Screen:** live race, 1440×900 (528 px reserved) and 390×844.
- **Evidence:** `A/d-dark-full.png`, `A/m-dark-full.png`: "No simulation yet." in an empty box.
- **Requirement:** before a run, the panel stays compact or shows the structure of the result (three strategy
  rows), and still reserves its size so nothing shifts later.

**F18 · P2 · The what-if text uses two sign conventions and leaks internal tokens.**
- **Screen:** live race, what-if, 1440×900.
- **Evidence:** [before/d-dark-whatif.png](../design/before/d-dark-whatif.png): "10.1 s behind" next to an interval "−14.3 to −6.4 s"; pit-loss
  source shown as raw `global_prior`.
- **Requirement:** one ahead/behind wording for every gap and interval, and plain-language labels for every
  internal value.

**F19 · P2 · The engineer view defaults to the leader.**
- **Screen:** live race, Engineer tab, 1440×900.
- **Evidence:** [before/d-dark-engineer.png](../design/before/d-dark-engineer.png): focus is P1, so "Ahead" is empty and the probability is "not
  evaluated".
- **Requirement:** the engineer focus defaults to a car in a live pair (for example the newest alert's
  attacker), and follows the selection made from the call.
- **Resolution (Step 2 + 4A):**
  - the focus follows the call's attacker (Step 2);
  - with nothing locked and no call it defaults to P2, so "Ahead" is never empty (`pickFocus`, 4A).

**F20 · P3 · The engineer rejoin strip labels overlap.**
- **Screen:** live race, Engineer tab, 1440×900.
- **Evidence:** [before/d-dark-engineer.png](../design/before/d-dark-engineer.png): "LE|PIA", "SAI/ALO" collide.
- **Requirement:** rejoin markers never overlap; close cars are offset or grouped.
- **Fixed (Step 4A, 2026-11-19).** The rejoin bar is a seconds axis:
  - car codes are placed in lanes that never overlap (`rejoinLanes`; e2e checks the label boxes);
  - the rejoin slot is an authored triangle with its word, in its own row.

**F21 · P3 · The engineer sparkline floats away from its sentence.**
- **Screen:** live race, Engineer tab, 1440×900.
- **Evidence:** [before/d-dark-engineer.png](../design/before/d-dark-engineer.png).
- **Requirement:** each small chart sits directly with the statement it supports.
- **Fixed (Step 4A, 2026-11-19).** Each pair is a two-column row: a sentence capped at a reading measure, then
  the sparkline directly after it, top-aligned. The e2e checks the same row. With no laps it says why.

**F22 · P3 · Alerts show driver codes only.**
- **Screen:** live race, alert feed, 1440×900.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png): "SAI → RUS" with no tyre, age or trend; you have to find both cars in
  the 20-row tower.
- **Requirement:** the call shows the context it rests on (tyres and age of both cars, gap trend) where the
  call is shown.

### Live states and journey

**F23 · P2 · Session end is flat.**
- **Screen:** live race, every width. Judged from the code; not seen live.
- **Evidence:** only the connection indicator changes to "■ Closed (session ended)"; there is no summary and
  no link to the archive.
- **Requirement:** session end shows a short race summary (alerts fired, attempts and their outcomes) and a
  link into the post-race archive for that race.

**F24 · P3 · The gap chart misrepresents its own history.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/d-dark-full.png`:
  - the x-axis starts at lap 1, but data exists only since page load;
  - about 10 line-end labels stack at the bottom;
  - the "16s"/"52s" y-labels collide with the lap "1" x-label;
  - history resets on reload.
- **Requirement:**
  - The chart's x-axis starts at the first lap it has data for, or says the history starts at page load.
  - Labels never overlap.

**F25 · P3 · Layout shift during streaming.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/notes.json`: cumulative layout shift about 0.11 over about 20 s. The sources are tower
  row reorders (inherent) and alert cards inserted at the top of the feed.
- **Requirement (the product brief's principle 4):** new alerts never move content the viewer is reading. Keep the
  scroll position anchored, or insert into reserved space.

**F26 · P3 · Alert meta text wraps mid-phrase.**
- **Screen:** live race, alert feed, 1440×900.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png): "gap / +0.443" breaks across lines.
- **Requirement:** a value never breaks from its label.

**F27 · P3 · The "Best so far" line floats.**
- **Screen:** live race, 1440×900.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png): a gap of about 60 px above it, between the Columns button and the tower.
- **Requirement:** consistent vertical rhythm; session bests belong to the tower they describe.

**F28 · P3 · The status banner is tall on mobile.**
- **Screen:** live race, 390×844.
- **Evidence:** [before/m-dark-fold.png](../design/before/m-dark-fold.png): about 102 px tall, with its "?" orphaned on its own line.
- **Requirement:** the race status fits a compact single band on mobile.

### Accessibility and typography

**F29 · P2 · The tower header is broken.**
- **Screen:** live race, 1440×900, dark and light.
- **Evidence:** [before/d-dark-fold.png](../design/before/d-dark-fold.png): the header renders "POS ?N ?RIVER ? ?", because
  `globals.css:490` `.tower .c-pin { width: 2.6rem }` cannot fit "Pin" plus its InfoTip.
- **Requirement:** header labels and their help buttons never overlap at any width.

**F30 · P2 · The help buttons are too small and too close together.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/notes.json`: InfoTip targets are 17.6×17.6 px, with adjacent pairs about 8 px apart (the
  Driver header "? ?"). This likely fails WCAG 2.2 SC 2.5.8 (target size). 17 "?" buttons are on the page.
- **Requirement:**
  - Every interactive target meets 24×24 px or the spacing exception of SC 2.5.8.
  - Help is grouped (for example per panel or in the legend) instead of one button per header.

**F31 · P2 · About 50 Tab stops before the call.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/notes.json` (Tab walk), `A/d-dark-focus-8.png`, `-20`, `-40`: 13 header InfoTips, then 20
  pin buttons, then the what-if and Replay, then the alerts.
- **Requirement:** the call is among the first focus targets after the skip link, and a skip link or landmark
  leads straight to it.

**F32 · P2 · The alert-legend tooltip runs off the screen.**
- **Screen:** live race, 1440×900.
- **Evidence:** `A/d-dark-tip.png`: the start-aligned Opportunity tooltip at about x 1355 appears to run off
  the right edge.
- **Requirement:** tooltips and popovers flip or clamp to stay inside the viewport.

**F33 · P2 · Text below 11 px.**
- **Screens:** live race, 1440×900, dark and light; archive, 1440×900.
- **Evidence:**
  - Detector `undersized-ui-text`: 10 hits on live dark (`B/live-dark.png`), plus more on light; 55 on the
    archive (`B/archive-dark-full.png`).
  - Sources in `globals.css`:
    - line 183, `.badge` 0.68rem (10.88 px, the Opportunity and Attempt badges);
    - line 495, `.tag.mark` 0.6rem (9.6 px, PB and OB);
    - "IN PIT" at 10.88 px.
  - Not flagged by the detector but also too small: `.tag-used` 0.62rem, `.chart-label` 10.5 px.
- **Requirement:** no text below 11 px anywhere. Badges stay legible at the long-feed density of the archive.
- **Archive, engineer, picker (Step 4A):** every size is a `--fs-*` token, with an 11 px floor.
- **Analysis, telemetry, drivers (Step 4B):** every size is an `--fs-*` token, and SVG text is 11 px or larger.
  An e2e test checks that every chart label lies inside its chart at 1440 and 390 px.

**F34 · P2 · The race-picker search placeholder fails contrast.**
- **Screen:** race picker `/`, 1440×900, dark.
- **Evidence:** `B/picker-dark.png`: detector `low-contrast`, placeholder "e.g. Monaco, 2023, r5" at 3.8:1,
  #757575 on #141920. There is no `::placeholder` rule, so the browser default is used. `web/tests/theme.test.ts`
  checks only token pairs.
- **Requirement:**
  - Placeholder and every other text colour come from contrast-tested tokens, at 4.5:1 or better.
  - The contrast tests cover them.

**F35 · P3 · The accent left bar is used as decoration.**
- **Screens:** live race (alerts), archive, analysis race control, engineer, picker.
- **Evidence:** detector `side-tab`. These cases use the accent bar for emphasis only:
  - `globals.css:468` `.arc-key`;
  - `:388` `.rc-list li.is-key`;
  - `.alert-attempt` on `:177` `.alert`.
- **Fixed (Step 4A, 2026-11-19):** there are no side bars on the engineer calls, the archive race-control rows or
  the analysis race-control rows. the anti-pattern scan reports 0 findings and nothing is suppressed (see
  inventory.md).

  `:101` `.race-link` and `:426` `.eng-calls li` are borderline (neutral by default).
- **Requirement:** a left bar is used only where it carries meaning by shape. Emphasis uses other means.

### Entry and wayfinding

**F36 · P3 · The race picker has no entry point for the demo.**
- **Screen:** race picker `/`, 1440×900.
- **Evidence:** [before/d-dark-picker.png](../design/before/d-dark-picker.png): 90 cards of equal weight.
- **Requirement:** the picker offers a clear first choice for a grader (the demo race, or the race currently
  replaying) above the full list.
- **Fixed (Step 4A, 2026-11-19).** A "Start here" card sits above the search. It offers the race replaying now,
  else the `make demo` race (2024 R5), else the newest race, with links to the race and its post-race archive. It
  is neutral (no amber).

### To investigate before the redesign (possibly not a design issue)

**F37 · Fixed (client reducer bug, not data) · The order and the per-car data may disagree mid-lap.**
- **Cause:** the snapshot gave the rows no lap, so `liveOrder` sank every car that crossed before the page
  opened (or reconnected) below the cars whose lap frames arrived later.
- **Screen:** live race, 1440×900, lap 10.
- **Evidence:** in the design review's lap-10 capture, P17–P20 (PIA, LEC, RUS, SAI) showed gaps of +15–18 s
  and intervals of 1.0–1.5 s while P16 was at +57 s. Seconds later they were P5–P8.
- **Requirement:**
  - Confirm whether `race:{s}:{r}:order` and the driver hashes are briefly inconsistent within a batch, or
    whether the UI applies them out of order.
  - The redesign must never show a tower that contradicts its own gaps.
  - If the cause is server-side, fixing it must not change the Redis contract.
- **Resolution (2026-11-18):** Redis was consistent: a client connected from the start matched the zset after
  446 of 446 batches. The fix is in `web/src/lib/reducer.ts` only:
  - the snapshot now gives each car its latest lap (from the timing hash, else the tyre hash);
  - the snapshot's zset ranks every crossing it already holds;
  - crossings that arrive later follow, by crossing time.

  Tests: `web/tests/reducer.test.ts` and `web/tests/f37.test.ts`. Nothing changed in the Redis contract, the
  API or the stream job. See F38 for the display issue that remains.

### Found while fixing F37

**F38 · P2 · Mark cars still on the previous lap so cross-lap gap inversions read correctly.**
- **Screen:** live race, 1440×900, any lap while the leaders cross the line.
- **Evidence:** the F37 tower after the fix (2024 R5, lap 10) is ordered correctly:
  - P4 ALO shows +15.698 s, measured at lap 10;
  - P5 PIA shows +15.396 s, measured at lap 9, because PIA has not yet crossed lap 10.

  Each gap is measured at the car's own latest lap, so a correct order can show a smaller gap below a
  larger one until the car behind crosses the line.
- **Requirement:** the tower marks rows whose latest lap is behind the leader's (for example, a quiet "L9"
  tag, or a muted gap), and the gap's tooltip says which lap it was measured at. The marker must not read as
  "lapped" (the tower's lapped cue stays separate).

## Detector findings judged false positives (no requirement)

- **`side-tab` on `.race-status`** (`globals.css:512`, `:526`; every race page). The border style is solid,
  dashed (VSC), dotted (neutralised) or double (red). It carries the track status as a shape, so colour is not
  the only signal (`globals.css:521`). Keep that property in the redesign.
- **`cream-palette` on the light theme body** (`#f3f0e8`). This is the intended "printed timing sheet" theme
  (`web/src/lib/theme.ts`).
- **`side-tab` on flagged rows** (`th.c-pos`, ×13–14 on the live page). This is a functional row-state marker,
  not decoration. The design review's issue is the opposite: it is too weak (see F03, F05).
- **Tabular monospace figures:** not flagged by either tool, and intentional for a timing screen.

## What the redesign must keep

These work and are requirements too:

1. **One glossary for all explanations** (`web/src/lib/legend.ts` feeds the legend and every InfoTip). The
   wording states its limits: the flag tip quotes the rule (within 3.5 s, not teammates, green lap), PB/OB use
   only completed laps, and engineer calls are "display rules … not model output".
2. **A stable live layout:** fixed 32 px rows, space reserved for 22 rows, tabular monospace figures, and
   reserved panel sizes.
3. **Never colour alone:** tyre compounds are a glyph plus text, team badges are text codes (no F1 marks),
   and track status is shown by border style.
4. **Both themes:** dark "carbon pit wall" and light "paper timing sheet", both contrast-tested.
5. **Strategist vocabulary and depth:** what-if pit-lap timelines, the sensitivity block ("defender covers 2
   laps later"), the 80% interval, pit-loss source, n and seed; the engineer Ahead/Focus/Behind cards and the
   rejoin call.
6. **Accessibility already in place:** the skip link, the filtered polite `aria-live` alert region, the
   hidden data table behind the gap chart, and a screen-reader sentence per tower row.
7. **The analysis page's quality:** the tyre-strategy chart and the consistent type and colour (the detector
   found nothing there).

## Not covered by this review

These states did not occur during the review window, or need sample mode. The redesign must design them
explicitly, and the next critique must check them live:
- reconnecting and error states;
- session end (F23);
- SC, VSC and red flag;
- DNFs and lapped cars in the call area;
- sample mode with the SYNTHETIC DEMO DATA banner and the SMOKE TEST stamp (F10);
- the Engineer view with an alert pair as focus;
- the analysis tabs other than Tyre strategy.
