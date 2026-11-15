# Reproducing the pipeline and the results (Step 17, commitment #42)

This page takes you from a fresh clone to the demo (sample mode) and to every committed result (full-data mode).
Run all commands from the repository root in a Linux shell, or in WSL 2 on Windows. Prerequisites and memory needs
are in the [README](../README.md#prerequisites).

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
2. `python -m f1sa.features.build --source sample --results-dir data/demo/demo_<stamp>` builds
   `data/lake/features`. The undercut counts go to `data/demo/`, not `results/`.
3. `python experiments/model_save.py --source sample --force` builds the **sample deployment model**
   `models/undercut/sample_deploy_real_G3.5_k2/`.
   - It is the frozen procedure on the two sample races: 2023 R5 trains it and 2024 R5 calibrates it.
   - It is stamped `smoke_test: true`.
   - The comparison with a development run is skipped (the sample has none). The reload round trip and the
     pure-Python scorer against Spark still run.
   - It never writes `models/undercut/deploy_*` or `results/`.
4. `python -m f1sa.sim.tyre_model --source sample` builds `models/sim/tyre_model_sample.json`.

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

## 3. Every target that writes `results/`

Every file in `results/` is tracked by git (154 files; `git ls-files results`).
- "Refuses" means the target stops before any work if one of its output files exists, prints which ones and
  exits 2, so a committed result cannot be replaced by accident.
- "Overwrites" means it rewrites the file. Those targets are deterministic, and `make experiments(-sample)`
  checks that a rerun gives the same bytes.

**Escape hatch for a deliberate new recording (Fix C, 2026-11-15): `RECORD=1 OVERWRITE=1`.**
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
| `make stream-demo RECORD=1` | `streaming_latency.csv`, `stream_progress.jsonl`, `stream_batches.jsonl` (the Step 12 run) | **refuses** (before any process starts) | yes (backup before the run) | no | skipped (measurement) |
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

Measured with the clean-clone check of Step 17 (below). The clone ran as its own compose project, so its containers,
volumes and image tags were separate:

```bash
export COMPOSE_PROJECT_NAME=f1sa-clone F1SA_IMAGE_TAG=clone
docker compose --profile core build --no-cache
time (make up && make sample-data && make demo)
```

Result (2026-11-14, the dev host: WSL 2, 12 logical CPUs, about 14 GB; a GitHub clone at `df48f66` plus the
Step 17 changes, no `.env`):

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

## 6. Clean-up

| Command | Removes |
|---|---|
| `make down` | the containers (volumes kept) |
| `make demo-clean [CONFIRM=yes]` | `data/demo/<run_id>/` and the demo and replay checkpoints |
| `make bench-clean [CONFIRM=yes]` | benchmark data in `data/bench` and HDFS `/f1/bench` |
| `make nuke CONFIRM=yes` | **containers and volumes** (Kafka log, HDFS data). Not needed for any reproduction |
