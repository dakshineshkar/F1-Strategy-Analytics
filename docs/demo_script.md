# Demo script: F1 Strategy Analytics at Scale

A timed live demo for the course presentation: a **10-minute** version and a **5-minute** short version. The demo
race is the **2024 Chinese Grand Prix (2024 R5)** on the **full lake (HDFS)**, the race in the report's screenshots.
Every number you say aloud is in `docs/report/report.md` (Appendix A gives its source).

- **Roles:** one presenter drives the browser and one speaks, or one person does both.
- **Screen:** the browser at 1440×900 or larger, and a terminal in the repo root (WSL bash).
- **URLs:** use `localhost`, not `127.0.0.1` (it is the API's CORS origin).

## Before the demo (start 20 minutes early)

### 1. Start the stack in full mode

```bash
make up-full                   # core + hdfs + spark, waits until healthy (refused while a replay runs)
make api-up FULL=1 REPLAY=1    # recreates only the api: HDFS lake, replays enabled, deployed model
make web-up                    # rebuilds and recreates only the web container (skip if it is current)
```

### 2. Checks (all must pass; otherwise go to "Fallback plan")

| Check | Command | Expected |
|---|---|---|
| Containers healthy | `make ps` | kafka, redis, app, api, web, namenode, datanode, httpfs, spark-master and both workers up / healthy |
| API health, full lake, real model | `curl -s localhost:8000/api/health \| python3 -m json.tool` | HTTP 200; `lake` scheme hdfs, mode `full`, not synthetic; `checks.model` names `deploy_real_G3.5_k2`, `smoke_test` false, `trained_on` full |
| Race catalog | `curl -s localhost:8000/api/races \| python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'` | `90` (2021–2024; 2025 is sealed) |
| No replay running | `curl -s localhost:8000/api/replays \| python3 -m json.tool` | no replay in state `starting`, `running` or `paused` |
| Post-race archive exists | `curl -s localhost:8000/api/archive \| python3 -m json.tool \| grep -c '"round"'` | a count above 0, with 2024 R5 in the list (if missing: `make archive-full ARCHIVE_SEASON=2024 ARCHIVE_ROUND=5` before the demo) |
| Telemetry traces (2024) | `curl -s "localhost:8000/api/races/2024/5/telemetry/laps?driver=VER" \| head -c 200` | JSON with lap rows, not a 404 (if missing: `make telemetry-trace-full`) |
| What-if tyre model | `ls -l models/sim/tyre_model_full.json` | the file exists (if missing: `make sim-tyre-model-full`) |

### 3. Prepare the screens

- **Browser tabs, in order:**
  1. `http://localhost:3000` (the race picker);
  2. `http://localhost:3000/race/2024/5/analysis` (race analysis);
  3. this script.
- **Terminal:** clear it. Keep the commands for "Pipeline proof" ready, but do not run them yet.
- **Rehearsal side effects:** do not start the replay before the demo. If a rehearsal run is still going, stop it
  (Replay controls → Stop). After `make api-up` the race page may show **NOT REPLAYING**: a rehearsal's state is
  still in Redis, nothing streams, and the call is one line with no pair. That is expected. A new start deletes the
  race's old Redis keys first, so the demo begins clean.
- **The theme** is Dark by default (top-right switch). Use Light on a washed-out projector.

### 4. Prebuild the sample fallback (about 2.5 minutes)

```bash
make sample-data     # validates data/sample offline
make demo-pipeline   # sample ETL, features, SMOKE TEST model, archive and tyre model, in the app container
```

`make demo-pipeline` took 153 s on the dev host (2026-11-19) with the full stack running. It writes only the
file:// sample lake (`data/lake`), `models/undercut/sample_*`, `models/sim/tyre_model_sample.json` and
`data/demo/`, never `results/`, and it does not touch the running full-mode api. After this, the fallback needs
no pipeline run during the demo.

## 10-minute demo

At 10x a full replay of 2024 R5 takes about 9–10 minutes of wall time. It keeps running in the background through
segments 3–6. Times are cumulative.

| Time | Segment | Show and click | Say (2–3 sentences) | Expected result |
|---|---|---|---|---|
| 0:00–0:45 | **1. Race picker** | Tab 1 (`localhost:3000`). Point at the **Start here** card (the demo race). Type "Chinese" in **Search races**, then click **Chinese Grand Prix** (R05) under 2024. | "This is the race catalog, read from the clean zone on HDFS: the 90 races of 2021–2024. 2025 is not listed, because it is the sealed test season that the model was evaluated on once." | The counter shows "N of 90 races" while filtering. The race page opens with the data banner "Full lake (HDFS): real timing data" and the status strip; its mode chip reads **NO REPLAY**, or **NOT REPLAYING** if a rehearsal's state is still in Redis. |
| 0:45–2:00 | **2. Live replay at 10x** | In the status strip click **Replay controls**, choose **10×**, then **Start replay**. | "Starting a replay sends this race's events into Kafka in race order, ten times faster than real time. Spark Structured Streaming reads them every 500 ms, rebuilds the decision features, applies the undercut rule and the calibrated model, and writes Redis. The page receives every change over Server-Sent Events, without polling." | The mode chip shows **REPLAY 10×**, the lap counter climbs, and the connection reads "Stream connected". The timing tower fills with 20 cars within a few seconds (the first batch loads the priors, about 1.3–1.4 s more). |
| 2:00–3:15 | **3. The call and the alert feed** | Point at **The call** (top right): the pair, the probability and its model id, the gap gauge, the pit loss and tyres, the rule line. Then the **Undercut alerts** list under it. Hover a row's count ("2×"). | "The call is the best eligible pair right now. The percentage is a model estimate: a calibrated logistic regression trained on 2021–2023 and calibrated on 2024, and the model id is printed under it. The gauge shows the gap against the 3.5-second rule window, with the trend to next lap. The alert feed lists only changes: a pair that becomes a candidate, crosses 50%, or whose attacker pits." | A call with attacker → defender, "N more flagged" in its header, the "model estimate …" line with the model id `deploy_real_G3.5_k2`, and the gauge. Alerts are tagged Candidate, Opportunity or Attempt, the newest are marked "new", and "N more below" counts the rest. |
| 3:15–4:00 | **4. Late join** | Open the same race URL in a **new tab** (Ctrl+L, Ctrl+C, Ctrl+T, Ctrl+V, Enter). | "A viewer who joins mid-race gets the full state at once: the API pushes a snapshot from Redis on connect, plus the run's recent alerts. Pub/Sub keeps no history, so the gap chart honestly starts at the lap you opened; it never back-fills." | The tower and the call appear immediately. The alert feed shows "Received before you opened the page". The gap chart starts at the current lap. If the call's defender is no longer directly ahead, the call reads "flagged at lap N against D; order changed since" with a muted gauge (say: "the call never relabels its defender"). Cars that stopped crossing the line show "no timing since L…". Close the tab afterwards. |
| 4:00–5:15 | **5. What-if** | Back in the first tab, click **Simulate this pair** on the call. Scroll to **What-if: pit strategy**. Open "How to read this" if asked. | "The simulator answers: if the attacker pits now, next lap, or stays out, how often is it ahead once both cars have stopped? It is a seeded Monte Carlo of 500 draws, with tyre models fitted only on earlier races. Read it as a comparison between strategies, not as odds: on 2025 its calibration error is about twice the model's, 0.207 against 0.107." | Three rows (pit now, pit next lap, stay out), each with "Share of sim runs ahead", the expected gap and its 80% range. The model estimate is shown next to them, unchanged. |
| 5:15–6:00 | **6. Engineer view** | Click the **Engineer** tab (next to Race). Pick a focus driver in the select (for example the call's attacker). | "The engineer view is the same live state from one car's seat: the cars directly ahead and behind, the gap trend, and where the car would rejoin if it pitted now. It reads Redis and the race's lap log; it does not re-score anything." | The Ahead / Focus / Behind columns, the "Data to lap N" line, the **Gaps** to the car ahead and behind with their trend lines, and "If X pits now: rejoins P… behind …" with the rejoin axis. |
| 6:00–7:00 | **7. Post-race archive** | Click **Post-race (archive)** (next to Live). Drag the lap slider, then press play at 10×. Point at the marker lanes **Flags**, **Pits**, **Alerts**. | "After a race you can scrub it lap by lap. The archive was built by the stream job's own processor and scorer, not by a second implementation, and a check proves it equals a live replay at the checked laps (`make archive-equivalence`)." | The strip reads **POST-RACE** with the lap, the track chip and the latest key race-control message. The tower, gap chart and alerts follow the chosen lap (−1 lap / Play / +1 lap, speeds 1× 10× 60×). The URL carries `?mode=archive&lap=N`. Markers for track status, pit stops and alerts. |
| 7:00–7:45 | **8. Race analysis and telemetry** | Tab 2 (`/race/2024/5/analysis`). Click **Tyre strategy**, then **Lap times**, then **Telemetry**. In Telemetry, choose two drivers and a lap each. | "These views read display-only tables built in Spark from the clean zone and cached in Redis: stints, lap times, degradation, positions, pit stops and race control. Telemetry overlays exist for 2024: speed, throttle, brake and gear on one distance axis, with the time delta." | Strategy bars per driver; lap-time lines; two telemetry traces with a delta lane. |
| 7:45–9:15 | **9. Pipeline proof** | Terminal: `uv run python scripts/check_traceability.py \| tail -1`, then `head -3 results/stream_parity_full.csv`, then `sed -n '/primary setting): 49/,/rule baseline/p' docs/model_results.md \| head -12`. | "Every one of the 44 requirements of the project proposal maps to code, tests and proof, and CI checks that every file named exists. Batch and streaming use one rule and one scorer: on 90 races, 34,608 eligible pairs and 157 labelled attempts matched, with a maximum probability difference of 3.3e-16. On the sealed 2025 season the calibrated model reached PR-AUC 0.670 against the rule baseline's 0.513, with overlapping intervals, so we claim no significant difference." | The checker prints one line: "traceability: OK n, GENERATED n (no MISSING or PENDING line)". The parity CSV shows `ok` True rows. The model table shows all eight 2025 rows at the primary setting, including the majority and rule baselines. |
| 9:15–10:00 | **10. Scope, then stop** | Replay controls → **Stop** (or let it finish). | "Scope: 49 labelled test attempts, so the intervals are wide. Everything runs on one host, and the larger Spark inputs are synthetic copies. FastF1 needs an F1 TV login, so the FastF1-derived data comes from TracingInsights. The replay carries hindsight track status. The simulator is less well calibrated than the model." | The mode chip shows STOPPED (or FINISHED), and the strip offers **Open the post-race archive**. |

## 5-minute short version

| Time | Segment (from the 10-minute table) | What to cut |
|---|---|---|
| 0:00–0:20 | 1. Race picker | Click **Open the race** on the Start here card; no search. |
| 0:20–1:10 | 2. Live replay at 10x | One sentence on Kafka → Structured Streaming → Redis → SSE. |
| 1:10–2:10 | 3. The call and the alert feed | No count hover. |
| 2:10–3:05 | 5. What-if | Only "Simulate this pair" and the caveat sentence. |
| 3:05–3:45 | 7. Post-race archive | One slider drag, no playback. |
| 3:45–4:30 | 9. Pipeline proof | Only `check_traceability.py` and the parity sentence. |
| 4:30–5:00 | 10. Scope, then stop | The first three scope points only. |

Skipped: late join, engineer view, race analysis and telemetry. Mention them in one sentence if time allows.

## Fallback plan

| Problem | Sign | What to do | What to say |
|---|---|---|---|
| **HDFS or the full lake fails** | `make up-full` does not get healthy, `/api/health` is 503, `/api/races` is 503, or the data banner says "Data source unavailable" | 1. Stop any replay (below). 2. `make up` (63 s on a clean clone, README; the images are already built, so `--build` only checks the cache). 3. `make demo-replay DEMO_SPEED=10` (28 s on the dev host: it recreates the api in **sample mode** with the prebuilt SMOKE TEST model, starts a 10x replay of 2024 R5 and waits until 20 cars are in Redis; it prints `Dashboard: http://localhost:3000/race/2024/5  (SYNTHETIC DEMO DATA)`). This needs step 4 of "Before the demo"; without it, run `make demo-pipeline` first (about 153 s more). 4. Run the same segments on that page; skip telemetry (the sample has none). | "This is sample mode: the same pipeline on two real Jolpica races with **synthetic** tyres, shown by the SYNTHETIC DEMO DATA notice. The model is marked **SMOKE TEST**: it was trained on a single sample race, so its probabilities show the plumbing, not model quality. The real model's results are in the report." |
| **The browser fails** (crash, projector, network to the page) | the page does not load or render | Show the screenshots in `docs/design/after/`: `d-dark-mid.png` (lap 20: the call SAR → ZHO at 78%, the tower and the alerts), `d-dark-latejoin.png` (late join at lap 45, with the "order changed since" call), `m-dark-mid.png` (phone), `d-dark-engineer.png`, `d-dark-archive.png`, `d-dark-analysis-strategy.png` and `d-dark-picker.png`. The what-if panel exists only as `docs/design/before/d-dark-whatif.png` (captured before the redesign). The report's figures are in `docs/report/report.pdf`. | "These are screenshots of the same race on the full lake, taken from the running dashboard." |
| **A replay hangs** (the lap counter stops, or the status stays "Starting…") | `curl -s localhost:8000/api/replays` shows the run stuck | 1. Replay controls → **Stop**. 2. If the page does not respond: `curl -s -X POST localhost:8000/api/races/2024/5/replay/stop`. 3. Confirm with `curl -s localhost:8000/api/replays` that nothing is `starting`, `running` or `paused`. 4. Start again: Replay controls → 10× → **Start replay** (a fresh start deletes the race's old keys first), or `curl -s -X POST localhost:8000/api/races/2024/5/replay -H 'content-type: application/json' -d '{"speed":10}'`. | "A stop ends both the producer and the stream job; a new start begins from a clean slate." |
| `make api-up` or `make web-up` refuses | "refused while a replay runs" | Stop the replay as above, then repeat. Use `FORCE=1` only if no replay should be running at all; it cuts off the running replay. | |

## Likely questions from the graders

**Why TracingInsights and not FastF1?**
Since mid-October 2026, FastF1 downloads need an F1 TV Access login, which nobody on the team has. Without it FastF1
returns empty sessions. TracingInsights publishes the same FastF1-derived laps, tyres, race control and telemetry
per season. We download it at pinned commits and check every file against its git blob id. The direct FastF1 loader
is kept, tested, and fails loudly, so requirement #4 is marked partial, not done.

**Why is logistic regression deployed and not GBT?**
It was chosen before the test run by a pre-registered rule: the lowest calibrated validation Brier on 2024, 0.168
against 0.205 for GBT. On 2025 calibrated GBT had a slightly higher point PR-AUC (0.703 against 0.670) but a worse
Brier, and we did not re-choose on test results. LR also runs in the stream as a pure-Python scorer, equal to Spark
within 1e-9, so streaming needs no extra Spark job per micro-batch.

**How is leakage prevented?**
A feature for a decision at lap L uses only information available at the end of lap L − 1. There are three
safeguards:
- Lap features are joined at L − 1.
- Priors use window frames over strictly earlier races only (`RANGE BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`).
- Realised out-lap values are ORACLE-only.

A unit test scales the target race from lap L on, and every later race, ×100, and asserts that every decision
feature is unchanged. Track status uses a whole-race heuristic, so it is used only to exclude laps, never as a
feature.

**Why was 2025 evaluated only once?**
To keep the test honest. The features, grids, calibration rule, threshold, metrics and primary model were frozen in
`docs/model_spec.md` and `docs/model_spec_v2.md` before any 2025 number was seen. The pipeline refuses to start a
second test run when its result files exist. A rerun is allowed only after a crash that produced no test number,
which happened once.

**How do you prove the stream equals the batch?**
Batch and stream call the same pure-Python rule (`features/undercut_rule.py`) and the same calibrated scorer.
`make stream-parity-full` replays every 2021–2024 race through the stream processor in micro-batches of 1, 7 and 50
events, including a lagging partition. It compares the eligible pairs at every decision lap, and every labelled
attempt's 21 inputs and probability, against Spark. Result: 90 races, 34,608 eligible pairs and 157 labelled
attempts matched; maximum input difference 0.0, maximum probability difference 3.3e-16
(`results/stream_parity_full.csv`).

**Is the model better than the rule?**
On every point estimate, yes: PR-AUC 0.670 against 0.513, and Brier 0.177 against 0.273. The intervals overlap with
49 attempts in 19 races, so we make no significance claim.
