# Reproducing the pipeline and the results

This page takes you from a fresh clone to the demo (sample mode) and to every committed result (full-data mode).
Run all commands from the repository root in a Linux shell, or in WSL 2 on Windows. Prerequisites and memory needs
are in [Prerequisites](#prerequisites) below. All documents: [docs/README.md](README.md).

Ground rules:
- **`results/` is the record.** It holds the committed results. Targets write it only where the tables below say
  so. Most measurement targets need `RECORD=1` and refuse an existing file. Without `RECORD=1`, every
  measurement writes to `data/` (gitignored).
- **2025 is sealed.** It is the test season, and only the targets marked "opens 2025" read it. The test run itself
  is pre-registered (`docs/model_spec.md`, `docs/model_spec_v2.md`) and refuses to run a second time.
- **Volumes are never deleted.** `make down` keeps them. Only `make nuke CONFIRM=yes` deletes them; it is never part
  of a reproduction.
- **The regeneration check.** `make experiments` (full lake) and `make experiments-sample` rerun every regenerable
  generator in a sandbox, `data/experiments/<run_id>/`, and compare each output with `results/` by sha256.
  `results/` itself is never written. This is the quickest way to check that the code still reproduces the
  committed files.

## Prerequisites

The demo runs on the committed sample: two races (2023 R5 and 2024 R5) of real Jolpica laps and pit stops with
**synthetic** tyres and telemetry (`is_synthetic=true`). It needs no credentials, no HDFS and no Java on the
host. The dashboard always shows a **SYNTHETIC DEMO DATA** banner.


| | Windows 11 + WSL 2 | Linux / macOS |
|---|---|---|
| Docker | Docker Desktop with WSL integration for your distro | Docker Engine or Docker Desktop, Compose v2 (`docker compose`) |
| Tools in the shell | `git`, GNU `make`, `python3` 3.8 or newer (only the standard library, for `make up`'s replay check), [`uv`](https://docs.astral.sh/uv/) (installs Python 3.12 itself, for `make sample-data`) | the same (macOS: `make` from the Xcode command line tools) |
| Memory for Docker | `memory=12GB` or more in `%UserProfile%\.wslconfig`, then `wsl --shutdown` | 12 GB or more available to Docker |
| Disk | about 15 GB free (images: app 7.2 GB, web 0.4 GB, kafka 0.7 GB, redis 0.2 GB) | the same |
| Free ports | 3000 (web), 8000 (api), 9092 (kafka), 6379 (redis) on 127.0.0.1 | the same |

- **WSL 2: clone inside the Linux file system** (for example `~/code`), not under `/mnt/c`. Bind mounts and
  Spark are much slower across the Windows boundary.
- **Memory.** The core profile's container limits add up to about 9.6 GiB (kafka 768 MiB, redis 384 MiB, app
  6 GiB, api 2 GiB, web 512 MiB). The demo itself uses far less, and the full table is in
  [architecture.md#memory-budget](architecture.md#memory-budget).
- **User id.** Without a `.env`, `make` builds the app image for your user id (`id -u`), so the containers can
  write `data/` and `models/`. To change ports or the user id, copy `.env.example` to `.env`.
- **A second checkout on the same host.** `docker-compose.yml` fixes the compose project name (`name: f1sa`), so
  a second clone would join a stack that already runs: it would share that stack's `kafka-data` volume and
  rebuild its `:dev` images. Stop the running stack with `make down` (it uses the same ports) and run the second
  clone as its own project, in the same shell as every `make` command of that clone
  ([§4](#4-timing-of-a-fresh-clone)):
  `export COMPOSE_PROJECT_NAME=f1sa-clone F1SA_IMAGE_TAG=clone`.

## 1. Sample mode (no credentials, no HDFS)

| Step | Command | What it does | Time |
|---|---|---|---|
| 1 | `git clone https://github.com/parinithd-27/F1-Strategy-Analytics.git && cd F1-Strategy-Analytics` | | |
| 2 | `make up` | Builds the `f1sa-app` and `f1sa-web` images the first time (about 7.2 GB and 0.4 GB), starts kafka, redis, app, api and web, and waits until they are healthy | see §4 |
| 3 | `make sample-data` | Validates `data/sample` offline (Jolpica subset + SYNTHETIC tyres and telemetry). `REBUILD=1` rebuilds it from the Jolpica cache | seconds |
| 4 | `make demo` | `demo-pipeline`, then `demo-replay` (below). It prints `Dashboard: http://localhost:3000/race/2024/5  (SYNTHETIC DEMO DATA)` | see §4 |
| 5 | `make down` | Removes the containers and keeps the volumes | |

**`make demo-pipeline`** runs the sample pipeline in the running `app` container (`docker compose exec`):
1. `python -m f1sa.etl.clean --source sample` builds `data/lake/clean`.
2. `python -m f1sa.etl.entrants` builds the display-only per-race **entrants** table (`clean/entrants`: driver,
   team, colours).
3. `python -m f1sa.etl.analysis --source sample` builds the display-only post-race **analysis** tables
   (`clean/analysis_*`: laps, stints, pit stops, race control, positions).
4. `python -m f1sa.features.build --source sample --results-dir data/demo/demo_<stamp>` builds
   `data/lake/features`. The undercut counts go to `data/demo/`, not `results/`.
5. `python experiments/model_save.py --source sample --force` builds the **sample deployment model**
   `models/undercut/sample_deploy_real_G3.5_k2/`, which is what the stream job scores with.
   - It is the frozen procedure on the two sample races: 2023 R5 trains it and 2024 R5 calibrates it.
   - It is stamped `smoke_test: true` (SMOKE TEST). Its probabilities are not findings.
   - The comparison with a development run is skipped (the sample has none). The reload round trip and the
     pure-Python scorer against Spark still run.
   - It never writes `models/undercut/deploy_*` or `results/`. The real deployment model is built from the full
     lake (`make model-save-full`) and is not part of the demo.
6. `python -m f1sa.archive.build --source sample --model-dir <sample model>` builds the **post-race archive**
   bundles (`data/lake/archive`): each sample race replayed lap by lap through the stream path with the sample
   model, for the post-race viewer.
7. `python -m f1sa.sim.tyre_model --source sample` builds the what-if tyre model `models/sim/tyre_model_sample.json`.

**`make demo-replay`** starts the replay:
1. It runs `make api-up REPLAY=1 MODEL_DIR=models/undercut/sample_deploy_real_G3.5_k2`, which recreates only the api
   container.
2. It runs `python -m f1sa.demo_replay` in the app container. That script:
   - checks `/api/health`: Redis, Kafka and the sample model must be ok, and the lake must be synthetic;
   - checks that 2024 R5 is listed and marked synthetic;
   - starts a 60x replay;
   - waits until 20 cars are in Redis.
3. Options:
   - `DEMO_WAIT=finished` also waits for the replay to finish (CI uses it);
   - `DEMO_SPEED=1|10|60`, `DEMO_SEASON=` and `DEMO_ROUND=` choose the replay.
4. Outputs: `data/demo/<run_id>/` (`make demo-clean` lists them).

Open the printed URL while the replay runs (about 2 minutes at 60x). Start another replay from the page, or run
`make demo-replay`. Use `localhost`, not `127.0.0.1`: it is the API's CORS origin.

**Other sample targets** (on the host; they need Java 17 and `uv sync --all-extras`):
- `make etl-sample`, `make features-sample`, `make model-eval-sample`, `make sim-tyre-model-sample` and
  `make whatif-consistency-sample`;
- `make stream-demo SEASON=2024 ROUND=5 SPEED=10`, which runs the producer, stream job and subscriber on the host and
  writes `data/demo/<run_id>/`;
- `make experiments-sample`, the sample regeneration check: 1 min 27 s, and exit 0 means every compared file is OK.

## 2. Full-data mode (HDFS, 2021–2025)

Needs `make up-full`, which adds namenode, datanode, HttpFS, the Spark master and two workers. Give Docker about
14 GB.

| Step | Command | Writes | Notes |
|---|---|---|---|
| 1 | `make up-full` | | core + hdfs + spark, waits until healthy |
| 2 | `DATA_LAKE_URI=hdfs://namenode:8020/f1 uv run f1sa-ingest season-range --seasons 2021-2025 --sources jolpica --sink hdfs` | HDFS `/f1/raw/jolpica/...`, `data/manifest.json` | about 3 h: at most 4 requests/s and 450 requests/h. Cached and resumable (`--only-failed`). `--dry-run` prints the plan and an ETA. `--sources jolpica,fastf1` needs F1 TV Access (`F1_USERNAME`, `F1_PASSWORD`) |
| 3 | `make ingest-ti-full` | HDFS `/f1/raw/tracinginsights/...`, `data/manifest_tracinginsights.json` | TracingInsights at the commits in `src/f1sa/ingest/tracinginsights_pins.json`, each file checked against its git blob id. Resumable; `SKIP_RAW_TELEMETRY=1` keeps no raw 2024 samples |
| 4 | `make pipeline-full` | `/f1/clean`, `/f1/features`; `results/undercut_counts_full.csv`, `full_data_quality.json`, `constructors_full.csv`, `neutralisation_by_race_full.csv` | `etl-full`, `features-full`, `report-full` |
| 5 | `make etl-ti-full` then `make reconcile-ti-full` | `/f1/clean/*_tracinginsights`, `telemetry_lap_real`; `results/tracinginsights_coverage_full.csv` | reconcile is read-only (expect `result: PASS`) |
| 6 | `make model-dev-full model-dev-tyre-full model-dev-ti-full model-dev-permutation-ti-full` | `results/model_dev_*` | development, 2021–2024 only |
| 7 | `make model-save-full` | `models/undercut/deploy_real_G3.5_k2/` | the deployment model (2025 never read). It refuses an existing folder unless `FORCE=1`, and must reproduce the development run |
| 8 | `make sim-tyre-model-full` | `models/sim/tyre_model_full.json` | `TEST_SEASON=1` adds the 2025 entries that the RECORD what-if run needs |
| 9 | `make api-up FULL=1 REPLAY=1` | | dashboard on the full lake (90 races) |

- **Scope.** The lake holds 114 races (2021–2025), and the API serves the 90 of 2021–2024 (2025 is the sealed
  test season).
- **FastF1, optional.** Since October 2026 FastF1 needs an **F1 TV Access** login (`F1_USERNAME`, `F1_PASSWORD`
  in the environment, never committed). Without one it returns empty sessions, and the loaders fail loudly. The
  project's results use TracingInsights instead.
- **The single 2025 test run**, `make model-test-full CONFIRM=yes`, is pre-registered and refuses to run twice.
- **Serve the full lake after a `make down`.** `make api-up FULL=1` needs the hdfs profile, so start the full stack
  again with `make up-full` first (the HDFS volumes are kept), then run `make api-up FULL=1 REPLAY=1` and, for a
  rebuilt dashboard, `make web-up`.

## 3. Every target that writes `results/`

### Experiments at a glance

Every experiment is a make target. Targets with `RECORD=1` write `results/` and refuse to overwrite an existing
file. Without `RECORD`, they write only to `data/`. `make experiments` (full lake) and `make experiments-sample`
rerun every regenerable generator in a sandbox and compare each output byte for byte with the committed
`results/`. They never write `results/`. Method, runtime and limits are in [experiments.md](experiments.md).

| Experiment (traceability #) | Command | Runtime on the dev host | Outputs |
|---|---|---|---|
| Model evaluation, chronological split, calibration (#29, #39) | `make model-dev-full`; the 2025 test run `make model-test-full CONFIRM=yes` (once) | 211 s per development run (both settings) | `results/model_dev_*`, `results/model_eval_*`, `results/calibration_*` |
| Paired ablation intervals (#30) | `make ablation-full RECORD=1` | 1 min 45 s | `results/ablation_paired.{csv,png}` |
| ORACLE out-lap variant, development data only (#30) | `make oracle-dev-full RECORD=1` | 2 min 49 s | `results/model_dev_{eval,loso}_oracle*.csv` |
| Spark scalability, 1/3/5 seasons (#27, #33, #38) | `make experiments-spark RECORD=1 GRID_ARGS="..."` (overnight, nothing else running) | hours | `results/scalability.csv`, `scalability_{build,telemetry}.png` |
| Partitioning and caching (#28, #34) | part of `make experiments-spark` | about 0.5 h (estimate) | `results/partitioning.csv`, `partitioning_speedup.png` |
| Streaming replay latency, throughput, resources (#31, #35, #36, #38) | `make stream-latency-suite RECORD=1` (core profile only) | 28 min 28 s | `results/streaming_*` |
| UI render latency (#35) | `make api-up DEBUG=1 UI_LATENCY_CSV=data/demo/ui_latency/ui_latency.csv`, then `make stream-latency-ui RECORD=1` | 2 min 9 s | `results/ui_latency*.csv` |
| Redis latency at streaming rates (#37) | `make redis-latency RECORD=1` | 3 min 31 s | `results/redis_latency_quiet.csv` |
| What-if consistency + backtest (#32, #40) | `make whatif-consistency-full RECORD=1` | 17 s (development run) | `results/whatif_consistency.{csv,png}` |
| Regeneration check (all non-2025 generators) | `make experiments` / `make experiments-sample` | 19 min 26 s / 1 min 27 s | `data/experiments/<run_id>/summary.txt` |

### The full list

Every file in `results/` is tracked by git (154 files; `git ls-files results`).
- "Refuses" means the target stops before any work if one of its output files exists, prints which ones and
  exits 2, so a committed result cannot be replaced by accident.
- "Overwrites" means it rewrites the file. Those targets are deterministic, and `make experiments(-sample)`
  checks that a rerun gives the same bytes.

**Escape hatch for a deliberate new recording: `RECORD=1 OVERWRITE=1`.**
- The existing output files are first **moved** to `data/results_backup/<UTC stamp>/`, which is gitignored.
  Nothing is ever deleted, and an existing backup folder is refused.
- `stream-demo` moves them before it starts, because its stream job writes into `results/` while it runs.
- `experiments-spark` checks at the start and moves the files only right before it writes, when the grid or
  partitioning is complete. An interrupted run leaves `results/` intact, and its printed resume command
  carries `OVERWRITE=1`.
- **RESUME rule: a resumed run may only rewrite the files it was the last to record.**
  - `RESUME=<run_id>` of the same recording passes without `OVERWRITE=1` only for files whose last
    fingerprint section in `results/README.md` is that run's (`bench.host.fingerprinted_file`).
  - Any other existing file is refused as usual.
  - A later `bench-supplement` merge into `scalability.csv` therefore takes the file over. A resume of the
    original run can no longer rewrite it from its own grid and drop the merged rows.
  - Example: `make experiments-spark RECORD=1 RESUME=bench_20261113T152740Z` is refused for the three
    scalability files, because `bench_20261114T052031Z_supp` recorded `scalability.csv` after it. Its
    partitioning files are still its own.
- The pre-registered recordings (`model-test-full`, `ablation-full`, `oracle-dev-full`,
  `whatif-consistency-full`) have **no** `OVERWRITE`: the first complete run is the reported one.
- The shared guard is `src/f1sa/recording.py`.

| Target | Files in `results/` (all git-tracked) | Existing file | `OVERWRITE=1` | Opens 2025 | In `make experiments` |
|---|---|---|---|---|---|
| `make features-sample` | `undercut_counts_sample.csv` | overwrites (deterministic) | — | no | sample: compared |
| `make model-eval-sample` | `model_eval_sample.csv`, `calibration_sample.csv`, `feature_importance_sample.{csv,png}`, `reliability_sample.png`, `confusion_matrix_sample.png` | overwrites (deterministic) | — | no | sample: compared |
| `make features-full` (`pipeline-full`) | `undercut_counts_full.csv` | overwrites (deterministic) | — | counts only, no model | no |
| `make report-full` (`pipeline-full`) | `full_data_quality.json`, `constructors_full.csv`, `neutralisation_by_race_full.csv` | overwrites (deterministic) | — | data quality only | no |
| `make etl-ti-full` | `tracinginsights_coverage_full.csv` | overwrites (deterministic) | — | coverage only | no |
| `make model-dev-full`, `model-dev-tyre-full`, `model-dev-ti-full` | `model_dev_{eval,loso,calibration,class_balance,feature_importance,missing_rates,metadata,...}*` | overwrites (deterministic) | — | no | full: compared |
| `make model-dev-permutation-ti-full` | `model_dev_permutation_real_ti*.csv` | overwrites (deterministic) | — | no | full: compared |
| `make stream-parity-full` | `stream_parity_full.csv` | overwrites (deterministic) | — | no | full: compared |
| `make model-test-summary` | `model_test_summary.csv` + the Results tables of `docs/model_results.md` (from the committed files, no evaluation) | overwrites (deterministic) | — | reads committed files only | skipped (unit-tested) |
| `make model-test-full CONFIRM=yes` | `model_eval*`, `calibration*`, `feature_importance*`, `reliability*`, `confusion_matrix*`, `missing_rates*` (per feature set and setting) | **refuses** | no (pre-registered) | **yes**, once | skipped |
| `make ablation-full RECORD=1` | `ablation_paired.{csv,png}` + README section | **refuses** | no (pre-registered) | **yes** (frozen models) | skipped |
| `make oracle-dev-full RECORD=1` | `model_dev_{eval,loso}_oracle{,_G5.0_k3}.csv` | **refuses** | no (pre-registered) | no | full: compared (sandbox) |
| `make whatif-consistency-full RECORD=1` | `whatif_consistency.{csv,png}` (with the 2025 row) | **refuses** | no (pre-registered) | **yes** | without RECORD: compared without the 2025 rows |
| `make stream-latency-suite RECORD=1` | `streaming_latency_{s10,s60,s1w900}.csv`, `stream_{batches,progress}_{tag}.jsonl`, `streaming_{latency_summary,throughput,resources}.csv` + README sections | **refuses** | yes (backup before copying) | no | skipped (measurement) |
| `make stream-latency-ui RECORD=1` | `ui_latency.csv`, `ui_latency_summary.csv`, `stream_*_s60ui.*`, `ui_streaming_*.csv` | **refuses** | yes (backup before copying) | no | skipped (measurement) |
| `make redis-latency RECORD=1` | `redis_latency_quiet.csv` + README section | **refuses** | yes (backup right before the write) | no | skipped (measurement) |
| `make stream-demo RECORD=1` | `streaming_latency.csv`, `stream_progress.jsonl`, `stream_batches.jsonl` (the recorded streaming run) | **refuses** (before any process starts) | yes (backup before the run) | no | skipped (measurement) |
| `make experiments-spark RECORD=1` | `scalability.csv`, `scalability_{build,telemetry}.png`, `partitioning.csv`, `partitioning_speedup.png` + README fingerprints | **refuses** (`check-record` over all five files before the grid; each script again at its start) | yes (backup only when complete) | 2025 timing rows for scale only, no labels | skipped (hours) |
| `make experiments-spark RECORD=1 RESUME=<run_id>` | as above | allowed for the files this run recorded last; others refused | as above | as above | skipped |
| `make bench-supplement RECORD=1 SUPPLEMENT_OF=… CELLS=…` | appends re-run rows to `scalability.csv`, redraws the plots | own guard: refused if a named cell is `ok` or already re-run | not applicable (a merge) | as above | skipped |
| `make bench-replot RECORD=1` | `scalability_build.png` only | **refuses** | yes (backup before redrawing) | no | skipped |
| api with `ENABLE_DEBUG=1` (`make api-up DEBUG=1`) | none by default: samples go to `data/demo/ui_latency/ui_latency.csv`. With `UI_LATENCY_CSV=results/...` it appends | **refuses** an existing results/ CSV (before the container is recreated, and again at api start-up) | yes (`make api-up … OVERWRITE=1` backs it up host-side) | no | — |

No other target writes `results/`. `make demo`, `make stream-demo` (without RECORD), API replays,
`make sim-tyre-model-*`, `make model-save-full` and `make bench-smoke` write only `data/` or `models/`. A pytest
session fails if any test adds, changes or deletes a file in `results/` (`tests/_results_guard.py`).

**Fingerprints.** Every recorded measurement appends an environment section to `results/README.md`: git sha,
CPU, memory, container limits and versions.

## 4. Timing of a fresh clone

On the dev host, `make demo` takes about **193 s** (clean clone of 2026-11-19 with a warm image cache; `make up`
63 s). An earlier clean clone (2026-11-14) took 5 min 57 s for an image build without cache plus
`make up && make sample-data && make demo`, when `make demo` took 103 s because it did not yet build the
entrants, analysis and archive tables. Base images and package caches were warm both times, so a first run on a
new machine also pays for the downloads (below).

Measured with the clean-clone check (below). The clone ran as its own compose project, so its containers,
volumes and image tags were separate:

```bash
export COMPOSE_PROJECT_NAME=f1sa-clone F1SA_IMAGE_TAG=clone
docker compose --profile core build --no-cache
time (make up && make sample-data && make demo)
```

Result (2026-11-14, the dev host: WSL 2, 12 logical CPUs, about 14 GB; a GitHub clone of `main` plus the
then uncommitted reproducibility changes, no `.env`):

| Phase | Time |
|---|---|
| `docker compose --profile core build --no-cache` (app and web images) | 224 s |
| `make up` (start and wait until healthy) | 26 s |
| `make sample-data` | 4 s |
| `make demo` (sample ETL, features, sample model, tyre model, api recreate, 60x replay until 20 cars are in Redis) | 103 s |
| **Total** | **357 s (5 min 57 s)** |
| Playwright smoke test afterwards (`E2E_NO_SERVER=1`, against the web container) | passed, 1.8 min |

What stayed warm, so a first run on a new machine takes longer:
- the base images (`eclipse-temurin`, `node`, `apache/kafka`, `redis`) and the downloads cached on the host:
  uv's package cache (`make sample-data` creates the clone's `.venv` from it), npm's cache and Playwright's
  Chromium;
- `--no-cache` rebuilt every layer, but each package still came from a local cache or mirror where Docker and uv
  keep one.

On a new machine, the image pulls and the Python and Node downloads add their network time, several GB in total.

## 5. Tests and CI

| Suite | Command | Needs | In CI |
|---|---|---|---|
| Python unit tests | `make test` (`uv run pytest tests/unit -q`) | Java 17 on the host (Spark `local[2]`) | yes (`python` job) |
| Lint, format, types | `make lint typecheck` | | yes |
| Traceability | `uv run python scripts/check_traceability.py` | | yes |
| Dashboard | `make web-test` (ESLint, `tsc`, Vitest), `cd web && npm run build` | Node 26 | yes (`web` job) |
| Demo + streaming smoke + Playwright | `make up && make sample-data && make demo DEMO_WAIT=finished`, then `cd web && npx playwright install --with-deps chromium && E2E_NO_SERVER=1 npx playwright test e2e/smoke.spec.ts` | Docker, core profile | yes (`e2e` job) |
| Integration tests | `make up-full && make test-int` (`uv run pytest tests/integration -q -m integration`) | HDFS, HttpFS, Spark standalone, Kafka, Redis | **no**: CI runners cannot host the full profile in time; run them by hand |
| UI latency e2e | `web/e2e/latency.spec.ts` | API with `DEBUG=1`, gated | no |

CI (`.github/workflows/ci.yml`) runs the three jobs in parallel, each under 30 minutes, with the uv and npm caches.
It never uses the full profile, full data, 2025 or `RECORD=1`.

**For developers.**

```bash
make setup                 # uv sync --all-extras
make lint typecheck test   # ruff, mypy, Python unit tests (Java 17 needed on the host for Spark tests)
make web-test              # dashboard lint, typecheck, Vitest
uv run python scripts/check_traceability.py
```

- **CI** (`.github/workflows/ci.yml`) runs these checks. It also runs an end-to-end job on the core profile:
  `make up`, `make sample-data`, `make demo DEMO_WAIT=finished` and the Playwright smoke test.
- **Integration tests** (`tests/integration`, which need `make up-full`) are run by hand (table above).
- Step-by-step build history: the [engineering log](dev/engineering_log.md).

## 6. Clean-up

| Command | Removes |
|---|---|
| `make down` | the containers (volumes kept) |
| `make demo-clean [CONFIRM=yes]` | `data/demo/<run_id>/` and the demo and replay checkpoints |
| `make bench-clean [CONFIRM=yes]` | benchmark data in `data/bench` and HDFS `/f1/bench` |
| `make nuke CONFIRM=yes` | **containers and volumes** (Kafka log, HDFS data). Not needed for any reproduction |
