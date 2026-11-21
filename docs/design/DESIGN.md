# Pit Wall design system

The design system of the Pit Wall dashboard (redesigned 2026-11-18). Product truth is in
[the product brief](product-brief.md); the problems this system answers are in
[the design critique](../dev/design-critique-2026-11-18.md); the screens and states it covers are in
[the UI inventory](../dev/design-inventory.md).

**One source of truth:** every colour, size, radius, duration and easing below is defined once, in
[`web/src/lib/theme.ts`](../../web/src/lib/theme.ts). That module emits the CSS custom properties (`themeCss`,
injected in `web/src/app/layout.tsx`) and feeds the contrast tests (`web/tests/theme.test.ts`) and the report
script (`web/scripts/contrast-report.mjs`). No component or stylesheet may use a literal colour.

## Concept: "Pit wall"

A precise, dense, calm engineering instrument with **one loud element: the undercut call**.

- **The call leads.** The attacker → defender pair, its calibrated probability and the reasons behind it are
  the only object in the signal colour. The timing tower, the alert feed and the what-if are its evidence.
- **Calm under streaming.** Values change; layout never does. Rows have a fixed height, panels reserve their
  size, figures are tabular, and nothing moves that the viewer did not ask to move (except the FLIP move of a
  tower row that changed position).
- **Not broadcast glitz, not a generic SaaS dashboard.** No gradients, glows, glass, hero numbers, KPI tile
  walls or decorative motion. Density is the design; restraint is how the signal stays loud.
- **Operate mode.** Standard controls (buttons, native radios and selects, tabs, disclosures), one top bar,
  familiar table conventions. The world shows only in type, palette, density and one signature move, the
  gap-against-pit-loss gauge in the call.

## Type

Three self-hosted families, loaded with `next/font/local` from `web/src/fonts/` (Latin subset, normal style
only, `font-display: swap`; no request leaves the machine, so the demo works offline). Each family's SIL Open
Font License is beside its files (`OFL.txt`); see `web/src/fonts/README.md`.

| Family | Role | Weights | CSS variable |
|---|---|---|---|
| Barlow Semi Condensed | UI: the tower, headings, labels, buttons, chips | 500, 600, 700 | `--font-ui` |
| Barlow | Body text: notes, explanations, the what-if caveat | 400, 500 | `--font-body` |
| IBM Plex Mono | **Every live number**: gaps, intervals, lap times, probabilities, laps, positions | 400, 500, 600 | `--font-num` |

- Numbers always use `font-variant-numeric: tabular-nums` and Plex Mono, so a changing value never changes
  width.
- The Latin subset has no `→ ▲ ▼ ≥` glyphs. Arrows, the flag mark and comparison signs are authored SVG or
  plain words ("at least"), never a fallback system font.
- Labels and table heads are sentence case, untracked; the only capitals are the product's honesty stamps
  (SMOKE TEST, SYNTHETIC DEMO DATA) and standard racing abbreviations (SC, VSC, PB, OB).

**Scale** (fixed, not fluid; ratio about 1.15). 11 px is the floor for any text. Headings: h1 20 px,
h2 `--fs-lg` (16 px) and h3 `--fs-md` (14 px) on every screen (an earlier layout had h3 at 12, 13 or 14 px). The legend's
"How to read this" is its own h2, so its group h3s nest under it.

| Token | Size | Use |
|---|---|---|
| `--fs-2xs` | 11 px | units, captions, chip text |
| `--fs-xs` | 12 px | table heads, secondary labels |
| `--fs-sm` | 13 px | tower cells, alert rows, status strip |
| `--fs-md` | 14 px | body text, controls |
| `--fs-lg` | 16 px | panel titles |
| `--fs-xl` | 20 px | the call's pair |
| `--fs-2xl` | 28 px | the call's probability |

## Colour

**Strategy: restrained.** Graphite neutrals (hue 255, chroma ≤ 0.014) carry the chrome, so team colours,
which are data, stay readable. One signal amber is reserved for the live undercut call and the alerts. Gain is
blue and loss is orange: a colourblind-safe pair, never red/green, and always with a sign, an arrow or a word.

- **Dark is primary**, and the default whatever the OS says. Light is the same system re-derived (not an
  inversion) and passes every check. A Dark / Light / Auto switch in the top bar sets `html[data-theme]`; Auto
  follows `prefers-color-scheme`. The choice is kept per browser (`localStorage` key `f1sa.theme`, read
  inside try/catch; blocked storage falls back to dark) and applied by an inline script before the first
  paint, so there is no flash. Without JavaScript the page is dark.
- **OKLCH with hex fallbacks.** Each colour is authored in OKLCH; `oklchToHex()` derives its hex, and the CSS
  declares both (`--x:#hex;--x:oklch(…);`), so a browser without OKLCH keeps the hex. Every colour is inside
  the sRGB gamut (tested), so the two are the same colour.
- **The amber is reserved.** It appears only on the call (its solid fill only on "Simulate this pair"), the
  call's two rows in the tower, and alerts from the leader's lap or the one before (other flagged rows
  and older alerts are neutral). In the post-race archive, "the leader's lap" is the scrubbed lap: the
  archive feed marks alerts from that lap or the one before, and none after the finish. The archive's slider and
  event markers, the engineer view and the race picker never use it. Focus rings, buttons, selected controls, links and chart series never use it.
  No chart line has an amber hue (60–100°, tested).
- **Team colours are data only:** a small swatch with the team's text code, never a background, a border
  theme or a brand treatment.
- **No legacy names.** The old aliases (`--accent`, `--accent-ink`, `--accent-bg`, `--ok`,
  `--warn`, `--info`, `--banner-bg`, `--banner-ink`, `--bar`) and the `--radius` / `--gap` shorthands are removed
  from `theme.ts` and `globals.css`. The race analysis, telemetry, drivers views and the data banner were the last
  readers. The test `web/tests/legacy-tokens.test.ts` fails if any source file reads one again or the theme
  emits one.

### Roles

| Role | CSS variable | Dark: OKLCH | Dark: hex | Light: OKLCH | Light: hex |
|---|---|---|---|---|---|
| bg | `--bg` | `oklch(16.5% 0.008 255)` | `#0c0f12` | `oklch(95.5% 0.004 255)` | `#eef0f3` |
| surface | `--surface` | `oklch(20% 0.009 255)` | `#13161a` | `oklch(99% 0.002 255)` | `#fbfcfd` |
| surface2 | `--surface-2` | `oklch(23.5% 0.01 255)` | `#1b1e23` | `oklch(93% 0.005 255)` | `#e6e8eb` |
| raised | `--raised` | `oklch(27% 0.011 255)` | `#23272c` | `oklch(90.5% 0.006 255)` | `#dde0e4` |
| rule | `--rule` | `oklch(33% 0.012 255)` | `#31363c` | `oklch(85% 0.007 255)` | `#cbced2` |
| border | `--border` | `oklch(60% 0.014 255)` | `#7b8189` | `oklch(56% 0.014 255)` | `#6f757d` |
| text | `--text` | `oklch(94.5% 0.005 255)` | `#ebedf0` | `oklch(22% 0.012 255)` | `#171b20` |
| muted | `--muted` | `oklch(79% 0.012 255)` | `#b5bbc2` | `oklch(42% 0.014 255)` | `#484e55` |
| faint | `--faint` | `oklch(72% 0.014 255)` | `#9fa5ad` | `oklch(48% 0.014 255)` | `#585e66` |
| signal | `--signal` | `oklch(82% 0.155 80)` | `#f8b734` | `oklch(82% 0.155 80)` | `#f8b734` |
| signalOn | `--signal-on` | `oklch(20% 0.03 80)` | `#1d1406` | `oklch(20% 0.03 80)` | `#1d1406` |
| signalInk | `--signal-ink` | `oklch(84% 0.15 82)` | `#fbc044` | `oklch(50% 0.1 70)` | `#875814` |
| signalMark | `--signal-mark` | `oklch(82% 0.155 80)` | `#f8b734` | `oklch(60% 0.12 86)` | `#a07a0c` |
| signalWash | `--signal-wash` | `oklch(28.5% 0.05 78)` | `#382709` | `oklch(94% 0.06 88)` | `#fceabe` |
| gain | `--gain` | `oklch(76% 0.12 245)` | `#6bb9f8` | `oklch(48% 0.13 250)` | `#0c60a3` |
| loss | `--loss` | `oklch(71% 0.165 36)` | `#f67654` | `oklch(49% 0.16 38)` | `#a73301` |
| focus | `--focus` | `oklch(93% 0.04 215)` | `#cbeff9` | `oklch(32% 0.08 255)` | `#13335a` |
| danger | `--danger` | `oklch(72% 0.16 22)` | `#f97676` | `oklch(50% 0.18 27)` | `#b32322` |
| grid | `--grid` | `oklch(55% 0.012 255)` | `#6d7279` | `oklch(58% 0.012 255)` | `#767b81` |

| Line | Dark | Light |
|---|---|---|
| `--line-0` | `oklch(66% 0.115 215)` `#0ca3be` | `oklch(60% 0.15 150)` `#25984d` |
| `--line-1` | `oklch(66% 0.15 135)` `#68a63f` | `oklch(48% 0.15 255)` `#0e5caf` |
| `--line-2` | `oklch(54% 0.15 40)` `#b4481e` | `oklch(60% 0.15 295)` `#886acf` |
| `--line-3` | `oklch(54% 0.15 320)` `#944da4` | `oklch(48% 0.15 15)` `#a02d41` |

**Four line colours, never cycled.** Four is the largest set that passes the dataviz
validator on *all* pairs in each theme: a lap-times chart can hold any of the drivers, so any two colours can
meet. The earlier ten-colour set passed only on adjacent pairs; on all pairs it failed in both themes (two
greens ΔE 3.9 apart, violet against blue ΔE 2.0 under deuteranopia), and no swap of its three violets
cleared it.
- A fifth series and beyond is drawn in the neutral `--grid` with its dash pattern and its end label
  (`seriesColour` in `web/src/lib/chart.ts`).
- No view that shows team colours uses a line colour:
  - the positions chart is team colours only, and a car without one is neutral;
  - the gap chart is neutral in both the live view and the archive (the highlighted car in the text colour,
    the live call's pair in signal and text);
  - the telemetry overlay is team colours only. A car without one is drawn in neutral **text ink**, never
    `--line-0` or `--line-1`. A is solid and B dashed whatever the colours. The legend says
    "similar colours: tell them apart by the line style" when the two strokes are under ΔE 15 with normal vision
    or under ΔE 8 with protanopia or deuteranopia, in either theme (`strokesClose` in `lib/telemetry.ts`,
    `deltaE` in `lib/theme.ts`). See [the validator run](#palette-validator-dataviz-validate_palettejs).
- **Violet is a data colour only:** `--line-3` dark and `--line-2` light. It is never chrome, a button or a focus
  state. It appears only in the lap-times chart, which shows no team colours.
- **OB has no hue.** The OB tag was violet (`--best`). No colour clears, in the dark theme, all of these at
  once: PB blue, the compounds and every 2021–2024 team colour (ΔE 15 normal vision, 6 colour-blind with its
  letters). The best found was ΔE 10.9. The tag is now text ink with a 2px outline and bold letters. PB is now
  the quiet tag: gain-blue letters, no outline, normal weight. OB against PB is now ΔE 21.7 normal and 18.0 colour-blind in dark (it was 12.1 and
  2.1), and 28.6 and 27.5 in light (it was 14.4 and 0.7). An outlined two-letter tag does not read as a team
  badge, which is a filled swatch with a three-letter code.

| Compound | Dark | Light |
|---|---|---|
| soft | `oklch(69% 0.199 25.5)` `#ff5c57` | `oklch(53% 0.207 22.3)` `#c8102e` |
| medium | `oklch(93% 0.14 110)` `#edf07b` | `oklch(50% 0.1 100)` `#71640b` |
| hard | `oklch(95.7% 0.006 255)` `#eef1f5` | `oklch(44.5% 0.023 255)` `#4b5561` |
| inter | `oklch(76.5% 0.172 152)` `#46d17a` | `oklch(48.1% 0.118 151.5)` `#16703a` |
| wet | `oklch(72.2% 0.148 252)` `#59a9ff` | `oklch(46.5% 0.146 254.8)` `#0a58a8` |
| unknown | `oklch(76.3% 0.021 255)` `#a9b3c0` | `oklch(50.6% 0.022 83)` `#6b6457` |

## Space, radii, elevation

- **Spacing:** a 4 px grid: `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 20, `--sp-6` 24,
  `--sp-8` 32, `--sp-10` 40 px. Tight inside a group, wider between groups, more space above a heading than
  below it.
- **Tower rows:** `--row-h` 28 px, fixed (every control in a row is still at least 24 px). Space is reserved
  for the race's field (`--tower-rows`: the entrants count, at least 20), so the panel has no empty strip and a
  car joining the tower never moves the panels below. At 1440×900 the tower's table ends at 799 px.
- **Radii** (small, technical): `--radius-sm` 2 px (chips, bars, the gauge track), `--radius-md` 4 px (controls,
  panels), `--radius-lg` 6 px (popovers). One radius per nesting level; a panel inside a panel is not allowed.
- **Elevation** (minimal): surfaces step lighter on dark (`bg` → `surface` → `surface-2` → `raised`) and are
  separated by 1 px hairlines (`--rule`). The only shadow is `--elev-pop` on popovers (tooltips, the keys,
  the Columns panel): a 1 px ring of `--rule` plus a soft drop in light; in dark, the ring
  and a lighter surface only (a drop shadow on dark reads as glow).

## Motion

Motion conveys state, never decoration.

- **Durations:** `--dur-fast` 120 ms (hover, press), `--dur-base` 160 ms (disclosures, chips),
  `--dur-slow` 200 ms (the tower's FLIP move). **Nothing runs longer than 200 ms.**
- **Easing:** `--ease-out` `cubic-bezier(0.22, 1, 0.36, 1)` for anything entering or settling;
  `--ease-in-out` `cubic-bezier(0.65, 0, 0.35, 1)` for a value moving along a track.
- **Tower position changes are FLIP moves.** When a car changes place, its row is measured before and after
  the reorder, inverted with a `transform` before paint, then played back to zero with the Web Animations API.
  The row's layout box moves once, instantly; only its painted image travels, so nothing else on the page is
  displaced.
- **Only `transform` and `opacity` animate.** Never `width`, `height`, `top`, `left`, margins or
  `transition: all`. Bars that show a value (the gauge marker, range bars) move with `transform`.
- **New alerts never move what the viewer is reading.** The feed is a reserved, scrollable list of fixed-height
  rows that always ends on a whole row (the list is as tall as the rows that fit; a "N more below" footer scrolls
  it); a row that moves because a newer alert arrived slides there (the same FLIP, uncapped inside the list's own
  box), and the browser's scroll anchoring keeps the position when the viewer has scrolled. The tower's FLIP is
  capped at 8 rows (a longer move jumps).
- **The call keeps its height while a replay streams.** A call appearing or disappearing never moves the feed:
  without a call the panel holds the closest pair. It shrinks to one line only when nothing streams (no replay,
  no lap yet) or after the finish.
- **Values never move their neighbours.** The gauge marker, tick and window move by `transform`; changing
  values sit in fixed, left-aligned slots (the status strip's cells, the call's blocks, the alert fields).
  Measured over 20 s of a 10× replay (`web/e2e/race-layout.spec.ts`): no layout-shift entry outside the
  tower's rows; total CLS 0.001–0.0075, all from tower reorders.
- **`prefers-reduced-motion: reduce` turns all of it off:** no transitions, no FLIP, no smooth scrolling.
  Values still update instantly.
- No load sequences, no staggered entrances, no pulsing or blinking (a new alert is marked by position, text and
  a static "new" mark, not by animation).

## Components of the live race view

| Component | Rules |
|---|---|
| **Theme switch** | Dark / Light / Auto in the top bar: a native radio group named "Theme" (arrow keys), no animation. |
| **Status strip** | One band under the top bar, always visible on race pages, shared by the Race and Engineer tabs. Mode chip (REPLAY 10×, PAUSED, STOPPED, FINISHED, LIVE, or NOT REPLAYING: nothing streams and the page holds the state an earlier run left in Redis, for example after an API restart), SMOKE TEST and SYNTHETIC DEMO DATA stamps when they apply, race, lap n / N, the leader's lap progress ("2 of 20 crossed": running cars that crossed the line on the leader's lap), track status, the scoring model's id, the connection state, and last the replay transport (below). Values are separate cells, never a dot-joined string. The model's detail (features, G, k) is the cell's tooltip and screen-reader text (the call shows it in full). The strip has one height in every replay state at a given width: one line at 1280 px and wider (below 1440 px the gaps narrow, the "Model" key word is visually hidden and the connection reads "Connected"); below about 1180 px the transport takes the strip's second line, right-aligned; on a phone the race head and the strip wrap and never scroll sideways or cut a value: the head is the race's name and the page links, then the mode and view tabs; the strip is the race state (mode, lap, track), then the progress, the model id and the connection, then the transport on its own full-width line. Some labels take a short form on a phone ("Analysis", "Connected"; the "Model" key word is visually hidden), and the full text stays the accessible name. The mode chip is not a live region: the transport's one hidden polite region announces each change. The call starts within 250 px at 390×844 (236 px on the full lake, in every replay state). The sample deployment's stamps (SMOKE TEST in the strip, the SYNTHETIC DEMO DATA notice, which wraps rather than being cut) add a line each, so there the budget is 290 px (272 px measured). |
| **Replay transport** | Inline at the strip's right end, always visible, never over the page (it replaced a popover that covered the call; 2026-11-21). Phases: idle, "Start replay" and the 1×/10×/60× speed as a segmented native radio group (legend "Replay speed", visually hidden); blocked, the same Start disabled with why as visible text ("Another race is replaying", "Replay disabled on the API"); running or paused, Pause or Resume (one button), Stop and the speed (a change sets the replay's speed); finished, stopped or failed, "Replay again" (the last run's speed, named in its description; the speed radios return once it runs, so another speed is one more press) and "Open the post-race archive". Start and Replay again are the strong neutral control (2 px text ink), never amber. Every button has an authored icon (decorative) and visible text. **Stop is irreversible:** the first press turns it into "Confirm stop" (2 px `--danger` border, a hidden hint "press again to confirm, Escape to cancel") for about 4 s; Escape, the timeout, or the replay finishing or failing on its own cancels it and nothing is sent; the second press stops. No modal, alert or `confirm()`. Each phase keeps the same reserved box (labels in fixed-width buttons), so nothing moves. Targets are at least 24 px (28 px buttons, 24 px speed segments), 44 px on a phone. The replay's state is not shown as a sentence: the mode chip and the lap counter show it; one visually hidden polite region announces each change once, never a lap counter. A refused action or a failed replay's reason is a `role="alert"` line under the strip. Tab order follows reading order: the strip's cells are text, so the transport's controls are its only tab stops, after the page links; focus moves to the new phase's first control when a press removes the focused one. |
| **The call** | The one loud element. Four states. **Call:** the current best pair: attacker → defender with team swatches, the calibrated probability labelled "model estimate" with the model id, the gauge ("gap now"), the tyres, the rule line ("gap at decision (lap N)" from this page's alert, or "not received" after a late join) and the rule checks, plus "Simulate this pair" (the only solid signal button). The defender is the one the attacker's latest alert names; when that car is no longer directly ahead, the call keeps it (never relabelled), says "flagged at lap N against D; order changed since" in place of the rule checks (the car directly ahead now is in the accessible text, so the line keeps the checks' length), shows the alert's probability, mutes the gauge at the decision gap ("gap at decision (lap N)", no trend) and does not present the rule checks as passing. **No call while a replay streams:** the panel keeps its height and shows the closest pair, why it is not a call ("gap 4.1 s, outside the 3.5 s rule window"), its gauge in a muted style, "N cars flagged, none qualifies" when the only flags belong to cars with no timing, and a neutral "Simulate closest pair". **Idle or before lap 1:** one line; with no replay, "No replay of this race is running. Start one from the status strip above." (the call has no start button of its own: the strip's Start replay is right above it). **Stored state (NOT REPLAYING):** one line, "No replay of this race is running. The tower shows the state an earlier run left (lap N); its flags are not a live call. Start one from the status strip above.", with no pair, no probability and no model id; the tower's note says the flags were scored by that run's model. **After the finish** (replay finished, `session_end`, or the leader on the last lap): "Race ended at lap N. The live call stops at the chequered flag.", no pit instruction, no Simulate and no button: the strip's transport, right above the call, offers "Replay again" and "Open the post-race archive" (the archive is offered once on the page). A car with no timing for 2 or more leader laps is never part of the call. |
| **Gauge** (signature move) | A horizontal bullet scale from 0 s to max(5 s, gap × 1.5): the rule window (0 to 3.5 s) shaded and labelled "rule window 3.5 s", a tick at its edge, the gap now as a signal-coloured marker, and the gap trend as an arrow from the gap now to next lap's gap if the trend holds, in gain blue (closing) or loss orange (opening), with its s/lap value and next lap's gap in text. The pit loss is a different quantity, so it is text in the caption, never on the axis. It is the race's pit loss (one value per race from the engineer API, kept whichever pair the call shows), fetched as soon as the page knows the leader's lap, so a late joiner sees it before the next crossing, at any width. No abbreviation ("G") on the gauge. `role="img"` with a title and a text description; every value is also written out. |
| **Alert feed** | Directly under the call, in reserved space. Type and strength are distinct: the type is a word in a neutral outline (Attempt 2 px, Opportunity solid, Candidate dotted), the strength a short bar plus the percentage (semibold from 50%). Only an alert from the leader's lap or the one before is in the signal colour, with the word "new"; after the finish no alert is new, so the finished feed has no signal colour. A pair's counter ("4×") has a title and the accessible text "4 alerts for this pair". Each row carries both cars' compound and tyre age; the meta wraps onto a second line rather than clipping, and a value never breaks from its label. The list ends on a whole row with "N more below". A late joiner sees "No alerts since you opened this page (lap N)" and the pairs flagged now. |
| **Timing tower** | Every column visible at 1440 px with no cell cut off, Undercut % next to the driver. Below 1440 px the Driver column is a fixed 7.25rem and Pos, pin, Driver and Undercut stay put while the other columns scroll inside the tower (an earlier layout collapsed it to 0 px at 768 and 1100–1366 px). Only P1 says "Leader"; another car with a gap of 0 shows "—" ("not measured at this lap"). Only the call's pair is on the signal band, the attacker with a solid left rule and the word "attacker", the defender with a dashed rule and "defender"; other flagged rows keep the flag mark and the percentage in normal weight (semibold from 50%). A car still on the previous lap shows a small muted lap number in its Gap cell ("L9", no box); a lapped car shows "+1 lap" in Gap. A car with no timing for 2 or more leader laps (after allowing for laps down; the stream sends no retirement) keeps its row, in faint text at the bottom, with "no timing since L19" across Int and Gap and its flag faint. PB / OB tags start on lap 2. Header help lives in one key, not one "?" per header. |
| **What-if** | Results are a modelled comparison of pit now / pit next lap / stay out from the same state: "share of sim runs ahead", the expected gap and its 80% range as a bar. A one-line caveat sits next to the numbers and the full explanation is behind "How to read this". The attacker is preselected from the call (it follows the call until the viewer picks) but nothing runs until Run; before a run there is no table, only a one-line state, and the panel's height follows its content (one status line reserved, no empty error line). The defender is the car directly ahead; a teammate pair is named before the run. |
| **Gap chart** | Highlight starts on "The call (A → D)" and follows the call until the viewer picks another car or None. End-of-line labels for the highlighted cars and the top 5 running cars, placed so they never overlap; every other line is thin, grey and unlabelled. The first lap sits clear of the y-axis labels, and lap labels thin out on a narrow chart. Before the page has received a lap frame (a late join holds only the snapshot) the live chart is one line, "First lap arrives at the next crossing.", not an empty 0–1 s axis. |

## Components of the engineer view, the post-race archive and the race picker

All three are Operate screens. Each has at most one loud element: the archive's alerts at the scrubbed lap. The
engineer and the picker have none.

| Component | Rules |
|---|---|
| **Engineer cards** | The three cars (Ahead, Focus, Behind) are columns of one panel split by `--rule` hairlines. There is no box or panel inside the panel. The focus column has a 2px `--text` top rule, a `--surface-2` tint and its "Focus" heading, never amber. The columns stack at 1080 px and below. Values are Plex Mono; labels are Barlow Semi Condensed `--fs-xs`, muted. |
| **Engineer status** | Separate cells ("Data to lap N": the last lap with complete data, which can trail the strip's leader lap by one; Track; Race control), never a dot-joined string. They wrap on a phone. The "Gaps" heading has one key ("About the gaps": trend, undercut and threat), not two. |
| **Pair sparkline** | The sentence (capped at 36 rem) then the chart directly after it, top-aligned. It stacks at 640 px and below. The line is 2 px in `--text`; the latest lap is the only dot and has its value as a direct label. The caption lists every value. With no laps it says "no lap of this pair completed yet". |
| **Rejoin bar** | A seconds axis behind the focus, from −5 s to pit loss + 10 s:<ul><li>every car is a 2 px tick (dashed and muted when projected);</li><li>car codes sit in label lanes above the axis (`rejoinLanes`; 3 lanes are reserved) with a leader line, and never overlap;</li><li>0 s ("now") is a dashed tick, and the scale ends are written out;</li><li>the rejoin slot is a double tick on the axis plus an authored SVG triangle and the word "rejoin" in its own row (no `▼` glyph; the Latin subset lacks it).</li></ul>The bar is `aria-hidden`; the sentence carries it. Nothing animates. |
| **Strategy calls** | Rows with hairline dividers. The kind is a chip that differs by word and outline: Watch is 2 px solid and bold; Info is 1 px dotted and muted. Never a side bar. Only new calls are announced. |
| **Archive head and strip** | The live head's order: crumbs, h1, the Live / Post-race tabs, then Race analysis and Drivers. It is rendered once above the loading and loaded states, so keyboard focus stays on the tab. A skip link leads to the lap controls. The strip reuses the live strip's cells:<ul><li>the POST-RACE chip (double border);</li><li>Lap n/N;</li><li>Track as a code chip whose border style is the status (solid SC, dashed VSC, dotted neutralised, double red flag), the same as live;</li><li>Model, with the scorer as detail;</li><li>on its own line, as visible text: the latest key race-control message, its lap and the status source.</li></ul>It has no live region (scrubbing never speaks). The archive has no side-bar banner. |
| **Archive transport** | A native range slider with `accent-color: var(--text)`, ±1 lap, Play/Pause and the 1×/10×/60× radios. The Flags, Pits and Alerts lanes hold 24 px markers in one toolbar (one tab stop; arrows, Home and End). Kinds differ by letter and border style: SC 2 px solid, VSC dashed, red double, neutralised dotted, alert 2 px text ink. SC and VSC are text ink, like every marker and list (only the status strip's track chip keeps the loss colour). None is amber. Each marker's accessible name starts with its visible code ("SC, lap 22: …"), and the ±1 lap buttons' names start with their text. The tracks are inset 12 px, so a marker at the first or last lap stays inside its lane. |
| **Archive layout** | The transport spans the page. Below it, the tower (left) and a side column (right) as tall as the tower block: the alert feed with both cars' tyres, then race control (key rows have semibold text and a "Key" chip). The gap chart and the key come last. One column at 1080 px and below. No Tyres panel: the tower and the alert rows carry the tyres. |
| **Race picker** | A "Start here" card above the search: the race replaying now, else the `make demo` race (2024 R5), else the newest race. It shows name, season, round and laps, why it is offered, "Open the race" (a 2 px text-ink outline) and, when a bundle exists, "Open the post-race archive". It is neutral (a 2 px text-ink top rule) and reserves its height while loading. Below are the search and the season lists of race cards (R## and laps in Plex Mono, a "synthetic tyres" tag). Arrow keys, Home and End move within the list. Hover and focus change the border instantly (no transition: arrow keys move focus). |

## Components of the race analysis, telemetry and drivers views

These are Operate screens with no loud element. The amber stays with the live call: the analysis tab bar, "Show
table", the hover readouts and the drivers table never use it.

| Component | Rules |
|---|---|
| **Race sub-head** | `RaceSubHead` is shared by `/analysis` and `/drivers`. It follows the live head's order: crumbs ("All races"), h1 (season, name, R#), then the race's views ("Live race", "Race analysis", "Drivers"). The current page has `aria-current` and a 2 px text-ink underline. On a phone the views take short labels, and the head wraps like the archive's. |
| **Analysis tabs** | WAI-ARIA tabs (arrows, Home, End). Muted `--fs-sm` text; the selected tab is text ink with a 2 px text-ink underline (a shape). The bar **wraps** on a narrow screen, so all 8 tabs are visible at 390 px and none scrolls out of view. |
| **Coverage notes** | Neutral text. A SYNTHETIC note leads with the dashed honesty stamp, never a colour alone; the same goes for the synthetic note inside strategy and degradation. |
| **Every chart** | Each chart has, in this order: a visible text summary, the legend (two or more series), the plot with `<title>` and `<desc>`, then "Show table" (a neutral disclosure with a chevron and the table's caption as hidden text). Lap ticks are whole laps; a lap-time axis drops a zero fraction ("1:52"). Series names are text ink, and colour appears only on the line key next to the name. SVG text is 11 px or larger. |
| **Hover readout** | `ChartHover` is transparent over the plot and snaps to the nearest mark. The mark is a 1 px text-ink hairline (a lap) or a 2 px text-ink box (a stint, a quick lap). The tooltip lists every series at that mark, value first (Plex Mono) and name after (muted). It flips to the side with more room and is placed by `transform`, with no animation. The same readout comes from the keyboard: the layer is a slider (arrows one mark, Page Up and Page Down ten, Home, End) with the readout as `aria-valuetext`. Tooltips never gate: every value is also in the table. |
| **Lap times** | The four line colours (2 px), then neutral `--grid` (1.5 px) with a dash, never cycled. End labels are spread so they never overlap and carry a short key. Summary: best lap and median racing lap per driver (`lapTimesSummary`). |
| **Tyre degradation** | It stays labelled "(lap-time proxy)" and "A lap-time proxy, not tyre wear". The fit lines are text ink with a dash per stint. Their legend is the stint list (line key, compound, slope); there are no end labels, so nothing can overlap or run off a narrow chart. |
| **Positions** | Team colours only (a car without one is `--grid`). The second teammate is dashed, and end labels carry a team-colour key. Full-name labels need a chart at least 560 px wide; below that the radio is disabled and says why. Summary: the winner and start slot, the biggest gain and loss, and the cars that stopped early (`positionsSummary`). The Highlight starts on the drivers the summary names ("The summary's 3 (VER, HAM, STR)", `positionsKeyDrivers`); the others are thin (1.25 px) and grey, drawn under them. "None" and any single driver stay selectable. |
| **Compare** | Delta bars are gain blue below the line (A faster) and loss orange above (A slower); pit and SC/VSC laps are hollow. The side carries the meaning, colour repeats it, and a legend names all three. The gap line is `--line-0`. Both charts have a `<desc>`. Table heads read "Delta" (the font subset has no "Δ"). |
| **Pit stops** | A summary sentence (`pitStopsSummary`). "from → to" uses the authored `PairArrow`, read as "to". |
| **Race control** | The kind is a code chip whose border style is the track status, as in the status strip: SC solid 2 px, VSC dashed (both in text ink), red flag double `--danger`, penalty 2 px bold, others dotted and muted. Sentence case, untracked. Key rows have semibold text and a "Key" chip, with no side bar. |
| **Telemetry** | Team colours, with neutral text ink for a car without one (see [Colour](#colour)). A is solid and B dashed. Picks, legend and readout use tokens only. |
| **Drivers** | One panel: h2, count, a note, then the table (badge swatch, code, name, nationality code, team, car number). Team colour appears only as the badge swatch. The table is capped at 56rem, so a wide screen leaves no gap between the name and the nationality. At 390 px the table fits with no sideways scroll: the name drops under the code, the team wraps, and none of the tower's sticky phone columns apply. |
| **Pipeline panel, "How to read this", footer** | Restyled on tokens only; their markup and their place on the race page are unchanged. The disclosures share the chevron and the 24 px summary target, reading text is capped at 72ch, and counters are Plex Mono. The footer is the disclaimer under a `--rule` hairline. |

## Honesty rules

1. **Calibrated probabilities are labelled as model estimates, with the model id** (`model_version`, feature
   set, G, k from `/api/health`). There is no base-rate line: 2025 is the sealed
   test season, and the health check does not serve the training seasons' base rate. A probability is shown only for
   the pair it was computed for: after the order changes the call keeps the alert's defender ("flagged at lap N
   against D; order changed since"), and a stored state from an earlier run is never shown as a call.
2. **What-if results are modelled ranges, not odds.** The simulator is less well calibrated than the model
   (2025 ECE, 10 bins, 0.207 against 0.107 in `results/whatif_consistency.csv`); the panel says so where the
   numbers are.
3. **SMOKE TEST and the replay state are always visible.** The status strip shows the replay mode and speed on
   every race page (its mode chip; the replay transport next to it shows the speed in force); when the sample deployment model (`sample_` prefix) is scoring, a SMOKE TEST stamp shows
   in the strip and in the call, and in the post-race archive's strip when the bundle was scored by it.
   SYNTHETIC DEMO DATA shows whenever the lake is the sample.
4. **Decision-time truth.** Nothing in the live view uses a lap the stream has not reached. History the page
   did not receive is never back-filled from full-race data. The gap chart says "History from when you opened
   the page (from lap N)", and the window's laps before that keep their place on the axis as a hatched band
   labelled "Before you opened the page, not received".
5. **Every empty or missing value says why** ("not a candidate: teammates", "gap above 3.5 s", "no alerts
   since you opened this page").
6. **No F1 marks:** no Formula 1 or team logos, no official F1 typeface, no photographs of people. Team colours
   appear only as data. The footer disclaimer stays.
7. **Meaning is never carried by colour alone:** signal plus a mark and a word; gain/loss plus a sign or arrow;
   compounds plus a glyph shape and a letter; track status plus a border style.

## Validation

### WCAG AA contrast (both themes)

`node web/scripts/contrast-report.mjs` prints the full table; `--check` exits non-zero on any failure, and
`web/tests/theme.test.ts` asserts the same pairs. Text needs 4.5:1, marks (borders, focus rings, chart lines,
the flag and gauge marks, compound swatches) need 3:1.

| Theme | Pairs | Pass | Fail | Lowest text pair | Lowest mark pair |
|---|---|---|---|---|---|
| Dark | 92 | 92 | 0 | 5.46:1 | 3.07:1 (`line-3` on `surface-2`) |
| Light | 92 | 92 | 0 | 4.61:1 | 3.00:1 (`signal-mark` on `raised`) |

The tightest light pair, `signal-mark` on `raised` (3.00:1), is legal but has no margin: signal marks are not
placed on the raised ground (the status strip) in the light theme.

Three pairs were added on 2026-11-19 for the call's band: `faint` on `signal-wash` (the previous-lap lap number of a
banded row) and `gain`/`loss` marks on `signal-wash` (the gauge's trend arrow over the shaded rule window).

### Automated anti-pattern scan

The automated anti-pattern scan of `web/src/app` and `web/src/components` reports **0 findings and no suppressions** (2026-11-19,
re-run after the race analysis, telemetry, drivers and shared-part changes; the earlier run on the engineer view,
archive and picker had the same result). No colour token was added for these screens, so the contrast table below is unchanged: 92 of 92 pairs pass
in each theme.

### Palette validator (dataviz `validate_palette.js`)

Run against our own surfaces (`--surface` = `--surface` of each theme).

| Set | Pairs | Dark | Light |
|---|---|---|---|
| Chart lines `--line-0…3` | **all** | **all checks pass**: CVD ΔE 11.2, normal-vision ΔE 17.4, all ≥ 3:1 | **all checks pass**: CVD ΔE 8.6, normal-vision ΔE 15.8, all ≥ 3:1 |
| Signal mark, gain, loss | all | CVD ΔE 11.7, normal-vision ΔE 16.3, all ≥ 3:1 pass; **lightness band fails by design** (see below) | **all checks pass**: CVD ΔE 10.5, normal-vision ΔE 16.2 |
| Tyre compounds | all | **fails** (lightness band, chroma, normal-vision 13.3; CVD 6.8 warn) | **fails** (chroma, CVD 3.7, normal-vision 7.6) |

- **Signal set, dark.** The validator's dark lightness band (L 0.48–0.67) is for chart series. These three
  colours also carry text on graphite, which needs L ≥ 0.71 for 4.5:1, so they sit above the band on purpose;
  every separation check passes.
- **Tyre compounds** follow the sport's convention (red soft, yellow medium, white/grey hard, green
  intermediate, blue wet), so "hard" and "unknown" are deliberately grey and the medium yellow cannot reach
  ΔE 15 from the signal amber (best found 13.5 dark, 10.5 light). That is why a compound is **never** shown by
  colour: it is always a distinct glyph shape plus a letter or name (`TyreGlyph`), and every swatch is ≥ 3:1
  on its ground.
- **Chart lines are never cycled.** There are four line colours, then neutral with dash and end label (see
  [Colour](#colour)).
- **Violet against team colours** (2026-11-19). The team colours are the 35 distinct `team_colour_hex` values
  `GET /api/races/{s}/{r}/entrants` serves for every race (2021–2024; 2025 is not served with the test season
  off). Each was checked against each violet use with the validator's pair check:
  - **Before:** the OB violet and the three violet lines had 50 clashes in the two themes. The worst was
    `--line-8` dark against Red Bull `#3671c6` (normal ΔE 4.6, CVD 1.5).
  - **After:** OB carries no hue. The one remaining violet line appears only in the lap-times chart, where no
    team colour is shown, so no violet shares a view with a team colour.

- **Telemetry neutral against team colours.** The neutral stroke of a car without a team colour was
  checked against the same 35 team colours. Each pair was run as `validate_palette.js "<ink>,<team>" --mode <m>
  --surface <surface> --pairs all` in both themes (70 runs).
  - **Text ink** (`#ebedf0` dark, `#171b20` light): 68 of 70 pass both checks.
    - **Dark fails 2:** `#ffffff` (normal ΔE 5.5) and Mercedes `#27f4d2` (protan ΔE 4.2). The next lowest are
      normal ΔE 15.9 (`#b6babd`) and CVD ΔE 11.4 (`#6cd3bf`).
    - **Light:** all pass. Worst normal ΔE is 17.0 (`#2b4562`); worst CVD ΔE is 12.0 (`#900000`, protan).
  - **The grid neutral** (`--grid`) was the first candidate. It was under normal ΔE 15 from 9 team colours in
    each theme (worst 6.0, `#4e7c9b`), so text ink was chosen.
  - `strokesClose` flags exactly the two failing pairs, which then get the "line style" note. A and B also always
    differ by dash and width.

Raw validator output (2026-11-18; the line sets re-run 2026-11-19):

```
### dark lines (#0ca3be,#68a63f,#b4481e,#944da4) --pairs all
  [PASS] Lightness band         all 4 inside L 0.48–0.67
  [PASS] Chroma floor           all 4 >= 0.1
  [PASS] CVD separation         worst all-pairs #b4481e↔#68a63f ΔE 11.2 (deutan) · tritan 6.0
  [PASS] Normal-vision floor    worst all-pairs #68a63f↔#0ca3be ΔE 17.4 (normal)
  [PASS] Contrast vs surface    all 4 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
### dark signal (#f8b734,#6bb9f8,#f67654) --pairs all
  [FAIL] Lightness band         outside band: [["#f8b734",0.819],["#6bb9f8",0.761],["#f67654",0.71]]
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst all-pairs #f67654↔#f8b734 ΔE 11.7 (deutan) · tritan 14.4
  [PASS] Normal-vision floor    worst all-pairs #f67654↔#f8b734 ΔE 16.3 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
### dark compounds (#ff5c57,#edf07b,#eef1f5,#46d17a,#59a9ff,#a9b3c0) --pairs all
  [FAIL] Lightness band         outside band: [["#ff5c57",0.69],["#edf07b",0.929],["#eef1f5",0.957],["#46d17a",0.765],["#59a9ff",0.722],["#a9b3c0",0.763]]
  [FAIL] Chroma floor           below floor (reads gray): [["#eef1f5",0.006],["#a9b3c0",0.022]]
  [WARN] CVD separation         worst all-pairs #46d17a↔#ff5c57 ΔE 6.8 (deutan) · tritan 4.4
  [FAIL] Normal-vision floor    worst all-pairs #a9b3c0↔#59a9ff ΔE 13.3 (normal) — below 15, hard to tell apart even with full color vision
  [PASS] Contrast vs surface    all 6 >= 3:1
  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
### light lines (#25984d,#0e5caf,#886acf,#a02d41) --pairs all
  [PASS] Lightness band         all 4 inside L 0.43–0.77
  [PASS] Chroma floor           all 4 >= 0.1
  [PASS] CVD separation         worst all-pairs #886acf↔#0e5caf ΔE 8.6 (protan) · tritan 11.3
  [PASS] Normal-vision floor    worst all-pairs #886acf↔#0e5caf ΔE 15.8 (normal)
  [PASS] Contrast vs surface    all 4 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
### light signal (#a07a0c,#0c60a3,#a73301) --pairs all
  [PASS] Lightness band         all 3 inside L 0.43–0.77
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst all-pairs #a73301↔#a07a0c ΔE 10.5 (deutan) · tritan 15.8
  [PASS] Normal-vision floor    worst all-pairs #a73301↔#a07a0c ΔE 16.2 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
### light compounds (#c8102e,#71640b,#4b5561,#16703a,#0a58a8,#6b6457) --pairs all
  [PASS] Lightness band         all 6 inside L 0.43–0.77
  [FAIL] Chroma floor           below floor (reads gray): [["#4b5561",0.023],["#6b6457",0.022]]
  [FAIL] CVD separation         worst all-pairs #6b6457↔#16703a ΔE 3.7 (deutan) · tritan 2.6
  [FAIL] Normal-vision floor    worst all-pairs #6b6457↔#4b5561 ΔE 7.6 (normal) — below 15, hard to tell apart even with full color vision
  [PASS] Contrast vs surface    all 6 >= 3:1
  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
```

<details>
<summary>Full contrast table (184 pairs)</summary>

### Dark theme: 92 pairs, 92 pass, 0 fail
Lowest text pair 5.46:1 (needs 4.5), lowest mark pair 3.07:1 (needs 3).

| Foreground | Ground | Colours | Ratio | Needs | AA |
|---|---|---|---|---|---|
| text | bg | `#ebedf0` on `#0c0f12` | 16.39 | 4.5 | pass |
| text | surface | `#ebedf0` on `#13161a` | 15.47 | 4.5 | pass |
| text | surface2 | `#ebedf0` on `#1b1e23` | 14.25 | 4.5 | pass |
| text | raised | `#ebedf0` on `#23272c` | 12.81 | 4.5 | pass |
| muted | bg | `#b5bbc2` on `#0c0f12` | 9.93 | 4.5 | pass |
| muted | surface | `#b5bbc2` on `#13161a` | 9.38 | 4.5 | pass |
| muted | surface2 | `#b5bbc2` on `#1b1e23` | 8.64 | 4.5 | pass |
| muted | raised | `#b5bbc2` on `#23272c` | 7.76 | 4.5 | pass |
| faint | bg | `#9fa5ad` on `#0c0f12` | 7.74 | 4.5 | pass |
| faint | surface | `#9fa5ad` on `#13161a` | 7.31 | 4.5 | pass |
| faint | surface2 | `#9fa5ad` on `#1b1e23` | 6.73 | 4.5 | pass |
| faint | raised | `#9fa5ad` on `#23272c` | 6.05 | 4.5 | pass |
| signalInk | bg | `#fbc044` on `#0c0f12` | 11.65 | 4.5 | pass |
| signalInk | surface | `#fbc044` on `#13161a` | 10.99 | 4.5 | pass |
| signalInk | surface2 | `#fbc044` on `#1b1e23` | 10.13 | 4.5 | pass |
| signalInk | raised | `#fbc044` on `#23272c` | 9.10 | 4.5 | pass |
| gain | bg | `#6bb9f8` on `#0c0f12` | 9.08 | 4.5 | pass |
| gain | surface | `#6bb9f8` on `#13161a` | 8.57 | 4.5 | pass |
| gain | surface2 | `#6bb9f8` on `#1b1e23` | 7.89 | 4.5 | pass |
| gain | raised | `#6bb9f8` on `#23272c` | 7.10 | 4.5 | pass |
| loss | bg | `#f67654` on `#0c0f12` | 6.99 | 4.5 | pass |
| loss | surface | `#f67654` on `#13161a` | 6.60 | 4.5 | pass |
| loss | surface2 | `#f67654` on `#1b1e23` | 6.08 | 4.5 | pass |
| loss | raised | `#f67654` on `#23272c` | 5.46 | 4.5 | pass |
| danger | bg | `#f97676` on `#0c0f12` | 7.21 | 4.5 | pass |
| danger | surface | `#f97676` on `#13161a` | 6.81 | 4.5 | pass |
| danger | surface2 | `#f97676` on `#1b1e23` | 6.27 | 4.5 | pass |
| danger | raised | `#f97676` on `#23272c` | 5.64 | 4.5 | pass |
| text | signalWash | `#ebedf0` on `#382709` | 12.24 | 4.5 | pass |
| muted | signalWash | `#b5bbc2` on `#382709` | 7.42 | 4.5 | pass |
| faint | signalWash | `#9fa5ad` on `#382709` | 5.79 | 4.5 | pass |
| signalInk | signalWash | `#fbc044` on `#382709` | 8.70 | 4.5 | pass |
| signalOn | signal | `#1d1406` on `#f8b734` | 10.23 | 4.5 | pass |
| faint (placeholder) | surface2 | `#9fa5ad` on `#1b1e23` | 6.73 | 4.5 | pass |
| border (mark) | bg | `#7b8189` on `#0c0f12` | 4.89 | 3 | pass |
| border (mark) | surface | `#7b8189` on `#13161a` | 4.62 | 3 | pass |
| border (mark) | surface2 | `#7b8189` on `#1b1e23` | 4.25 | 3 | pass |
| border (mark) | raised | `#7b8189` on `#23272c` | 3.82 | 3 | pass |
| focus (mark) | bg | `#cbeff9` on `#0c0f12` | 15.79 | 3 | pass |
| focus (mark) | surface | `#cbeff9` on `#13161a` | 14.91 | 3 | pass |
| focus (mark) | surface2 | `#cbeff9` on `#1b1e23` | 13.73 | 3 | pass |
| focus (mark) | raised | `#cbeff9` on `#23272c` | 12.34 | 3 | pass |
| signalMark (mark) | bg | `#f8b734` on `#0c0f12` | 10.81 | 3 | pass |
| signalMark (mark) | surface | `#f8b734` on `#13161a` | 10.21 | 3 | pass |
| signalMark (mark) | surface2 | `#f8b734` on `#1b1e23` | 9.40 | 3 | pass |
| signalMark (mark) | raised | `#f8b734` on `#23272c` | 8.45 | 3 | pass |
| grid (mark) | bg | `#6d7279` on `#0c0f12` | 3.97 | 3 | pass |
| grid (mark) | surface | `#6d7279` on `#13161a` | 3.74 | 3 | pass |
| grid (mark) | surface2 | `#6d7279` on `#1b1e23` | 3.45 | 3 | pass |
| grid (mark) | raised | `#6d7279` on `#23272c` | 3.10 | 3 | pass |
| gain (mark) | bg | `#6bb9f8` on `#0c0f12` | 9.08 | 3 | pass |
| gain (mark) | surface | `#6bb9f8` on `#13161a` | 8.57 | 3 | pass |
| gain (mark) | surface2 | `#6bb9f8` on `#1b1e23` | 7.89 | 3 | pass |
| gain (mark) | raised | `#6bb9f8` on `#23272c` | 7.10 | 3 | pass |
| loss (mark) | bg | `#f67654` on `#0c0f12` | 6.99 | 3 | pass |
| loss (mark) | surface | `#f67654` on `#13161a` | 6.60 | 3 | pass |
| loss (mark) | surface2 | `#f67654` on `#1b1e23` | 6.08 | 3 | pass |
| loss (mark) | raised | `#f67654` on `#23272c` | 5.46 | 3 | pass |
| signalMark (mark) | signalWash | `#f8b734` on `#382709` | 8.08 | 3 | pass |
| focus (mark) | signalWash | `#cbeff9` on `#382709` | 11.80 | 3 | pass |
| gain (mark) | signalWash | `#6bb9f8` on `#382709` | 6.78 | 3 | pass |
| loss (mark) | signalWash | `#f67654` on `#382709` | 5.22 | 3 | pass |
| line-0 (mark) | bg | `#0ca3be` on `#0c0f12` | 6.40 | 3 | pass |
| line-0 (mark) | surface | `#0ca3be` on `#13161a` | 6.05 | 3 | pass |
| line-0 (mark) | surface2 | `#0ca3be` on `#1b1e23` | 5.57 | 3 | pass |
| line-1 (mark) | bg | `#68a63f` on `#0c0f12` | 6.51 | 3 | pass |
| line-1 (mark) | surface | `#68a63f` on `#13161a` | 6.15 | 3 | pass |
| line-1 (mark) | surface2 | `#68a63f` on `#1b1e23` | 5.66 | 3 | pass |
| line-2 (mark) | bg | `#b4481e` on `#0c0f12` | 3.56 | 3 | pass |
| line-2 (mark) | surface | `#b4481e` on `#13161a` | 3.36 | 3 | pass |
| line-2 (mark) | surface2 | `#b4481e` on `#1b1e23` | 3.09 | 3 | pass |
| line-3 (mark) | bg | `#944da4` on `#0c0f12` | 3.53 | 3 | pass |
| line-3 (mark) | surface | `#944da4` on `#13161a` | 3.33 | 3 | pass |
| line-3 (mark) | surface2 | `#944da4` on `#1b1e23` | 3.07 | 3 | pass |
| compound soft (mark) | bg | `#ff5c57` on `#0c0f12` | 6.33 | 3 | pass |
| compound soft (mark) | surface | `#ff5c57` on `#13161a` | 5.98 | 3 | pass |
| compound soft (mark) | surface2 | `#ff5c57` on `#1b1e23` | 5.51 | 3 | pass |
| compound medium (mark) | bg | `#edf07b` on `#0c0f12` | 15.88 | 3 | pass |
| compound medium (mark) | surface | `#edf07b` on `#13161a` | 14.99 | 3 | pass |
| compound medium (mark) | surface2 | `#edf07b` on `#1b1e23` | 13.81 | 3 | pass |
| compound hard (mark) | bg | `#eef1f5` on `#0c0f12` | 16.96 | 3 | pass |
| compound hard (mark) | surface | `#eef1f5` on `#13161a` | 16.02 | 3 | pass |
| compound hard (mark) | surface2 | `#eef1f5` on `#1b1e23` | 14.75 | 3 | pass |
| compound inter (mark) | bg | `#46d17a` on `#0c0f12` | 9.76 | 3 | pass |
| compound inter (mark) | surface | `#46d17a` on `#13161a` | 9.21 | 3 | pass |
| compound inter (mark) | surface2 | `#46d17a` on `#1b1e23` | 8.48 | 3 | pass |
| compound wet (mark) | bg | `#59a9ff` on `#0c0f12` | 7.82 | 3 | pass |
| compound wet (mark) | surface | `#59a9ff` on `#13161a` | 7.38 | 3 | pass |
| compound wet (mark) | surface2 | `#59a9ff` on `#1b1e23` | 6.80 | 3 | pass |
| compound unknown (mark) | bg | `#a9b3c0` on `#0c0f12` | 9.06 | 3 | pass |
| compound unknown (mark) | surface | `#a9b3c0` on `#13161a` | 8.55 | 3 | pass |
| compound unknown (mark) | surface2 | `#a9b3c0` on `#1b1e23` | 7.88 | 3 | pass |

### Light theme: 92 pairs, 92 pass, 0 fail
Lowest text pair 4.61:1 (needs 4.5), lowest mark pair 3.00:1 (needs 3).

| Foreground | Ground | Colours | Ratio | Needs | AA |
|---|---|---|---|---|---|
| text | bg | `#171b20` on `#eef0f3` | 15.15 | 4.5 | pass |
| text | surface | `#171b20` on `#fbfcfd` | 16.84 | 4.5 | pass |
| text | surface2 | `#171b20` on `#e6e8eb` | 14.09 | 4.5 | pass |
| text | raised | `#171b20` on `#dde0e4` | 13.06 | 4.5 | pass |
| muted | bg | `#484e55` on `#eef0f3` | 7.37 | 4.5 | pass |
| muted | surface | `#484e55` on `#fbfcfd` | 8.19 | 4.5 | pass |
| muted | surface2 | `#484e55` on `#e6e8eb` | 6.85 | 4.5 | pass |
| muted | raised | `#484e55` on `#dde0e4` | 6.35 | 4.5 | pass |
| faint | bg | `#585e66` on `#eef0f3` | 5.73 | 4.5 | pass |
| faint | surface | `#585e66` on `#fbfcfd` | 6.37 | 4.5 | pass |
| faint | surface2 | `#585e66` on `#e6e8eb` | 5.33 | 4.5 | pass |
| faint | raised | `#585e66` on `#dde0e4` | 4.94 | 4.5 | pass |
| signalInk | bg | `#875814` on `#eef0f3` | 5.35 | 4.5 | pass |
| signalInk | surface | `#875814` on `#fbfcfd` | 5.95 | 4.5 | pass |
| signalInk | surface2 | `#875814` on `#e6e8eb` | 4.98 | 4.5 | pass |
| signalInk | raised | `#875814` on `#dde0e4` | 4.61 | 4.5 | pass |
| gain | bg | `#0c60a3` on `#eef0f3` | 5.72 | 4.5 | pass |
| gain | surface | `#0c60a3` on `#fbfcfd` | 6.35 | 4.5 | pass |
| gain | surface2 | `#0c60a3` on `#e6e8eb` | 5.32 | 4.5 | pass |
| gain | raised | `#0c60a3` on `#dde0e4` | 4.93 | 4.5 | pass |
| loss | bg | `#a73301` on `#eef0f3` | 5.90 | 4.5 | pass |
| loss | surface | `#a73301` on `#fbfcfd` | 6.56 | 4.5 | pass |
| loss | surface2 | `#a73301` on `#e6e8eb` | 5.49 | 4.5 | pass |
| loss | raised | `#a73301` on `#dde0e4` | 5.09 | 4.5 | pass |
| danger | bg | `#b32322` on `#eef0f3` | 5.78 | 4.5 | pass |
| danger | surface | `#b32322` on `#fbfcfd` | 6.43 | 4.5 | pass |
| danger | surface2 | `#b32322` on `#e6e8eb` | 5.38 | 4.5 | pass |
| danger | raised | `#b32322` on `#dde0e4` | 4.99 | 4.5 | pass |
| text | signalWash | `#171b20` on `#fceabe` | 14.54 | 4.5 | pass |
| muted | signalWash | `#484e55` on `#fceabe` | 7.07 | 4.5 | pass |
| faint | signalWash | `#585e66` on `#fceabe` | 5.50 | 4.5 | pass |
| signalInk | signalWash | `#875814` on `#fceabe` | 5.14 | 4.5 | pass |
| signalOn | signal | `#1d1406` on `#f8b734` | 10.23 | 4.5 | pass |
| faint (placeholder) | surface2 | `#585e66` on `#e6e8eb` | 5.33 | 4.5 | pass |
| border (mark) | bg | `#6f757d` on `#eef0f3` | 4.07 | 3 | pass |
| border (mark) | surface | `#6f757d` on `#fbfcfd` | 4.53 | 3 | pass |
| border (mark) | surface2 | `#6f757d` on `#e6e8eb` | 3.79 | 3 | pass |
| border (mark) | raised | `#6f757d` on `#dde0e4` | 3.51 | 3 | pass |
| focus (mark) | bg | `#13335a` on `#eef0f3` | 11.16 | 3 | pass |
| focus (mark) | surface | `#13335a` on `#fbfcfd` | 12.40 | 3 | pass |
| focus (mark) | surface2 | `#13335a` on `#e6e8eb` | 10.37 | 3 | pass |
| focus (mark) | raised | `#13335a` on `#dde0e4` | 9.62 | 3 | pass |
| signalMark (mark) | bg | `#a07a0c` on `#eef0f3` | 3.48 | 3 | pass |
| signalMark (mark) | surface | `#a07a0c` on `#fbfcfd` | 3.87 | 3 | pass |
| signalMark (mark) | surface2 | `#a07a0c` on `#e6e8eb` | 3.24 | 3 | pass |
| signalMark (mark) | raised | `#a07a0c` on `#dde0e4` | 3.00 | 3 | pass |
| grid (mark) | bg | `#767b81` on `#eef0f3` | 3.74 | 3 | pass |
| grid (mark) | surface | `#767b81` on `#fbfcfd` | 4.15 | 3 | pass |
| grid (mark) | surface2 | `#767b81` on `#e6e8eb` | 3.48 | 3 | pass |
| grid (mark) | raised | `#767b81` on `#dde0e4` | 3.22 | 3 | pass |
| gain (mark) | bg | `#0c60a3` on `#eef0f3` | 5.72 | 3 | pass |
| gain (mark) | surface | `#0c60a3` on `#fbfcfd` | 6.35 | 3 | pass |
| gain (mark) | surface2 | `#0c60a3` on `#e6e8eb` | 5.32 | 3 | pass |
| gain (mark) | raised | `#0c60a3` on `#dde0e4` | 4.93 | 3 | pass |
| loss (mark) | bg | `#a73301` on `#eef0f3` | 5.90 | 3 | pass |
| loss (mark) | surface | `#a73301` on `#fbfcfd` | 6.56 | 3 | pass |
| loss (mark) | surface2 | `#a73301` on `#e6e8eb` | 5.49 | 3 | pass |
| loss (mark) | raised | `#a73301` on `#dde0e4` | 5.09 | 3 | pass |
| signalMark (mark) | signalWash | `#a07a0c` on `#fceabe` | 3.34 | 3 | pass |
| focus (mark) | signalWash | `#13335a` on `#fceabe` | 10.71 | 3 | pass |
| gain (mark) | signalWash | `#0c60a3` on `#fceabe` | 5.49 | 3 | pass |
| loss (mark) | signalWash | `#a73301` on `#fceabe` | 5.66 | 3 | pass |
| line-0 (mark) | bg | `#25984d` on `#eef0f3` | 3.24 | 3 | pass |
| line-0 (mark) | surface | `#25984d` on `#fbfcfd` | 3.60 | 3 | pass |
| line-0 (mark) | surface2 | `#25984d` on `#e6e8eb` | 3.01 | 3 | pass |
| line-1 (mark) | bg | `#0e5caf` on `#eef0f3` | 5.81 | 3 | pass |
| line-1 (mark) | surface | `#0e5caf` on `#fbfcfd` | 6.45 | 3 | pass |
| line-1 (mark) | surface2 | `#0e5caf` on `#e6e8eb` | 5.40 | 3 | pass |
| line-2 (mark) | bg | `#886acf` on `#eef0f3` | 3.67 | 3 | pass |
| line-2 (mark) | surface | `#886acf` on `#fbfcfd` | 4.08 | 3 | pass |
| line-2 (mark) | surface2 | `#886acf` on `#e6e8eb` | 3.41 | 3 | pass |
| line-3 (mark) | bg | `#a02d41` on `#eef0f3` | 6.24 | 3 | pass |
| line-3 (mark) | surface | `#a02d41` on `#fbfcfd` | 6.94 | 3 | pass |
| line-3 (mark) | surface2 | `#a02d41` on `#e6e8eb` | 5.81 | 3 | pass |
| compound soft (mark) | bg | `#c8102e` on `#eef0f3` | 5.15 | 3 | pass |
| compound soft (mark) | surface | `#c8102e` on `#fbfcfd` | 5.73 | 3 | pass |
| compound soft (mark) | surface2 | `#c8102e` on `#e6e8eb` | 4.79 | 3 | pass |
| compound medium (mark) | bg | `#71640b` on `#eef0f3` | 5.21 | 3 | pass |
| compound medium (mark) | surface | `#71640b` on `#fbfcfd` | 5.79 | 3 | pass |
| compound medium (mark) | surface2 | `#71640b` on `#e6e8eb` | 4.85 | 3 | pass |
| compound hard (mark) | bg | `#4b5561` on `#eef0f3` | 6.64 | 3 | pass |
| compound hard (mark) | surface | `#4b5561` on `#fbfcfd` | 7.38 | 3 | pass |
| compound hard (mark) | surface2 | `#4b5561` on `#e6e8eb` | 6.17 | 3 | pass |
| compound inter (mark) | bg | `#16703a` on `#eef0f3` | 5.39 | 3 | pass |
| compound inter (mark) | surface | `#16703a` on `#fbfcfd` | 5.99 | 3 | pass |
| compound inter (mark) | surface2 | `#16703a` on `#e6e8eb` | 5.01 | 3 | pass |
| compound wet (mark) | bg | `#0a58a8` on `#eef0f3` | 6.18 | 3 | pass |
| compound wet (mark) | surface | `#0a58a8` on `#fbfcfd` | 6.87 | 3 | pass |
| compound wet (mark) | surface2 | `#0a58a8` on `#e6e8eb` | 5.75 | 3 | pass |
| compound unknown (mark) | bg | `#6b6457` on `#eef0f3` | 5.13 | 3 | pass |
| compound unknown (mark) | surface | `#6b6457` on `#fbfcfd` | 5.70 | 3 | pass |
| compound unknown (mark) | surface2 | `#6b6457` on `#e6e8eb` | 4.77 | 3 | pass |

</details>
