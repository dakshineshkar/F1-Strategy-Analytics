# UI inventory: every screen and state, 2026-11-18

Step 2 of the UI redesign, Part A. A read-only survey of `web/` at commit `5e50881`, before any redesign code.
The finding numbers (F01–F38) refer to [critique-2026-11-18.md](critique-2026-11-18.md).

**Server/API change?**
- **no**: the finding can be fixed in the web client from data it already receives.
- **client parser**: the API already sends the data, but the web parser drops it. Only `web/src/lib/*` changes.
- **YES (proposal)**: a full fix needs an additive server or API change. Nothing like that is made in this step.
  Each one is listed under [Findings that need a server or API change](#findings-that-need-a-server-or-api-change).

**Sources** (hook → endpoint or event). The reducer is `lib/reducer.ts`.
- **SSE**: `useRaceStream` → `EventSource /api/races/{s}/{r}/events`. Its event types are `lap`, `pit_in`,
  `pit_out`, `undercut_alert` and `session_end`.
- **snapshot**: the API's `event: snapshot`. It is pushed once at connect and once per leader lap, and carries
  `drivers` (the 9-field hash), `order`, `tyres` and `timing`.
- **/state**: `GET /api/races/{s}/{r}/state`. It is fetched only on a reconnect.
- **replays**: `useReplays` → `GET /api/replays`. It is polled every 1 s while a replay runs, else every 5 s. The
  same hook sends the replay actions as `POST …/replay[/stop|/pause|/resume|/speed]`.
- **health**: `useHealth` → `GET /api/health`, once per page.
- **status**: `useRaceStatus` → `GET /api/races/{s}/{r}/status?lap=N`, once per new leader lap.
- **engineer**: `fetchEngineer` → `GET /api/races/{s}/{r}/engineer/{driverId}`, once per new leader lap.
- **whatif**: `fetchWhatIf` → `POST /api/races/{s}/{r}/whatif`, on demand.
- **entrants**: `useEntrants` → `GET /api/races/{s}/{r}/entrants`, once per race.
- **races**: `api.races` → `GET /api/races`.
- **archive**:
  - `useArchiveAvailable` → `GET /api/archive`;
  - `useArchive` → `GET /api/archive/{s}/{r}` (ETag).
- **analysis**:
  - `useAnalysis` → `GET …/analysis/{laps,stints,pitstops,race-control,positions}`, in parallel;
  - `useCompare` → `…/analysis/compare?a=&b=`.
- **telemetry**:
  - `useTelemetryLaps` → `…/telemetry/laps?driver=`;
  - `useTelemetryCompare` → `…/telemetry/compare?a=&alap=&b=&blap=`.

## Screens and panels

| Screen / panel | Data shown | Source | Findings | Server/API change? |
|---|---|---|---|---|
| Layout chrome (every page) | Skip link, PIT WALL brand, data banner, footer disclaimer | static; banner from health | F34 (no `::placeholder` token), F33. **Step 4B:** the banner reads `--raised`/`--text` (no legacy alias); the footer sits under a hairline in tokens | no |
| Data banner | "SYNTHETIC DEMO DATA …" (sample), "Full lake (HDFS\|local)" (full), "Data source unavailable" | health → `lake.mode` | F10 (no model id, no SMOKE TEST) | client parser for the model id (health already returns `checks.model.model_version`, `feature_set`, `g`, `k`); YES (proposal) for a real smoke flag |
| Race picker `/` | Search, `N of M races`, races grouped by season, R##, name, laps, "synthetic tyres" tag | races | F34, F36 | no |
| Live race: header | Breadcrumb, Drivers / Race analysis links, h1, LAP n/N, connection pill | races (name, laps); SSE (leader lap, connection) | F08, F06 | no |
| Live race: Race / Engineer tabs | WAI-ARIA tabs; the race view stays mounted | local state | F04, F08 | no |
| Live race: legend | `<details>` "How to read this" from `lib/legend.ts` | static | F10 (no hint where the call lives) | no |
| Live race: race-status banner | GREEN / SC / VSC / RED FLAG / est. / UNKNOWN, the latest key message and its lap, the source | status | F28 | no |
| Live race: timing tower | Pos, Pin, Driver (badge, code, surname, IN PIT, +N L), Int, Gap, Last, S1–S3 (PB/OB), Trap, Pits, Tyre, Age, Undercut (▲ + %); Columns presets; Best so far | SSE lap frames + snapshot (driver, timing, tyre hashes); entrants; localStorage (columns, pin) | F01, F03, F04, F05, F07, F25, F27, F29, F30, F31, F33, F38 | no |
| Live race: gap chart | Gap to leader over the last 15 laps received; Highlight select; hidden table | reducer `history` (lap frames received on this page only) | F04, F24 | YES (proposal) for history from before the page opened |
| Live race: what-if | Attacker / Defender selects, Run; strategy rows (P, expected gap, 80% interval), sensitivity, model line, inputs line, warnings | whatif (on demand); `order` from the reducer | F11, F12, F14, F15, F16, F17, F18 | no |
| Live race: replay control | 1× / 10× / 60×, Start, Pause/Resume, Stop, status line, lap sent, error | replays | F06 | no |
| Live race: alert feed | Key row; groups `ATT → DEF`, %, Opportunity/Attempt badge, trigger, lap, gap, count | SSE `undercut_alert` only (`alertGroups`) | F02, F09, F13, F22, F25, F26, F31, F32, F35 | no for F09 via a client workaround; YES (proposal) for the true history |
| Live race: tyre panel | Per car: code, compound glyph and name, age bar, used/est. | reducer rows | F07 | no |
| Live race: stream stats | "N events applied · M malformed · K unknown drivers" | reducer counters | F06 | no |
| Engineer tab | Focus select; Ahead / Focus / Behind cards; pair line and sparkline; rejoin bar; strategy calls | engineer (per new leader lap); `order`, `maxLap` | F19, F20, F21, F35 (strategy-call rows: accent left bar, see [Detector findings](#detector-findings-carried-to-later-steps)) | no |
| Post-race archive `?mode=archive&lap=N` | Same tower, chart, alert feed and tyres, replayed through the live reducer; lap slider; play 1/10/60×; marker lanes (Flags / Pits / Alerts); race control (12 latest); "Model {version} (scorer {sha})" | archive bundle | F13, F33 (55 detector hits), F35 (alert-list key rows: accent left bar, see [Detector findings](#detector-findings-carried-to-later-steps)) | no |
| Race analysis `/analysis` | 8 tabs: tyre strategy, lap times, degradation, positions, compare, pit stops, race control, telemetry (2024) | analysis; telemetry | F08, F33 (SVG labels 10–10.5 px), F35 (race-control key rows: accent left bar, see [Detector findings](#detector-findings-carried-to-later-steps)). **Step 4B:** all fixed. The head is in the live order, tabs and "Show table" no longer use amber, sizes are tokens with an 11 px floor, and race-control kinds are border-style chips. Every chart has a summary, legend, title and desc, a hover readout (keyboard too) and its table. Telemetry falls back to neutral ink, not `--line-0/1`. | no |
| Drivers `/drivers` | Grid, driver, nationality, team, car no., colour-source note | entrants; races | (none). **Step 4B:** the shared race sub-head (F08), one panel, and at 390 px the table fits with no sideways scroll and no cell overlap | no |
| Not found | "Race not found" + link | static | (none) | no |

## States

| State | What the user sees today | Source | Findings | Server/API change? |
|---|---|---|---|---|
| Empty: no replay ever run for this race | Tower "No timing yet. Start a replay to fill the tower."; feed "No undercut alerts yet."; LAP —; tyres an empty list | snapshot (empty hashes) | F02, F12, F17 | no |
| Loading: picker, analysis, archive, drivers, engineer | "Loading races…", "Loading the race analysis…", "Loading the post-race archive…", "Loading drivers…", "Loading the engineer view…" | the matching hooks | (none) | no |
| Connecting | Pill "◌ Connecting" | `useRaceStream` | F01–F02 (layout) | no |
| Connected / live | Pill "● Live"; lap frames update the rows; snapshot once per leader lap | SSE + snapshot | F25, F37 (fixed) | no |
| Reconnecting | Pill "◌ Reconnecting"; backoff 1/2/4/8/15 s; on open, `/state` once, then the buffered events | SSE error → /state | F12 (raw snapshot error text) | no |
| Snapshot error after a reconnect | `role=alert` "Could not load the race state: {raw message}" | /state | F12 | no |
| Late join (page opened mid-race) | (Step 3: the feed now holds the run's earlier alerts from `snapshot-0.recent_alerts`, below "Received before you opened the page".) Before: Tower, flags, probabilities, gaps and stops are restored. The **alert feed is empty** although ▲ flags show. The gap chart starts at the join lap, the +N L tag reads 0, and IN PIT shows only from the next pit event. | snapshot-0 (has no alerts, history or in-pit state) | F09, F24, F38 | no (client: derive the pairs flagged now from `undercutFlag` + `order`); YES (proposal) for alert history and a causal gap history |
| Cars still on the previous lap | Correct order, but a smaller gap can sit below a larger one until the car behind crosses the line | lap frames | F38 | no (`row.lap` < leader lap) |
| Replay running | Replay status "Running at N×."; pill "Live" | replays | F06 | no |
| Replay paused | Replay status "Paused at lap L (N×)."; the pill **still reads "Live"** (heartbeats continue) | replays | F01 (status visible only in the side panel) | no (the client combines replays + SSE) |
| Replay stopped | "Stopped at lap L."; the pill **still reads "Live"**: a stop sends no `session_end` | replays | F23 | no (client: show STOPPED from replays) |
| Another race replaying | "Another race is replaying."; Start disabled | replays | (none) | no |
| Replay disabled on the API | "Replay is disabled on the API." | replays (`enabled=false`) | F12 | no |
| New run of the same race | `trackRun` bumps the generation: the reducer resets and a fresh stream opens | replays `run_id` | (none) | no |
| Session ended (`session_end`) | Pill "■ Closed (session ended)"; no summary, no archive link | SSE `session_end` | F23 | no for a link + counts from the alerts seen; YES (proposal) for a summary when the page joined late |
| Page opened after `session_end` | Pill "● Live" forever, showing the last snapshot; nothing says the race is over | snapshot only (Pub/Sub keeps no history) | F23 | no (client: replays says `finished`); a full fix is YES (proposal) |
| Health fetch fails | Banner "Checking the data source…" forever (`useHealth` stores null on failure) | health | F12 | no |
| Sample lake | SYNTHETIC DEMO DATA banner; picker "synthetic tyres" tag; "Synthetic tyres" what-if badge; SYNTHETIC notes in analysis and archive; "est." tyre age | health `lake.mode`, `Race.synthetic`, `inputs.synthetic`, `meta.synthetic`, `coverage.is_synthetic` | F10 | no |
| Full lake | "Full lake (HDFS): real timing data" | health | F10 | no |
| SMOKE TEST (sample model scoring) | (Step 3: from `checks.model.smoke_test`.) Before: **Nothing.** The sample model `sample_deploy_real_G3.5_k2` is stamped `smoke_test: true` in its metadata (`src/f1sa/model/deploy.py:91-94`), but no endpoint exposes the stamp | health `checks.model.model_version` (has the `sample_` prefix, `SAMPLE_PREFIX`) | F10 | client parser (prefix rule); YES (proposal) `checks.model.smoke_test` |
| Model identity | Shown **only** in the archive notes. Health returns `model_version`, `feature_set`, `g`, `k`, but `toHealth` (`web/src/lib/api.ts:192`) keeps only `lake`. What-if `model.model_version` is parsed but never shown. | health; whatif; archive | F10 | client parser |
| What-if before a run | "No simulation yet." in a 528 px box | local state | F17 | no |
| What-if default pair | P2 → P1 (often teammates, gap > 3.5 s) → 0% / 0% / 0%, "Model: —" | `attackerChoices`, `defaultDefender` | F15, F16, F12 | no |
| What-if error | `role=alert` from `whatifMessage` | whatif | F12 | no |
| Engineer default focus | P1 (so "Ahead" is empty) unless locked in localStorage | engineer | F19 | no |
| Analysis 404 / archive 404 | "No race analysis … (run make analysis-…)" / "No post-race archive … Build it with make archive-…" | analysis / archive | (none) | no |
| Telemetry not 2024 | `ONLY_2024_NOTE` | telemetry | (none) | no |
| Dark theme | Applies only under `prefers-color-scheme: dark`; no switch | `themeCss` (`lib/theme.ts:108`) | F05 | no |
| Light theme (default today) | "Paper timing sheet" | `themeCss` | F34 | no |
| Desktop 1440×900 | Tower `min-width: 76rem` in a column about 1040 px wide, so Undercut is clipped; alerts in the sidebar under Replay | `globals.css:489` | F01, F02, F06, F07 | no |
| Tablet ≤1080 px | `.dash` becomes one column; the side panels drop below the chart and the what-if | `globals.css:246` | F02 | no |
| Mobile ≤640 px (390×844) | Tower scrolls inside its region (min-width 62rem); alerts start about 2,766 px down; status banner about 102 px tall | `globals.css:249, 529` | F01, F02, F28 | no |
| Reduced motion | Every transition off; the pinned row scrolls without smoothing | `globals.css:263-269`, `TimingTower.tsx:129` | (none) | no |

## Findings that need a server or API change

None of these are made in this step. Each needs your approval, must be additive, and leaves the Redis contract
unchanged.

| Finding | Why the client alone cannot fully fix it | What this step does instead | Proposal |
|---|---|---|---|
| F09 alert history after a late join | Alerts are Pub/Sub messages. The snapshot and Redis hold no alert history. | The call and the feed derive the pairs flagged now from `undercutFlag` + `order` (both in the snapshot) and say "No alerts since you opened this page (lap N)". | **Built (Step 3, 2026-11-19):** `snapshot-0.recent_alerts`, the run's newest 50 alerts from the API's own race-channel recorder (no stream-job or Redis change). The client deduplicates by `event_id`. |
| F10 SMOKE TEST stamp | The `smoke_test` stamp is in the model's metadata, not in any response. | The client parser keeps `checks.model`, and the UI shows SMOKE TEST when `model_version` starts with `sample_` (the existing `SAMPLE_PREFIX` rule). | **Built (Step 3, 2026-11-19):** `checks.model.{smoke_test, trained_on, model_id, stamp}`. The prefix rule is only the fallback. |
| F23 session-end summary for a page that joined late | A page opened after `session_end` never receives it, and a late joiner lacks the earlier alerts. | Replays `state=finished` drives a "Session ended" state in the status strip with a link to the archive. Counts cover only the alerts seen. | Covered by the F09 endpoint, or by linking to the archive bundle (it already holds every alert). |
| F24 gap history from before the page opened | The reducer keeps only the lap frames received. The analysis endpoints hold the **whole** race, so using them in the live view would leak future laps. | The chart's x-axis starts at the first lap it has, and says so. | A causal `GET …/laps?upto_lap=N` (laps ≤ N only). |

The other 34 findings can be fixed in the web client alone. F37 is already fixed (`5e50881`).

## Step 4B (2026-11-19): the last screens

- **Screens:** race analysis (all 8 tabs), telemetry, drivers, the Pipeline panel, "How to read this" and the
  footer.
- **Legacy aliases:** removed from `theme.ts` and `globals.css`. No file reads them;
  `web/tests/legacy-tokens.test.ts` guards this.
- **Detector:** `impeccable detect` reports 0 findings and no suppressions.
- **Not done:** F23 (session-end summary for a late joiner). It needs an API change and was out of scope.
- **Server or API changes:** none were needed for 4B.

## Detector findings carried to later steps

**Resolved in Step 4A (2026-11-19): `impeccable detect --json web/src/app web/src/components` reports 0 findings,
with no suppression in the code.** The same run on HEAD's stylesheet before the step gave the five `side-tab` hits
below. Line numbers are from that stylesheet.

| Line (before) | Selector | Screen and element | Verdict | Resolution (Step 4A) |
|---|---|---|---|---|
| 809 | `.rc-list li.is-key` | Race analysis `/analysis`, race-control tab: key message rows | **Real (F35)** | No side bar. A key row has its message in semibold and a neutral "Key" chip (`RaceControlList.tsx`). This screen was added to 4A by user decision. |
| 848 | `.eng-calls li` (plus `.is-warn`) | Engineer tab: strategy-call rows | **Real (F35)** | No side bar. Rows have hairline dividers and a kind chip: Watch has a 2px solid outline and bold text; Info has a 1px dotted outline and muted text. |
| 890 | `.arc-key` | Post-race archive: race-control key rows | **Real (F35)** | No side bar. Weight plus a neutral "Key" chip. |
| 667 | `.race-status` (`border-left-width: 6px`) | Post-race archive: race-status banner | Was "intentional". **Decided on meaning (user decision):** the border style still carries the track status (DESIGN.md rule 7), but on the code chip, not as a side bar. | The banner is removed. The archive's status strip shows the track code in a chip with the same border styles as the live strip. On its own line, as visible text, it shows the latest key race-control message, its lap and the status source. `RaceStatusBanner.tsx` and its CSS are deleted, so no suppression is needed. |
| 680 | `.race-status.race-status-red` (`border-left-width: 9px`) | Post-race archive: banner, red flag | As line 667 | Removed with the banner. A red flag is the double-bordered chip (as in the live strip). |
