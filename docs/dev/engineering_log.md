# Engineering log
## Done
- Step 0: repo bootstrapped, project notes, traceability matrix and local tool permissions added
- Step 1 (W1): monorepo scaffold and tooling
  - `pyproject.toml` (uv, Python 3.12, hatchling, src layout; pyspark==4.2.1, fastf1==3.9.2) + committed `uv.lock`
  - `src/f1sa/` skeleton (ingest, lake, etl, features, model, streaming, serving, sim, api) + `py.typed`
  - `src/f1sa/config.py`: validated `Settings` (lake URI file/hdfs, kafka host:port list, redis URL, TTL>0,
    Jolpica budget 1..500 default 450, FastF1 cache dir, paired SecretStr F1 credentials) + cached `get_settings()`
  - `.env.example`, `.editorconfig`, `.pre-commit-config.yaml` (ruff), Makefile (help/setup/lint/typecheck/test/test-int)
  - `tests/conftest.py` (session Spark local[2], 4 shuffle partitions; autouse settings isolation),
    `tests/unit/test_config.py`, `tests/unit/test_spark_fixture.py`
  - LICENSE (MIT), DATA_LICENSES.md, README.md, docs/architecture.md (mermaid), `.github/workflows/ci.yml`
  - `.gitignore` / `.gitattributes` extended; `.gitkeep` in empty dirs (experiments, scripts, docker, results,
    data/sample, docs/decisions, tests/integration, tests/e2e)
- Step 2 (W1): Docker Compose infrastructure
  - `docker-compose.yml` with profiles core | hdfs | spark | full. Every long-running service has a healthcheck, a
    `mem_limit`, and `depends_on: service_healthy` / `service_completed_successfully`.
  - core: kafka 4.3.2 (KRaft, host 9092 / internal kafka:29092, auto-create off), kafka-init (f1.race.events, 3 partitions),
    redis 8.10.3 (no persistence, 256mb, volatile-ttl), app image (`docker/spark/Dockerfile`: temurin 17 + py3.12 +
    uv-locked deps + spark-sql-kafka 4.2.1 jars baked in, verified offline at build time; non-root UID = host UID)
  - hdfs: namenode + datanode (`docker/hadoop/`, from apache/hadoop:3.4.3, replication 1, UI 9870, named volumes)
  - spark: standalone master + 2 workers (memory and cores set from .env)
  - Makefile: up, up-full, down (never -v), ps, logs, nuke (needs CONFIRM=yes). `scripts/wait_for.sh`. `.dockerignore`
  - `confluent-kafka` runtime dependency. `Settings.kafka_topic_events` (validated). `.env.example` has ports, worker sizing, APP_UID
  - Tests: `tests/integration/test_infra.py` (compose config, topic/partitions, Kafka round-trip, Redis PING, HDFS
    put/cat, skipped without hdfs) and `tests/unit/test_wait_for.py`
  - docs/architecture.md: infrastructure table and memory budget
- Step 3 (W1): ingestion clients (#4, #5)
  - Checked the docs first. Jolpica caps `limit` at 100 (the brief said 1000), and lap paging counts timings.
    Rate limits are 4/s and 500/h, with 429 and no Retry-After header. Terms are CC BY-NC-SA 4.0.
    FastF1 3.9.2 auth uses F1_USERNAME/F1_PASSWORD or the TTY login or `python -m fastf1 auth f1tv`.
    `Cache.configure` needs an existing directory.
  - `ingest/ratelimit.py`: thread-safe dual token bucket with an injectable clock and sleep.
  - `ingest/jolpica_client.py`: cached (SQLite), rate-limited in the adapter (cache hits are free), retries with
    backoff and Retry-After, pages by the server's limit, merges split laps. Typed DataFrames for seasons, races, results,
    qualifying, drivers, constructors, pitstops and laps.
  - `ingest/fastf1_loader.py`: cache configuration, an explicit auth check (secrets never logged), validated laps,
    car and position data. Raises `FastF1AuthError` / `FastF1DataError` instead of continuing silently.
  - `ingest/sinks.py` (atomic FileSink plus manifest), `lake/paths.py` (raw partition URIs), and `ingest/cli.py`
    (`f1sa-ingest race ...`, where `--sink hdfs` exits 2 until Step 4).
  - Settings: `JOLPICA_CACHE_DIR` and `JOLPICA_USER_AGENT` (repo name only, no personal details).
  - The local tool settings deny reading `~/.local/share/fastf1/`, where FastF1 3.9.2 stores the F1 TV token.
  - Tests: trimmed CC BY-NC-SA fixtures in `tests/fixtures/jolpica` (README with attribution). 140 unit tests, with
    no network or credentials needed.
  - Verified: a real ingest of 2023 R5 into the file sink took 20 s cold (18 requests) and 0.7 s warm (0 requests).
    FastF1 without credentials gives exit 1 with a clear FastF1AuthError, and nothing is written.
- Step 4A (W2): bulk, resumable raw-zone ingestion and the HDFS sink (#2, #6, bulk part of #1/#4/#5)
  - HttpFS gateway (`httpfs` service in the hdfs/full profiles, f1sa-hadoop:3.4.3, user hadoop, port 14000, 384m, health
    check). Proxyuser settings are in core-site.xml, and `docker/hadoop/httpfs-site.xml` is new.
  - `HdfsSink`: uses the same interface as `FileSink`. CREATE `data=true` (no datanode redirect) to `_tmp.<uuid>`, length
    check, then DELETE + RENAME, with the boolean checked. Verified live: HttpFS RENAME never overwrites and
    `renameoptions` is ignored. Retries 5xx and connection errors; temp files are cleaned on failure or Ctrl+C.
  - Table-first raw layout `raw/{source}/{table}/season=S[/round=R][/driver=DRV]/` with a `_manifest.json` per
    partition. Season tables (schedule, drivers, constructors) are fetched once per season. `sprint_results` only on
    sprint weekends.
  - `data/manifest.json` (`ingest/manifest.py`): atomic save after every change (tested with a real SIGKILL), flock
    against concurrent runs, stale `running` items retried, `--only-failed`.
  - `ingest/planner.py`: plan, request and ETA estimate (cache-aware, no network), budget split when both sources run.
    `--dry-run` writes nothing.
  - `ingest/bulk.py` and `cli.py season-range` (plus `race` on the same code path):
    - FastF1 sign-in is checked first; auth or hard rate-limit errors abort with exit 3.
    - Other errors are recorded in the manifest and the run continues (exit 1).
    - SIGINT/SIGTERM give exit 130 with the item `interrupted`.
  - FastF1: per-driver telemetry and position partitions, one race in memory at a time, races paced (20/h), and the
    cache dir enforced inside `./data`.
  - **Rate limiter fix:** the real run got 63 HTTP 429s. Root cause: a token bucket admits capacity + rate·T, so the Step 3
    buckets allowed 8 requests per second and about 900 in the first hour. The limiter is now a 1-token bucket at
    3/s (≤ 4 in any second) plus a persisted sliding hourly window (≤ budget in any rolling hour, across runs).
    A 429 without Retry-After now backs off 5–60 s.
  - Tests: 218 unit tests (manifest, kill-safety, HdfsSink against a fake HttpFS with the real quirks, planner and
    estimates, bulk runs incl. interrupt/abort/resume, window guarantees) and HttpFS integration tests from the host.
- Step 4B (W2): synthetic generator and offline sample bundle
  - `ingest/synthetic.py` (generator `synthetic-v1`):
    - Stints are inferred from real Jolpica laps and pit stops (DNF, stop on the last lap, duplicates, DNS handled).
    - Synthetic dry compounds (≥ 2 per driver who stopped) and starting tyre age.
    - Synthetic per-lap telemetry aggregates (mean/max speed, full throttle, brake, gear changes, RPM) scaled by real
      lap pace.
    - Seeded per driver with a SeedSequence, byte-deterministic; `is_synthetic=true` on every row; no FastF1.
  - `ingest/sample_builder.py` + `make sample-data` (`REBUILD=1`):
    - Builds `data/sample/` for 2023 R5 and 2024 R5 in the raw-zone layout. Pages come from the raw zone, then the
      cache, then the network. The bundle is built in a temp dir, validated, then swapped in atomically.
    - When the bundle exists it is validated offline: sha256 and size, schemas, `is_synthetic`, no FastF1 data, no
      unlisted files, < 5 MB, and byte-identical regeneration of the synthetic tables.
    - It generates `data/sample/LICENSE` (CC BY-NC-SA 4.0, attribution and link to Jolpica-F1) and `README.md`
      (real vs synthetic, how built, smoke-test-only warning).
  - Verified: first build gave 18 data files and 502 KiB (2023 R5 and the schedules from cache; 18 network requests for
    2024 R5 and the season tables). The rebuild and offline validation used 0 network.
  - Rate limiter is now cross-process: before every admission the shared `requests.log` is re-read under `flock`, the
    hourly and per-second (≤ 4 in any second, 50 ms margin) checks count every process, and SQLite gets
    `busy_timeout`. The new two-process test found and fixed a window-boundary bug (6 in one closed second).
  - `docs/data_dictionary.md` (new): bundle tables, every synthetic assumption, and the NOT-real / smoke-test-only warning.
  - Tests: 251 unit tests (generator edge cases and determinism, builder order, offline validation, tamper/FastF1/size
    rejection, atomic swap, gitignore, two-process limiter).
- Step 5 (W2): clean zone (#3, the clean half of #1, #7)
  - `lake/schemas.py`:
    - explicit raw schemas (Jolpica pages, FastF1 laps and car data, synthetic tables);
    - 10 clean StructTypes: races, drivers, constructors, results, qualifying, laps, pitstops, stints, telemetry_lap,
      telemetry_raw, each with primary keys.
  - `etl/clean.py` (+ `etl/spark.py`, `f1sa-clean`, `make etl-sample`):
    - Spark reads raw (file:// or hdfs://) with explicit schemas. Jolpica `driverId` is canonical; FastF1
      abbreviations are mapped via the race entries, with car number as fallback.
    - Times are converted to seconds. Laps carry cumulative time, gap to leader and gap ahead at the timing line, and
      pit in/out flags.
    - SC/VSC/red-flag flags: exact from FastF1 TrackStatus, otherwise a documented Jolpica heuristic (neutralised
      > 1.25× median, red flag > 3×; tightened in Step 8).
    - Stints and telemetry prefer FastF1, then synthetic, then stints inferred from pit stops.
    - Writes `partitionBy(season, round)` with dynamic overwrite. File mode refuses to write outside ./data/lake.
  - `lake/quality.py`: hard checks (null/duplicate keys, races without results/laps, pit lap out of range) and soft
    checks (lap contiguity, positions 1..N, pit lap in laps, results.laps, unparseable times, unmapped FastF1 drivers,
    stint tiling). Writes the JSON report to `clean/_quality/report.json`.
  - Verified on data/sample: exact counts (laps 2168, pitstops 60, stints 100, …), quality PASS (28 checks, 0 hard,
    0 soft), and identical checksums on rerun. 2024 R5 neutralised laps are 22–24, 26 and 28–31 (21–31 since the Step 8 heuristic).
  - HDFS mode (your choice): `docker compose exec app env PYTHONPATH=/workspace/src DATA_LAKE_URI=hdfs://… python -m
    f1sa.etl.clean --source lake`. Run on the full data in Step 8b.
  - Tests:
    - the whole pipeline on the real sample, with exact counts, schemas, gaps, flags, rerun and subset idempotency;
    - a FastF1 path with hand-made Parquet: nanosecond timedeltas, mapping and unmapped driver, exact TrackStatus,
      stints, per-lap aggregates, lap assignment of samples;
    - quality checks and helpers.
- Step 6 (W3): Spark RDD / DataFrame / SQL feature jobs (#8–#11, S6 part of #7 and #12)
  - `etl/rdd_jobs.py` (RDD API):
    - stints: `keyBy` → `groupByKey` → sort the laps → split after pit-in laps;
    - per-race/circuit green lap-time distribution: `aggregateByKey` with a Welford/Chan accumulator, a 1 s
      histogram and a broadcast circuit map;
    - each job has a DataFrame twin.
  - `etl/df_jobs.py` (DataFrame API): `enrich_laps` joins laps, results, pit stops, drivers, constructors, stints and
    races. Windows give gaps (lapped cars are compared with the leader at the same lap number), 1- and 3-lap gap
    changes (null when the car ahead changes), tyre age, laps remaining and estimated lap timestamps (start + 180 s +
    cumulative time).
  - `etl/sql/*.sql` + `etl/sql_jobs.py` (Spark SQL): pit loss and team out-lap history from strictly earlier races
    (`RANGE … 1 PRECEDING` over `race_seq`). Fallbacks: team (out-lap only) → circuit → global → null with source and
    missing flags. Plus a race summary.
  - `features/{schemas,gaps,stints,pitloss,build}.py`. Run `python -m f1sa.features.build --source sample|lake`
    (also `make features-sample` or `f1sa-features`). It writes 7 tables to `data/lake/features`, partitioned by
    season and round.
  - Verified on the sample: exit 0, both partitions for every table (laps_enriched 2168, gaps 2168, stints 100,
    distribution 2, pit_loss 2, team_outlap 20, summary 2), and identical checksums on rerun.
    - RDD stints = DataFrame stints = clean stints (100/100). Recomputed gaps = clean gaps (2168/2168).
    - Pit loss: 2023 R5 `none`, 2024 R5 `global_prior`.
  - Tests:
    - a 3-driver, 5-lap fixture with a lapped car and a pit lap;
    - a 4-race leakage fixture (the target race and later races scaled ×100, the target's history unchanged);
    - RDD vs DataFrame equality;
    - pit-cycle exclusions;
    - build, rerun and `_quality` junk.

    49 new tests, 344 unit tests in total. Docs: architecture.md (API rationale, timestamp limits, fallbacks) and
    data_dictionary.md.
- Step 7 (W4): telemetry aggregates, out-lap pace and constructor lineage (rest of #12)
  - `features/telemetry_agg.py`: the single per-lap aggregation definition (full throttle ≥ 98%). Samples are
    assigned to `[lap_start, lap_end)` by session time; a boundary sample goes to the later lap. The clean FastF1 path
    uses it too. Races with raw telemetry are aggregated; synthetic `telemetry_lap` passes through unchanged with
    `is_synthetic`. Batch only: a test checks that `f1sa.streaming` never imports telemetry.
  - Clean laps gain `lap_start_session_s` and `lap_end_session_s` (from FastF1, null otherwise). `make etl-sample`
    was re-run; quality still PASS.
  - `features/outlap.py`:
    - clean lap (excludes lap 1, in-laps, out-laps, SC/VSC/red flag, and laps over 107% of the race median);
    - `realised_outlap_delta_s` (ORACLE): same-stint median, falling back to the previous stint;
    - `expected_outlap_delta_s`: the mean over strictly earlier races, with fallbacks
      driver_team → team → circuit → global → none, plus a flag.
  - `features/lineage.py`: alphatauri→rb and alfa→sauber, plus stable ids. It is applied to SQL
    `team_outlap_history` (new `team_history_key`) and to `outlap_features`. The build fails on an unknown
    constructor id.
  - `docs/label_definition.md` (new): the "Out-lap pace features" section, with parameters and the ORACLE
    vs decision-time rule. architecture.md and data_dictionary.md are updated.
  - Verified on the sample: two builds, both exit 0, with identical checksums for all 9 tables × 2 partitions
    (telemetry_lap_features 2168, outlap_features 100). In 2024, rb and sauber now use `team_prior`; out-lap
    expected values are `driver_team` (58) or `team` (2).
  - Tests (28 new, 372 unit tests in total):
    - raw telemetry fixture: boundaries, a lap with no samples, exact values;
    - synthetic pass-through and mixed sources;
    - the clean-lap rule (including 108% vs 106%);
    - realised fallbacks;
    - 4-race ×100 leakage;
    - history exclusions;
    - lineage, including a check that the build fails on an unknown id.
- Step 8 (W4): undercut attempts, labels and the real-time detector (#13, rule half of #20)
  - Phase 1 review approved by the user. The definition, grid, edge cases and leakage rules are in
    `docs/label_definition.md` ("Undercut attempts").
  - `features/undercut_rule.py` (pure Python): `candidate_pairs(LapSnapshot, RuleParams)`. A is directly behind D,
    0 < gap ≤ G, L ≥ 4, not teammates, no car crossing between them, neither lapped or in the pit cycle, and L − 1
    green and not a restart lap. Failed conditions are returned as reasons.
  - `streaming/detector.py`: `detect()` returns eligible pairs with tyre-age and last-lap deltas.
    `snapshot_from_state()` validates the per-driver state (Redis-hash style, string values allowed). No Spark
    import (subprocess test).
  - `features/undercut.py`:
    - `evaluate_race` runs per race through RDD `keyBy` → `cogroup` → `flatMap` and emits all 9 (G, k) rows;
    - the label is A ahead on D's out-lap;
    - `defender_stayed_out`, plus 16 `excluded_<reason>` categories in a fixed priority order, all reasons in
      `exclusion_reasons`;
    - slow-stop and double-stack flags;
    - DataFrame decision features (stint pace and degradation slope, rejoin traffic, priors) in `DECISION_FEATURES`;
      `oracle_*` and `outcome_*` columns are kept apart;
    - `detector_eligible`.
  - Track status: the Jolpica heuristic is tightened to ratio > 1.10 or ≥ 50% of cars > 107%. 2024 R5 laps 21, 25
    and 27 are now caught (21–31 neutralised); 2023 R5 has none. FastF1 TrackStatus still overrides per lap.
  - Out-lap review: 74% of the stop loss lands on the out-lap, so `expected_outlap_delta_s` is collinear with
    `pit_loss` and is now marked legacy.
    - New: `stop_delta_s`, `outlap_pace_residual_s` (ORACLE) and the shrunk priors `expected_outlap_pace_residual_s`
      (driver_team → team → global, κ = 5, `driver_team` once n ≥ 5) and `expected_stop_delta_s` (team → global).
    - `outlap_features` now `localCheckpoint()`s its realised table: the plan had grown to 13 MB and caused a JVM OOM.
  - Build: `undercut_attempts` (sparse; stale partitions deleted) and `results/undercut_counts_sample.csv` (smoke-test
    header and column; `--results-dir` must be under `./results`).
  - Verified on the sample: `make etl-sample` gives quality PASS. Two `--source sample` builds both exit 0 with
    identical checksums for all 10 tables (`undercut_attempts` 303 rows, checksum 4098e93c10d0dcdf) and an
    identical CSV (sha256 387846fd…).
    - Default params, smoke test only: 2023 had 1 success, 3 fail and 8 defender_stayed_out; 2024 had 1 success.
  - Tests:
    - six hand-built scenarios (success, fail, stays out, SC in window, attacker retires, lapped car between);
    - ×100 leakage over 4 races;
    - G monotonicity and k window;
    - detector vs batch agreement on every scenario, lap and G;
    - 15 pure-Python edge cases;
    - rule and detector validation;
    - shrinkage at n = 0/1/4/5/6 and decomposition leakage;
    - the new heuristic boundary laps;
    - build CSV and results-dir guard.

    81 new tests, 453 unit tests in total (full suite: 453 passed in 225 s).
- Step 9 (W5): MLlib undercut model, baselines, calibration and explanations (#14–#18, #29, #39)
  - `model/features.py`: feature registry with provenance (jolpica, stint_boundary, tyre_state, telemetry,
    fastf1).
    - Every `DECISION_FEATURES` column is either a model input or excluded with a reason; derived inputs are
      documented.
    - Feature sets: `real` and `with_synthetic`. `with_fastf1` will be one new entry.
  - `model/dataset.py`:
    - one (G, k) setting, labelled rows only, a duplicate-key check;
    - derived stint length and telemetry at L−1;
    - constant fill plus `_missing` indicators, and one-hot `*_source` columns;
    - season split (`SplitSpec`) with a `SealedSplit` test season (token from `evaluate_test`, opened once);
    - class weights from the training rows only.
  - `model/baselines.py`: majority class, and a rule (expected fresh-tyre gain vs gap, decision-time only).
  - `model/train.py`:
    - LR pipeline (assembler → scaler → LR) and GBT pipeline;
    - grid tuned on validation PR-AUC (fit on train only, no CrossValidator);
    - explicit degenerate-validation path;
    - full-mode synthetic refusal (`SyntheticFeatureError`, exit 3);
    - model and metadata save under `./models` only.
  - `model/calibrate.py`: isotonic (Spark) and Platt (slope ≥ 0), chosen by validation Brier; Platt below 300 rows,
    identity when validation cannot support a fit.
  - `model/metrics.py`: numpy AP, ROC (equal to Spark's), Brier, ECE (10 bins), F1, macro-F1, with NaN and a reason
    when undefined.
  - `model/evaluate.py`: race-cluster and attempt bootstraps (1000, paired, seeded); `evaluate_test` is the only
    place the test season is opened.
  - `model/explain.py`: GBT importances (grouped per feature), standardised LR coefficients, permutation importance
    on validation (5 repeats, one stacked Spark job).
  - `model/rehearsal.py`: a GENERATED 2021–2025 table with a known logistic signal and race effects.
  - `model/pipeline.py`, `experiments/model_eval.py`, `make model-eval-sample` / `model-eval-rehearsal`:
    - `--source sample|rehearsal|full`;
    - full needs `--allow-test-season`;
    - stamped, suffixed outputs.
  - Verified:
    - `DATA_LAKE_URI=file://$PWD/data/lake uv run python experiments/model_eval.py --source sample` exits 0. Its
      data is train 2023 (4 rows), validation 2024 (1 row). Tuning is skipped (one class) and calibration is
      identity. The test season is skipped and the sealed split is never opened. All outputs are `_sample` and
      SMOKE TEST.
    - Rehearsal (generated data, small grid): the whole pipeline in about 20 s; the calibrated model beats the
      majority baseline on test PR-AUC.
  - Tests:
    - an `Estimator.fit` spy: no fit, tuning or calibration sees 2025, and no fit mixes train with validation;
    - poisoned 2025 rows leave the weights, parameters, coefficients, importances and calibrator unchanged;
    - the test split opens once;
    - the (G, k) filter and duplicates;
    - training-only class weights;
    - monotonic calibration, isotonic equal to Spark, the chooser rules;
    - the race-cluster bootstrap draws whole races, and its CI is wider under correlation;
    - full-mode refusal (static, flags, null flag);
    - CLI guards; sample smoke mode; explanations recover the generated signal.

    41 new tests, 494 unit tests in total (full suite: 494 passed in 295 s).
- Step 8b (W4): full 2021-2025 clean, features and undercut counts in HDFS mode (#1, #3, #6, #13)
  - Runs in the running app container (`PYTHONPATH=/workspace/src`, `local[2]`): no rebuild or restart.
    `/f1/clean` and `/f1/features` are owned by `f1sa`; `/f1/raw` stays `hadoop`-owned, so HDFS refuses writes to it.
  - Makefile: `hdfs-dirs`, `etl-full`, `features-full`, `report-full`, `pipeline-full`.
  - `features/build.py`: `--full-counts` writes `results/undercut_counts_full.csv` and refuses synthetic attempts;
    `telemetry_lap_features` is sparse; `lap_time_distribution` expects only races with a green lap (2021 R12 has
    none); a stale partition on `hdfs://` is an error instead of a delete.
  - `etl/full_report.py` (new): counts, constructors, provenance, `real` feature-set build (no fit, test sealed),
    neutralisation per race. Writes `results/full_data_quality.json`, `constructors_full.csv`,
    `neutralisation_by_race_full.csv`.
  - Verified: 114 races (22, 22, 22, 24, 24), 124,834 laps, quality PASS (0 hard, 1 soft: 5 disqualified drivers
    with `results.laps = 0`). Lineage map verified: no unknown constructor. Nothing synthetic; compound null;
    telemetry 0 rows; `real` builds.
  - Red-flag fix (user-approved): `heuristic_track_flags` also tests the field median of every car (pit laps and
    lap 1 included) against 3.0x, because Jolpica records a red flag as a stop for the whole field. 0 -> 18 red-flag
    laps in 15 races. `undercut.RED_FLAG_RESTART_LAPS = 3` green laps after a run containing a red flag count as
    neutralised (the longest decision lookback is 3 laps). One attempt moved from labelled to excluded (2024 R4);
    no 2025 attempt changed.
  - Labelled at G=3.5, k=2: train 108, validation 49, test 49 (every season below 50). At G=5.0, k=3: 184, 64, 60.
  - `excluded_early_lap` (76, 21, 50, 3, 39) matches an independent recount: mass stops on laps 2-3 (red flags,
    early wet stops); 2024's early stops are on lap 1, which is never a candidate. Data, not a bug.
  - Wet running stays `neutralised` (user decision). Reporting-only split (`features/neutral_split.py`): the counts
    CSVs gain `n_excluded_neutralised_sc_vsc_red_flag` and `_sustained_slow` (run >= 8 laps, no red flag, run
    median < 1.25x, lap < 1.35x; set from 2021-2024 only). G=3.5, k=2: 37 of 406 are sustained slow running.
    All 20 table checksums and `labels_checksum` (73fe89cf9f4e8ee6, new in `full_data_quality.json`) unchanged.
  - `clean.track_ratios` and `undercut.attempt_window` factored out unchanged. `docs/label_definition.md`
    gains "Known limitations" and the L=4 feature note: no labelled attempt at L=4 or 5 in any season.
  - Split tests (18): the rule (wet run, long SC, red-flag run, thresholds, restarts, windows), and labels checksum
    plus every other count identical with and without the split. 579 unit tests (579 passed in 444 s). The sample
    CSV gains the two columns (other columns unchanged; sha256 1c93ec30…).
  - Early-lap threshold L < 5 (user decision, from counts only, before any model result; final label change, the
    definition is now frozen): `undercut_rule.MIN_ATTEMPT_LAP = 5`, shared by the batch label and the detector.
    All 213 L = 4 candidates (9 settings; 25 at G=3.5, k=2) are now `excluded_early_lap`; no other attempt changed
    category; none was labelled. New `undercut.labelled_set_checksum` per (G, k) in `full_data_quality.json`:
    identical before and after at all 9 settings. Only `undercut_attempts` changed (f82c2f9c47398d67).
    Tests: L < 5 vs L < 4 moves only L = 4 rows at every (G, k); detector and batch agree at L = 4 and 5;
    the labelled-set checksum ignores unlabelled rows.
  - Two complete runs: identical checksums for all tables and byte-identical result files. `/f1/raw` listing and
    `data/manifest.json` unchanged. Sample counts CSV unchanged.
  - Docs: "Full-data quality notes" in `docs/data_dictionary.md`. 67 new tests, 561 unit tests (561 passed in 382 s). Red-flag
    tests: a lap where every car "pits" is a red flag, ordinary all-car and half-field pit laps are not, lap-1
    stoppage, restart period excludes an attempt, ends after 3 laps, counts from the end of the run.
- Step 9b (W5): development mode for the model (#14-#18, #29), label definition frozen (`label-definition-v1`)
  - `--source full --no-test` / `make model-dev-full` (in the app container, like `pipeline-full`; no model
    binaries saved). `dataset.read_feature_seasons` reads only the `season=2021..2024` partition directories, so
    2025 is never listed or opened; `SplitSpec(test=())`. `--no-test` with `--allow-test-season` exits 2; full mode
    allows only the `real` feature set. Final-run names and the `--allow-test-season` path are unchanged.
  - Outputs `results/model_dev_*` (DEVELOPMENT stamp; `_G5.0_k3` for the sensitivity run): validation metrics
    with race-cluster and attempt bootstraps vs majority and rule, calibration, importances, plots, class
    balance, leave-one-season-out (`model/loso.py`: 2021-2024 only, fixed first grid point, raw scores,
    fold-only class weights; class metrics undefined below 5 positives or negatives), metadata JSON.
  - Ran on the full features: both settings exit 0 in 3m14s. G=3.5, k=2 (primary): train 108 (32 positive),
    validation 49 (16 positive). G=5.0, k=3 (sensitivity, not used to choose): 184 (50) and 64 (22).
  - Tests: junk `season=2025` partitions plus a `DataFrameReader.parquet` spy (no 2025 path), the `Estimator.fit`
    spy, `evaluate_test` never called, stamps, distinct names, guards, LOSO folds, Makefile dry run.
  - Follow-up: the full suite failed intermittently (broadcast "Not enough memory" / `OutOfMemoryError`). Root
    cause: the shared test driver JVM used Spark's default 1 GB heap, and after GC it sat at 500-930 MB late in
    the suite (69 persisted RDDs plus the status store of ~11,000 stages), not a large broadcast (the fixture
    tables are KB). `tests/conftest.py`: explicit `spark.driver.memory=2g`, broadcast threshold pinned at the
    10 MB default, capped job/stage/task/SQL history, and `clearCache()` after every test module. After the fix
    the heap returns to 150-450 MB between modules (peak 1.27 of 2 GB). Test configuration only.
  - Development outputs gain `ece_5bin` (supplementary; 10 bins stays primary), an ECE bootstrap-bias note and
    the rule baseline's fallback count (0 of 49 and 0 of 64 rows: its Brier 0.221291 is a real value, close to
    the majority's 0.220822 by coincidence). Regenerated by a deterministic refit (same seed, grid, data).
- Step 9c: pre-registered model spec `docs/model_spec.md` (frozen once committed)
  - Full test-run outputs always carry the setting (`model_eval_G3.5_k2.csv`, `model_eval_G5.0_k3.csv`, same for
    calibration, feature importance, reliability, confusion matrix); a test run refuses to start if its files or
    saved metadata exist (first complete run is the reported one). `make model-test-full CONFIRM=yes` runs both.
    Dev names unchanged: all 18 `model_dev_*` files byte-identical after the rename.
  - F1 threshold: fixed 0.5 (`metrics.DECISION_THRESHOLD`, set in 64739ca before any full-data model, never
    tuned); new `decision_threshold` column and metadata key. 5-bin ECE also in the test report.
  - Dev outputs regenerated once (reads only `season=2021..2024`): 6,036 existing cells identical, only the new
    column and key added.
- Step 9c (deployment model for streaming, no test season)
  - New entry point (not a flag on `model_eval.py`, so `pipeline.run` and the test path are untouched):
    - `model/deploy.py`, `experiments/model_save.py`, `make model-save-full` (`FORCE=1` replaces).
    - Reuses `load_frame` (no-test mode), `DEV_SPLIT`, `tune`, `score_split` and `choose` unchanged; `evaluate_test`
      is not imported.
  - Output `models/undercut/deploy_real_G3.5_k2/` (gitignored, about 280 KB):
    - `{lr,gbt}/pipeline/`, `calibrator.json` and `metadata.json` (every field asked for, including git sha, dirty
      flag and `test_season_read: false`);
    - `lr/scorer.json` and `reproduction.json`.
  - The run writes to `.staging-*` and moves into place only if the reproduction check passes.
  - `model/lr_scorer.py`: pure-Python calibrated-LR scorer. It imports no Spark or numpy, and every number it uses
    comes from `scorer.json`.
  - Streaming will deploy the LR only; GBT stays Spark-only, for batch use.
  - `docker-compose.yml`: the app mounts `./models:/workspace/models` read-write (user choice). Only the app
    container was recreated (`docker compose up -d --no-deps app`, user-approved). The other 8 services kept
    running and no volume was touched.
  - Ran `make model-save-full` (2m02s):
    - partitions read: `season=2021..2024` only;
    - train 108 (32 positive), validation 49 (16);
    - LR regParam 0.1, elasticNetParam 0.5; GBT depth 2, 50 iterations, step 0.05; Platt for both;
    - reproduction MATCH: the round trip is exact for all 4 score vectors, and the parameters and Platt a/b are
      identical to the dev run;
    - calibrated validation Brier / PR-AUC: LR 0.168438 / 0.593775, GBT 0.205233 / 0.560198, equal to
      `model_dev_*`;
    - scorer vs Spark: max |diff| 2.2e-16.
  - Tests (38 new): `test_model_deploy.py` (19) and `test_lr_scorer.py` (19), plus 3 in
    `test_makefile_full.py` and 1 compose-mount integration test.
    - The loader and fit spies see no 2025 data, and `evaluate_test` is never called.
    - Exact round trip.
    - The dev-run match, and the tampered-reference mismatch (exit 4, staging kept, nothing moved).
    - Every metadata field; distinct folders per setting, never the test-run folder; refusal without `--force`.
    - CLI guards and the git sha refusal.
    - Scorer vs Spark within 1e-9: validation rows, None numerics and categoricals, unseen categories, std-0
      columns, NaN/inf/bool rejected.
- Step 4C Phase 1 (audit only): `docs/data_source_audit.md`, a replacement for FastF1 (F1 TV login needed since
  Oct 2026)
  - TracingInsights `2021`..`2025` are live under `TracingInsights`, with SHAs pinned in the audit.
    - Licences: MIT for 2021-2024 (not Apache-2.0 as the brief said) and Apache-2.0 for 2025.
    - Race-only data is 18.7 GB, of which 18.6 GB is per-lap telemetry. Lap, race-control and session tables are
      about 81 MB.
  - All 114 manifest races are present, with names matching Jolpica (114/114), and the driver code equals the
    Jolpica code for 2,272/2,272 driver-races.
  - Compound coverage is 99.75 / 98.58 / 99.86 / 100 / 98.12%. Race control is present in every race, with lap
    numbers on at least 99.95% of messages, and track status is exact.
  - OpenF1 agrees 100% on compound (2023 R5, 2024 R5, 2025 R5), and also on tyre life and stint for 2023/2024.
  - Network use: 30 GitHub API calls, 5 blob-free clones, about 500 raw files (89 MB, scratchpad only) and 9
    OpenF1 calls. 2025 is reported as aggregates only, and its files were deleted.
  - No changes to `src/`, `tests/`, `data/` or `results/`: the v1 hashes are identical before and after.
- Step 4C Phase 2: TracingInsights loader (option B4), additive clean tables and an HDFS replication fix
  - `f1sa-ingest-ti` (`ingest/tracinginsights_loader.py`, `ingest/tracinginsights_parse.py`, pins in
    `ingest/tracinginsights_pins.json`):
    - Fetches only `raw.githubusercontent.com` at the pinned commits. Each file is checked against its git blob
      SHA-1, and sha256 is recorded in `data/manifest_tracinginsights.json` (separate from `data/manifest.json`).
    - Writes through the existing sinks (HttpFS). It resumes per race item (`tracinginsights`,
      `tracinginsights_telemetry`), supports `--only-failed`, and is kill-safe (tested with a real SIGKILL).
    - Disk guard on `/mnt/c`: it refuses below 20 GB and prints the free GB it saw.
    - "None"/"nan"/"" are converted to nulls explicitly and counted per field in each partition's `_manifest.json`.
  - Telemetry (B4) for every race of 2021-2025:
    - Downloaded into memory, then aggregated per (driver, lap) by `features/telemetry_agg_ti.py`.
    - It reuses `telemetry_agg.assign_to_laps` + `aggregate_samples` unchanged (exact equality test against the
      clean FastF1 path).
    - It adds `n_samples` and `telemetry_coverage`: full; partial = span < 90% of the window or a gap > 2.0 s;
      none = 0 samples.
    - The gap threshold is 2.0 s, not the planned 1.0 s: 1.0 s flagged ordinary 1.0–1.3 s feed dropouts
      (14 of 56 real laps).
    - Boundary samples shared by consecutive lap files are deduplicated (the later lap's copy is kept).
    - Raw samples are discarded, except 2024, which is kept as Parquet under
      `raw/tracinginsights/telemetry/season=/round=/driver=/` (skip it with `--skip-raw-telemetry`).
    - Gate (2024 R5): 114 s per race (download 89 s, aggregate 13 s), below the 10-minute limit.
  - `f1sa-clean-ti` (`etl/clean_tracinginsights.py`, schemas in `lake/schemas_tracinginsights.py`) writes five new
    tables, partitioned by season/round:
    - `stints_tracinginsights`: 6,421 rows;
    - `race_control`: 10,191;
    - `race_control_track_status`: 1,338;
    - `telemetry_lap_real`: 125,055, with `is_synthetic=false`;
    - `compound_coverage`: 114.

    It also writes `clean/_quality/tracinginsights.json` and `results/tracinginsights_coverage_full.csv`.
    - Missing compounds stay null with `compound_missing` (2022 Austria 77.4%, 2021 Belgium all UNKNOWN); nothing
      is imputed.
    - The race-control car number comes from `dNum`, or else is parsed from the message text ("CAR n (",
      "PENALTY FOR CAR n"), because `dNum` is null on real messages.
    - Unmapped drivers: 0 in every season.
    - 2025 is in the lake, but reports give counts only.
  - Real run (2026-11-11/12):
    - 228/228 items done, 0 failed, in 3.7 h.
    - 2021 R8 telemetry was redone once (149 s) after a dtype fix: `toPandas()` turned null `gear_changes` into
      DOUBLE, so it is now cast to nullable Int32, with a regression test.
    - The clean job takes 60 s.
    - HDFS added 1.9 GB raw (1.8 GB of it 2024 raw telemetry, 48 MB laps, 4.2 MB aggregates) and 5.9 MB clean.
    - Coverage per season: compound 99.75 / 98.58 / 99.86 / 100 / 98.12%; telemetry laps full 23,745 / 23,504 /
      24,357 / 26,585 / 26,673.
  - Real-data check (2024 R5): 40/40 TracingInsights stint changes match Jolpica pit stops, and the SC/VSC timeline
    covers laps 21–31, the same as the v1 heuristic.
  - HDFS replication: the cause of the 1,936 under-replicated blocks was the Spark jobs in the app container.
    - There is no `HADOOP_CONF_DIR` there, so the Hadoop client used its default `dfs.replication=3`. Those were the
      /f1/clean files (912) and the /f1/features files (1,024).
    - `build_spark` now sets `spark.hadoop.dfs.replication` from `HDFS_REPLICATION` (default 1), and HttpFS CREATE
      passes `replication` explicitly.
    - All 2,552 new raw files and all 570 new clean files are at replication 1. Old blocks are untouched (the count
      is still 1,936).
  - v1 is untouched:
    - The read-only HDFS snapshot (10 clean tables, 10 feature tables, `labels_checksum` and 9 labelled sets) is
      identical before and after.
    - `results/*` (22 files), `data/lake` (39 files) and `data/manifest.json` are identical. `data/sample` is
      unchanged.
    - `clean.py`, `lake/schemas.py`, the label definition and the model spec are not modified.
  - Tests: 736 unit tests pass (79 new in the TracingInsights files plus `test_hdfs_replication.py`), plus the
    integration test `test_spark_in_app_writes_hdfs_with_replication_one`. Lint, format and mypy are clean.
- Step 4C wrap-up: lap reconciliation of TracingInsights with Jolpica (read-only, counts only)
  - `etl/reconcile_ti.py` and `make reconcile-ti-full` (app container, HDFS). It writes nothing: no sink and no
    results file, and a test checks the source.
    - Key uniqueness of all 5 TI clean tables, plus a lap-level stint check (`start_lap..end_lap`, no lap in two
      stints).
    - Left join from Jolpica laps to `telemetry_lap_real` (no fan-out).
    - Rows on one side only, each assigned the first matching cause: lap < 1, duplicate, driver absent, after
      the last lap, before the first lap, gap. These are split by Jolpica status class, with cross-tabs for a
      null raw TI `lap_time_s` and `results.laps + 1`.
    - Races below 95% compound coverage.
  - Result (PASS):
    - 0 duplicate keys in every TI table, and 0 stint-lap overlaps.
    - The left join keeps the Jolpica count in every season, and every Jolpica lap matches.
    - Jolpica-only: 0. TI-only: 70 / 48 / 36 / 32 / 35 (221 rows), exactly the count differences. Every one has a
      null TI lap time (an uncompleted lap).
      - 56 rows: retired on lap 1 or did not start (`results.laps = 0`).
      - 145 rows: the lap after `results.laps` (a car's retirement lap, or the lap it was on at the finish).
      - 20 rows: 2021 R12 Spa, laps 2–3 behind the SC.
    - 0 lap-0, 0 duplicate and 0 mapping causes.
    - The 2025 TI count is 26,692, not the 26,711 in the brief.
    - 2025 races below 95%: R6 Miami 0.5562, R13 Belgium 0.9352.
  - Docs, in `docs/data_dictionary.md`:
    - a "Lap reconciliation" table, with what was verified and what is interpretation;
    - the 2.0 s partial-gap threshold and why it was chosen.
  - `ti-sample-check` does not appear in the README, `traceability.md`, the Makefile, src or tests. Nothing to
    rename.
  - Tests: `tests/unit/test_reconcile_ti.py` (15, in `make test-ti`), covering:
    - uniqueness on each key, and stint overlap;
    - no fan-out vs fan-out, and per season;
    - every cause in priority order, with the totals identity;
    - the coverage boundary at 0.95;
    - the fixture race end to end;
    - the CLI exit codes, and the lake left unchanged.

    `make test-ti`: 102 passed.
  - v1 unchanged. Before and after are identical for:
    - `results/*`, `data/manifest.json`, `data/manifest_tracinginsights.json`, `data/lake`, `data/sample`;
    - the HDFS listings and file checksums of `/f1/raw`, `/f1/clean` and `/f1/features`;
    - 25 Spark table checksums (10 v1 clean, 10 features, 5 TI), plus `labels_checksum` and the 9 labelled sets.
- Step 4C → model: feature set `real_ti` (TracingInsights compound, tyre age and telemetry), development mode only
  - `model/features.py`:
    - new provenance `tracinginsights`;
    - `FEATURE_SETS["real_ti"]` = `real` + 19 inputs (46 assembled columns, 98 in total), appended last, so the
      `real` (52) and `with_synthetic` (94) columns are unchanged;
    - `DEV_ONLY_FEATURE_SETS`.
  - `model/dataset.with_ti_inputs`:
    - compound and tyre age at L−1 from the `stints_tracinginsights` stint covering L−1. The age is null when the
      tyre life is unknown (never assumed new).
    - Telemetry plus a `telemetry_partial` flag come only through `jolpica laps LEFT JOIN telemetry_lap_real`.
    - `DatasetError` on any fan-out (lap count or attempt count changes).
  - Also in `model/dataset.py`:
    - `read_clean_seasons` reads only the requested `season=` directories;
    - `missing_rates` gives per season and feature: n_attempts, n_missing, missing_rate, n_telemetry_partial.
  - Coverage policy (user rule): every null becomes 0.0 + `_missing`, or `__unknown` for the compound. Partial
    laps keep their values plus the flag. No race or attempt is dropped, excluded or down-weighted. Class weights
    are unchanged.
  - `model/pipeline.py`:
    - `real_ti` only with `--source full --no-test` (or `sample`). It is refused with `--allow-test-season`, because
      `docs/model_spec.md` is frozen to `real`, and refused for `rehearsal`.
    - Its files carry `_real_ti`; the `real` names are unchanged (pinned by a test).
    - A new `model_dev_missing_rates_real_ti*.csv`, and `coverage_policy` plus `missing_rates` in the metadata.
  - `make model-dev-ti-full` (both settings) ran in 2021-2024 only. The console log was lost when the user
    interrupted the session; the output files are complete for both settings.
    - The counts and class weights equal `real` (108/32 + 49/16; 184/50 + 64/22). Every TI input has missing rate
      0.0 in every season with 0 partial flags.
    - 2021 R12 has no labelled attempt. 2022 R11's 3 attempts are kept and none sits in a compound-null stint.
  - v1 unchanged, compared with the before-values recorded at the start of the step:
    - 37 local files (`results/*` v1, both manifests, deployment model json);
    - `data/lake` and `data/sample` aggregates;
    - the HDFS listings and checksums (`/f1/raw` 3,542 files, `/f1/clean`, `/f1/features`);
    - 35 Spark checksums (incl. `labels_checksum` and the 9 labelled sets).

    No model file changed after the step started. New files: only `results/model_dev_*real_ti*` (20).
  - Tests: `test_model_ti_inputs.py` (9), plus 2 `real_ti` guard/name tests and a `real_ti` dev run in
    `test_model_pipeline.py`, plus a Makefile dry run.
- Step 4C → model, part 2: `real_tyre`, the leakage test, permutation importance for both models, and the reruns
  - `real_tyre` = `real` + `{attacker,defender}_{compound,tyre_age_laps}_ti` (68 columns at the time; part 3 adds
    the tyre-age delta). It uses `features.FEATURE_SET_ONLY`, with the same guards, missing rules and loader
    as `real_ti`, and its files carry `_real_tyre`. `make model-dev-tyre-full`.
    - `real` is still 52 columns, equal to the deployed `lr/scorer.json` list. `scorer.json` sha256 is
      `0a9b7dfb…`, unchanged.
  - Leakage test (new):
    `test_model_ti_inputs.py::test_ti_inputs_unchanged_when_future_laps_and_later_races_are_scaled_x100[real_tyre|real_ti]`.
    Every value after L−1 in the race and every value of a later race ×100 (future compounds WET, telemetry
    partial) leaves the decision-time inputs identical.
    - Probe: the whole-stint TI compound equals the compound from laps ≤ L−1 for 0 differing of 157 / 248
      labelled decision laps.
  - `model/permutation_dev.py` + `make model-dev-permutation-ti-full`: permutation importance for LR and GBT on
    calibrated (and raw) scores. It refits and checks the dev run (reproduction MATCH at both settings), writes
    `results/model_dev_permutation_real_ti*.csv`, and leaves the pipeline outputs untouched.
    `explain.permutation_importance` gains an optional `transform`; the default is unchanged.
  - Reruns in tmux, logged to `data/model_dev_ti.log`: `real_tyre`, `real_ti` and the permutation, both settings.
    All exit 0, and only `season=2021..2024` partitions were read.
    - The 20 rerun `real_ti` files are byte-identical to the first run (`data/real_ti_before.sha`).
    - New: 20 `real_tyre` files and 2 permutation files.
  - The comparison tables are reported in chat, stamped DEVELOPMENT, with no winner picked. They come from the
    `model_dev_eval*`, `model_dev_loso*` and `model_dev_permutation*` files.
  - v1 unchanged:
    - 37 local files, the `models/` aggregate, `data/lake` and `data/sample`;
    - the HDFS listings and checksums;
    - 35 Spark checksums.
- Step 4C → model, part 3: strict decision-time compound, determinism for `real_ti`/`real_tyre`, delta in `real_tyre`
  - Compound from laps ≤ L−1 only: `dataset.lap_compounds` (raw TracingInsights per-lap labels, mapped to driver_id
    through the stints) and `dataset.tyre_at_decision` (the single known label over start_lap..L−1 of the stint
    covering L−1). The leakage test gains a case where same-stint laps after L−1 carry `SOFT` or null and the
    whole-stint compound is null; the decision-time compound is unchanged. The old known issue is closed.
  - Determinism: `dataset.canonical_order` puts train and validation in 1 partition, sorted by (season, round,
    attacker_id, defender_id, lap), for the TracingInsights sets only, inside `build_dataset`, so the dev run and
    `permutation_dev` use the identical path. `real`'s plan is unchanged (tested).
    - Why: after the compound change the same code gave GBT validation PR-AUC 0.72970 in the dev run and 0.73216 in
      the permutation refit (row-order nondeterminism in GBT; LR unchanged). 19 of the 42 development files
      changed, so the permutation self-check stopped (exit 4).
    - **The earlier 19 files were replaced.** Their hashes are in `data/dev_ti_tyre_before.sha` only. The new
      reference is `data/dev_ti_tyre_reference.sha`.
    - The size of the change: the Part 1 rerun moved GBT by up to 0.0025 PR-AUC, but the fix itself (a different,
      now fixed, row order) moved it more. Validation GBT PR-AUC: `real_ti` G=3.5 0.7322 → 0.6893 (−0.043; chosen
      stepSize 0.1 → 0.05), G=5.0 0.642 → 0.632; `real_tyre` G=3.5 0.591 → 0.621, G=5.0 0.611 → 0.617. LR is
      unchanged in every file.
  - Plan fix: `with_ti_inputs` builds each side's tyre lookup from `attempts` (not the growing frame) and caches
    its result. Without this, dynamic partition pruning nested exponentially under the (G, k) filter (a 32 MB
    physical plan, out of memory on the sample-lake fixtures in `test_model_pipeline` and `test_permutation_dev`).
  - Runs (tmux, `data/model_dev_ti.log`), only `season=2021..2024` read:
    - `model-dev-tyre-full`, `model-dev-ti-full`, `model-dev-permutation-ti-full`, twice: all 42 files
      byte-identical between the two rounds. The permutation refit gave reproduction MATCH at both settings in
      both rounds.
    - `real` read-only check: `model-dev-full` twice. All 18 `real` development files equal the committed hashes
      both times (`data/real_dev_committed.sha`), so `real` is reproducible as is; its code was not changed.
  - `real_tyre` gains `tyre_age_delta_laps_ti` (defender − attacker): 70 columns, and it differs from `real_ti`
    only by the telemetry inputs and the partial flag (tested). `model-dev-tyre-full` run twice: 20/20 files
    byte-identical. Counts unchanged (108/32 and 49/16; 184/50 and 64/22).
    - Validation PR-AUC: LR 0.604 → 0.650 (G=3.5), 0.710 → 0.720 (G=5.0); GBT 0.621 → 0.674, 0.617 → 0.636.
    - LR LOSO mean 0.398 → 0.402 (G=3.5), 0.468 → 0.468 (G=5.0).
  - Unchanged: `real` 52 columns, `scorer.json`, the `real_ti` files after the reference run, and v1.
- Step 9e: pre-registered model spec v2 `docs/model_spec_v2.md` (frozen once committed and tagged `model-spec-v2`)
  - It adds to v1 and replaces nothing. On 2025: `real` (PRIMARY, 52 columns), with `real_tyre` (70) and `real_ti` (98) as
    ABLATION for #30. Each gets LR and GBT, raw and calibrated, at G=3.5 k=2 (primary) and G=5.0 k=3. The majority
    and rule baselines are fixed references. Deployment stays `real` calibrated LR (`scorer.json` `0a9b7dfb…`, unchanged).
  - Selection rule (v2 playbook, 12 Nov 2026, tag `model-spec-v2`) applied to `results/model_dev_loso{,_real_tyre,_real_ti}.csv`: mean LOSO
    LR PR-AUC is 0.413 / 0.402 / 0.374, so `real` stays primary for any margin ≥ 0.
  - It also covers the v1 rules (unchanged), the paired race-cluster ablation intervals with no significance claim,
    the ORACLE label, determinism (GBT is row-order sensitive up to 0.043), missing data (Miami R6 55.6%, Belgium R13
    93.5%) and what was seen before the freeze (no model beat the rule on LOSO at the primary setting: 0.533 vs 0.559).
  - Code: `features.TEST_FEATURE_SETS = ("real", "real_tyre", "real_ti")`. `RunConfig` accepts `--allow-test-season` only
    for these, so `with_synthetic` is still refused. The overwrite guard already covers the `_real_tyre`/`_real_ti`
    names, and this is now tested.
  - `make model-test-full CONFIRM=yes` makes 6 runs (`real`'s two commands are byte-identical to v1), and
    `FEATURE_SET=<set>` runs one set (crash recovery). Any other value is refused.
  - Tests: the spec marker line equals `TEST_FEATURE_SETS`; all 6 test runs write disjoint files and `real`'s names
    are unchanged; the overwrite guard for `real_tyre`/`real_ti` (each file blocks only its own run, and `real`'s files
    and the other set never block it); Makefile order, `FEATURE_SET`, refusals. No 2025 read, no training, no test run.
- Step 11 (W5): Redis serving layer (#21–#24) and the Redis latency benchmark (#37)
  - `serving/keys.py`: `driver_key`, `order_key`, `events_channel` and `race_pattern`, exactly the docs/architecture.md
    names. Validation: season 1950–2100, round 1–30, driverId `[a-z0-9_]+`, ints only, else `InvalidKeyError`.
    Also defines `DRIVER_FIELDS` (the 9 fields) and `EVENT_TYPES`.
  - `serving/redis_store.py`, sync `RaceStore` and async `AsyncRaceStore` (`redis.asyncio`), built on the same
    command code:
    - `upsert_driver_state` writes all 9 fields as strings, with `""` for null (user choice) and `updated_at`
      ISO-8601 UTC with ms;
    - `set_order` is a ZADD with score = position;
    - `publish_event` sends JSON with `type`, `event_ts` and `published_at`;
    - `expire_race` SCANs `race:{s}:{r}:*` and EXPIREs every key, the order included; `end_session` publishes
      `session_end` and then expires;
    - `write_batch` sends a micro-batch through one `pipeline(transaction=False)` with one `execute()`;
    - `DriverState` validation rejects NaN, inf, negatives, bad compounds and duplicate positions before anything
      is sent;
    - the URL comes only from `Settings.redis_url`.
  - Settings: new `REDIS_SAFETY_TTL_S` (default 21600 s), set on every key write. `.env.example` is updated.
  - `serving/latency_bench.py` + `experiments/redis_latency.py`. 20 drivers at 1, 10 and 60 micro-batches/s for 60 s
    each (user choice: rate = micro-batches/s). Each tick times one pipelined write, 20 HGETALL and 1 ZRANGE.
    The benchmark uses its own namespace `race:2100:30:*`, refuses if that namespace is occupied, and cleans up
    afterwards.
    - `redis-cli --latency -i 1` exits after one 1 s summary when there is no TTY (checked: 1.2 s, 97 samples).
      It is therefore run 30 times back to back in one `docker compose exec` and the results are combined: min,
      max, sample-weighted mean, total samples.
  - Run (core and full profile containers up), `results/redis_latency.csv`, p50 / p95 / p99 in ms:

    | rate | write (20 drivers, 1 pipeline) | HGETALL | ZRANGE | achieved, late ticks |
    |---|---|---|---|---|
    | 1/s | 1.31 / 2.04 / 2.24 | 0.25 / 0.49 / 0.63 | 0.28 / 0.52 / 0.68 | 1.00/s, 0 |
    | 10/s | 2.06 / 3.48 / 25.75 | 0.41 / 0.67 / 1.42 | 0.50 / 0.82 / 4.10 | 10.00/s, 8 |
    | 60/s | 2.10 / 9.20 / 19.77 | 0.44 / 1.09 / 8.17 | 0.54 / 1.70 / 8.77 | 51.09/s, 2876 |

    In-container PING (redis-cli, 30 × 1 s): min 0.053, mean 0.282, max 10.02 ms, 2914 samples. The environment
    fingerprint is in `results/README.md`.
  - Tests: `test_keys.py`, `test_redis_store.py` (sync + async on fakeredis), `test_latency_bench.py`,
    `test_config.py` (new setting), and `tests/integration/test_redis_store.py` (real Redis 8.10: batch, pubsub,
    TTL, async).
- Step 12 (W6): Kafka race replay and Structured Streaming undercut detector into Redis (#19, #20, #23, #31)
  - User decisions: track status and race distance cannot be computed live (the heuristic uses the whole race's
    green median; `race_laps` is the winner's lap count). They are replayed as race context on each lap event
    (`track_neutral`, `track_red_flag`, `race_laps`; disclosed). On the host the Kafka connector comes from
    `spark.jars.packages` (pinned 4.2.1, ivy cache `data/cache/ivy`).
  - `streaming/`: `events.py` (schema, JSON, Spark StructType, infra-header filter), `producer.py` (one race in
    race order x SPEED, acks=all, idempotent, key=driver_id, `session_end` per partition, 2025 refused),
    `stream_job.py` (readStream latest, maxOffsetsPerTrigger, trigger 500 ms, foreachBatch, progress listener),
    `processor.py` (driver-side state, watermark over partitions, state snapshot and batch-id replay skip),
    `live_state.py` / `live_features.py` (Spark-free ports of the 21 `real` inputs and the shared rule),
    `priors.py` (pit-loss and out-lap priors of earlier races, one partition read), `redis_sink.py` (one
    `write_batch` per batch and race, `end_session`, nothing after it), `latency.py`, `demo.py`, `parity.py`.
  - `make stream-demo SEASON ROUND SPEED [FULL=1]`, `make stream-parity-full`; features/, model/, serving/ untouched.
  - Parity (21 inputs, docs/architecture.md "Streaming"): full lake 2021-2024, 90 races, 34,608 eligible pairs at
    every decision lap and 157 labelled attempts identical; max input diff 0.0, max P diff 3.3e-16
    (`results/stream_parity_full.csv`). Sample and Step 8 scenarios too, at batch sizes 1/7/50 and a lagging
    partition, with the rehearsal model and the deployed model.
  - Runs (sample 2024 R5): host at speed 60 and 10 and FULL=1 at 60, 20 drivers in the order set, TTL ~3600 s
    after session_end. Recorded run (`make stream-demo` speed 60, after the alert policy): 1,252 messages, end
    to end p50 814 / p95 1481 / p99 3303 ms; the 500 ms trigger dominates.
  - Tests: 12 new unit files (parity, events, producer, live state and features, priors, sink, job, latency,
    demo, Makefile) and `tests/integration/test_streaming.py` (real Kafka + Redis, speed 60, infra message).
  - Alert policy (`alerts.py`; `reason`/`trigger` in `events.UndercutAlert`): `opportunity` on a new candidate
    or a P crossing 0.5 upward, `attempt` (P at L-1) when the attacker pits; hashes, rule, scorer, parity
    unchanged. 2024 R5: 409 -> 141 alerts (113 new, 19 crossed, 9 attempts = batch detector-eligible attempts,
    labelled hulkenberg/bottas L-1=7 included); `parity.check_alerts` in the unit and integration tests.
- Step 13 (W6): FastAPI backend `src/f1sa/api/` (#25, API half)
  - User decisions: the clean zone is read over file:// **and** HttpFS (read-only: LISTSTATUS and OPEN over
    GET only, `{lake}/clean/{races,results,laps}` only, `season=2025` never listed or opened unless
    `ALLOW_TEST_SEASON=1`); one replay at a time (`API_MAX_REPLAYS=1`).
  - Endpoints, all under `/api`, docs at `/api/docs`:
    - `GET /health`: Redis PING, Kafka topic describe, and the deployed model loaded with the stream job's own
      `load_model`. It reports version, git sha, dirty flag and the scorer sha256 (`0a9b7dfb…`). 200, or 503
      naming the failed check.
    - `GET /races`: replayable races from the clean zone, using the producer's race-distance rule.
    - `GET /races/{s}/{r}/state`: the 9-field `DriverStateOut` (`""` → null), plus the order; 404, 422,
      500 and 503.
    - `GET /races/{s}/{r}/events`: SSE, with event = type and id = `payload.event_id` (or a deterministic
      uuid5 for alerts and `session_end`, which carry no id). It adds `sse_sent_at_ms`, sends a heartbeat
      every 15 s, unsubscribes on disconnect (both ASGI spec paths) and closes after `session_end`.
    - `POST /races/{s}/{r}/replay {speed: 1|10|60}`: a producer subprocess, only with `ENABLE_REPLAY=1`.
      Gives 409 for the same race or at the limit, and refuses 2025 with the producer's own `check_season`.
    - `POST /debug/latency`: only with `ENABLE_DEBUG=1`. It joins the client's render time with the
      server-side timings of the event it sent and appends to `results/ui_latency.csv`.
  - Settings (`config.py`, `.env.example`): `API_HOST` (127.0.0.1), `API_PORT`, `API_CORS_ORIGINS` (a list since the Step 14 follow-up; was one
    origin, `*` refused), `ENABLE_REPLAY`, `ENABLE_DEBUG`, `ALLOW_TEST_SEASON`, `API_MAX_REPLAYS`,
    `API_SSE_HEARTBEAT_S`, `API_RACES_CACHE_S`, `API_KAFKA_TIMEOUT_S`, `API_MODEL_DIR`, `API_UI_LATENCY_CSV`.
  - JSON-lines logging: one access line per request with no query string; exceptions are logged by class
    name only; no settings appear in responses or logs (tested with a password in the Redis URL).
  - Compose `api` service (core profile, app image, `python -m f1sa.api`, mem_limit 1536m):
    - published on `127.0.0.1:${API_HOST_PORT:-8000}` only;
    - mounts the repo, `./data` and `./models` read-only, and `./results` read-write;
    - its healthcheck accepts 200 or 503;
    - `make up` now waits for it.
  - Makefile: `make api` (host, file lake) and `make test-api`. `pyproject.toml`: a `f1sa-api` script, and
    pyarrow added to mypy's untyped modules. No new dependency.
  - No change to `streaming/`, `serving/`, `features/`, `model/`, `lake/`, `ingest/`, `scorer.json` or the
    label definition and model specs (`git diff` empty there).
  - Verified live (core and full profiles up; only the new `api` container was created, with `--no-deps`):
    - Host `make api` gives health 200, races 2023 R5 (57 laps) and 2024 R5 (56), bound to 127.0.0.1.
    - Container SSE during `make stream-demo SEASON=2024 ROUND=5 SPEED=60`: 1,252 frames (1,030 lap, 40
      pit_in, 40 pit_out, 141 undercut_alert, 1 session_end, the same counts as the Step 12 run), all ids
      unique. The stream closed after `session_end`. Redis write → SSE send took p50 2 / p95 5 / max 332 ms.
      State: 20 drivers with exactly the 9 fields.
    - Container replay: 202, then 409 (running), 409 (limit), 403 (2025) and 422 (speed 7). The producer
      delivered 1,113 events and exited 0, which freed the slot. Peak container memory 775 MiB.
    - HttpFS catalog on the real HDFS lake (app container): 90 races (2021–2024) in 3.2 s. Only GET
      LISTSTATUS (195) and OPEN (180), all under `/f1/clean/{races,results,laps}`, and 0 paths with
      `season=2025`. With `ALLOW_TEST_SEASON=1`: 114 races.
    - The `make stream-demo` check overwrote the three recorded Step 12 results files. They were restored
      from git, and their sha256 equals the before-values.
  - Tests:
    - 10 unit files: `test_api_{config,health,races,state,events,replay,debug,app}.py`,
      `test_makefile_api.py` and `_api_fixtures.py`.
    - They cover every status code; the state model's exact fields; SSE frames, heartbeat and close; raw
      ASGI disconnect for spec 2.3 and 2.4; the replay 409s, cap, concurrency, 2025 and a real subprocess;
      the ENABLE flags; CORS; and logs.
    - The three HttpFS guards (read-only, clean zone only, 2025) each have a test.
    - `tests/integration/test_api.py` runs uvicorn over TCP on real Redis and Kafka: health 200, state,
      live SSE with heartbeat, unsubscribe after a real disconnect, and close after `session_end`.
- Step 13 follow-up (user's three fixes, plus the whole-pipeline replay the user chose)
  - **Full-lake api container.** `make api-up [FULL=1] [REPLAY=1] [DEBUG=1] [TEST_SEASON=1]` recreates only
    the `api` service (`up -d --no-deps --no-build --force-recreate api`: no other service restarts, no
    volume touched). `FULL=1` sets `API_DATA_LAKE_URI=hdfs://namenode:8020/f1` (HttpFS `http://httpfs:14000`)
    and refuses unless the hdfs profile is healthy. The default stays sample mode, and `make up` restores it.
    README "API" documents it.
  - **Port clash.** `make api` uses `API_PORT=8001` by default; the container keeps 8000. If the port is
    taken, `python -m f1sa.api` exits 2 naming the holder (psutil, else the Docker container publishing
    it) and the remedy. Verified live: "port 127.0.0.1:8000 is already in use by Docker container
    f1sa-api-1 …".
  - **Demo outputs.** `make stream-demo` and API replays write to `data/demo/<run_id>/`; only
    `RECORD=1` writes to `results/` (`experiments/streaming_latency.py --record`, new `demo_runs.py`,
    `DEMO_DIR`). `streaming/` is unchanged: `demo.py` and `stream_job.py` already took `--results-dir`.
  - **Replay = the whole pipeline** (user choice):
    - order: stream job, ready file, producer, then the stream job stops after `session_end`;
    - outputs in `data/demo/<run_id>/`;
    - 60 s readiness timeout (`API_REPLAY_READY_TIMEOUT_S`) and 180 s end timeout; on a timeout or failure
      both processes are killed and the slot is idle again;
    - state and error in the new `GET /api/replays`;
    - process groups with SIGTERM, then SIGKILL and a final sweep, so no orphan JVMs.
    - Bug found by the real-subprocess test and fixed: Python 3.12's `asyncio` `wait()` also waits for
      the pipes to close, so a leftover child holding stdout hung the replay. Waiting now uses the
      leader's exit code.
  - Compose `api` (final, user-approved):
    - `mem_limit` is 2048m (the user is raising WSL to 14 GB);
    - mounts: `./data` read-only, with `./data/demo` and `./data/checkpoints` read-write on top;
      `./models` read-only; `./results` read-write;
    - `make up`, `up-full` and `api-up` create the two host folders first, so Docker does not create them
      root-owned.
    - Checked live: inside the container, `>> /workspace/data/manifest.json` gives "Read-only file
      system" (EROFS), and the host file's sha256 is unchanged. `/app/data` does not exist in this image;
      the app works under `/workspace`. `models/` is read-only too.
    - A sample replay of 2024 R5 at 60× `finished` (0/0) in 2 min 2 s with 1,252 SSE events. Afterwards
      only uvicorn runs in the container, `results/` is identical, and peak memory was 1.49 GiB.
  - `make demo-clean [CONFIRM=yes]` (`python -m f1sa.demo_runs`):
    - deletes only the `<run_id>` folders of `./data/demo` and the `api_<run_id>` / `demo_<S>_<R>_<unix>`
      checkpoints (and their `.ready` files), and prints what it deleted;
    - without CONFIRM it lists and exits 1;
    - it refuses (exit 2) any other root (`..`, absolute paths, a symlinked root, `DEMO_DIR`
      elsewhere), and keeps other names and symlinked entries.
    - Live dry run: 19 entries listed, nothing deleted.
    - Tests: `test_demo_clean.py` (17), covering 10 refused paths, the symlinked root, a symlinked
      entry, the listing, and the make target.
  - Live (`make api-up FULL=1 REPLAY=1`, only the api container recreated):
    - `/api/races` gives 90 races, from 2021 R1 Bahrain (56 laps) to 2024 R24 Abu Dhabi (58).
    - Replay of 2023 R10 at 60×: the first SSE lap events came about 23 s after the POST. It
      `finished` with exit codes 0/0 in 106 s, and Redis holds 20 drivers.
    - Afterwards only tini and uvicorn run in the container. Outputs are in `data/demo/<run_id>/`, every
      `results/` file is byte-identical, and `git status results/` is empty.
    - Peak api container memory: 1.33 GiB (the limit was 1.5 GiB then; it is now 2 GiB).
  - Tests:
    - `test_api_replay.py`, rewritten (26 tests): the pipeline order and argv; the timeout path
      (killed, failed, slot idle, error in `/api/replays`); SIGTERM ignored then SIGKILL; exit before
      ready; producer failure; no stop after the producer; shutdown; and two real-subprocess tests
      checking that the stream job's child (a stand-in JVM) is gone after the timeout and after a
      normal finish.
    - `test_demo_outputs.py`: a default demo run leaves `results/` unchanged (sha256), `RECORD=1`
      writes it, the argv rules, the run ids, and the make targets.
    - Port-clash and `main` tests in `test_api_app.py`; the `api-up` make tests.
- Step 14 (W7): live race dashboard `web/` (#25, #41)
  - User decisions: the gap chart is hand-written SVG (no chart library), and Playwright uses a host
    Chromium download.
  - Pinned exactly, with `package-lock.json` and `save-exact`:
    - Node 26.13.0 (LTS);
    - Next.js 16.4.5, React 19.3.1, TypeScript 6.0.3;
    - ESLint 9.39.5, Vitest 5.0.5, Playwright 1.64.1.
  - No UI, CSS or schema library.
  - Pages:
    - `/` is a race picker grouped by season. It has a search, arrow/Home/End keys, a polite count, and a
      tag on each synthetic race.
    - `/race/[season]/[round]` has the timing tower (8 columns, order-set order, a "laps down" rule), a
      15-lap gap chart, a tyre panel (text + glyph + age bar), the alert feed (grouped by pair; the
      `aria-live` region speaks only attempts and threshold crossings), replay control (1/10/60, status
      from `/api/replays`, failed + message), a connection indicator and the lap counter.
    - A fixed banner strip shows SYNTHETIC DEMO DATA in sample mode.
  - One pure reducer (`web/src/lib/reducer.ts`). Race state is pushed only: SSE events plus the API's
    `event: snapshot` (see the follow-up below). On a reconnect the stream is opened first, then `/state`
    is reloaded once, then the buffered events are applied.
  - API change (user-allowed, tested): `/api/races` items gain `synthetic` (from the clean `stints`
    `is_synthetic`; `stints` joins the read-only HttpFS table allowlist), and `/api/health` gains
    `lake {scheme, mode, synthetic}`, which is informational and never changes the status.
  - Docker:
    - `docker/web/Dockerfile`: 3 stages, standalone output, runs as `node` (uid 1000);
    - compose `web` (core and full): 127.0.0.1:3000, read-only root filesystem, `cap_drop ALL`,
      `no-new-privileges`, 512 MiB;
    - `make web` (dev, with a port preflight), `make web-test`, `make web-e2e`;
    - a CI `web` job.
  - Found and fixed with the screenshots and the e2e test:
    - At 375 px the visually hidden chart table caused a 15 px horizontal scroll: a `<table>` ignores the
      1 px width, so a wrapper is hidden instead.
    - "+1 L" showed for cars that were merely behind on the line: it now needs the leader to have
      completed the next lap first.
    - The driver column collapsed to 0 at 375 px: all columns now get fixed widths.
    - Chart end labels piled up at the top edge: a two-pass layout now shrinks the spacing evenly.
    - Undercut flags stuck on every car: alerts only report new candidates. Fixed on the server with the
      pushed `snapshot` event (see the follow-up below).
    - Dark border and grid colours were under 3:1: caught by the contrast test and raised.
  - Verified live (sample mode, `make api-up REPLAY=1`):
    - the Playwright smoke test passes against `next start` (49.5 s) and against the production
      container (19.1 s, 45.6 s);
    - `curl -sI localhost:3000` gives 200 with the security headers; `id` in the container gives
      uid 1000 (node);
    - only the `api` and `web` containers were recreated;
    - `results/` is byte-identical after every replay, and `git status results/` is empty.
  - Tests:
    - Vitest: 128 in 5 files (reducer 42, aria-live filter, event parser, guards, format, chart geometry
      and label layout, params, picker and replay helpers, WCAG contrast of both themes);
    - Playwright smoke test: 1;
    - Python: `test_api_races.py` (synthetic per race, stints over HttpFS), `test_api_health.py`
      (`lake` block) and `test_makefile_web.py` (6).
- Step 14 follow-up: pushed snapshots instead of client polling, and two CORS origins
  - The 5 s `/state` polling is removed from the client. The API now pushes `event: snapshot` (id
    `snapshot-<lap>`), with all driver hashes plus the order zset in one pipeline (`api/state.py`, shared
    with `GET /state`). It is sent right after connect and once per leader lap (the first `lap` event of a
    higher lap number). Per-lap snapshots never SCAN. The client keeps the open-stream-then-reload-`/state`
    logic for reconnects only.
  - CORS: `API_CORS_ORIGINS` is a comma-separated list, defaulting to `http://localhost:3000` and
    `http://127.0.0.1:3000`; `*` is refused. Checked live: both are echoed back, and `http://evil.example`
    gets no header.
  - Mid-race, without polling (page opened at `127.0.0.1:3000`):
    - 28 snapshots; the UI's flagged count equals the snapshot's on all 27 laps;
    - it also equals a direct Redis read on 26/27 laps (lap 20: Redis 13 vs UI 12, one batch later);
    - 0 page requests to `/state`.
  - Tests:
    - API, 5 new SSE tests: one snapshot after connect and one per leader lap (not per event); stale flag
      refreshed; one pipeline and no SCAN per lap; an unreadable snapshot skipped while the stream goes
      on; snapshots are not latency samples;
    - CORS for both origins plus 5 refused origins; the origin list from settings and env;
    - Vitest 133: snapshot replacing stale flags, no dedupe, zset order, malformed and foreign snapshots;
    - `make web-e2e` passes (58.7 s).
- Step 10 (W5): Spark scalability, partitioning and caching experiments (#27, #28, #33, #34, #38)
  - New package `src/f1sa/bench/` (user-approved layout), thin entry points `experiments/scalability.py`,
    `experiments/partitioning.py`, `experiments/_resources.py`. Method and limits: `docs/experiments.md`.
    - `paths.py`: `check_bench_uri` allows only `hdfs://namenode:8020/f1/bench/**` and `./data/bench/**`
      (refuses `/f1/raw`, `/f1/clean`, `/f1/features`, `..`, symlinked roots, other hosts and schemes);
      run ids; outputs in `data/bench/<run_id>/`, `results/` only with `--record`; `bench-clean`.
    - `replicate.py`: x1/x4/x16/x64 of the 9 clean feature inputs (season + 100·r, dates + 100·r years,
      `driver_id__r<r>`, constructors unchanged, `is_replicated`); exactly factor x rows, unique keys.
    - `workloads.py`: `compute_features` unchanged, written with `write_partitioned`; `undercut_attempts`
      to `noop` (labels never read or persisted). Telemetry: `aggregate_samples` over the 2024 raw
      samples (first 5/14/24 rounds for 1/3/5 seasons, x1 cells only), joined to laps, into `noop`.
    - `cell.py` (one JVM per cell; local driver 2g + `MALLOC_ARENA_MAX=2`; cluster driver 1g, executors
      768m x 2 cores, current `src/f1sa` shipped as a zip and checked on the executors), `grid.py`
      (cells, guard, estimate, reduced grid), `timing.py` (warm-up + timed runs, median/IQR/min/max,
      `MemoryGuard`), `spark_metrics.py` (REST API bytes per job group), `resources.py` (psutil +
      cgroup sampler, `docker stats` sampler, window peaks), `partitioning.py` (2 layouts x 3 caching
      variants x file/hdfs, result checksums, speed-ups), `report.py` (CSV, PNG, fingerprint), `host.py`.
  - Makefile: `bench-dirs`, `bench-smoke`, `experiments-spark [RECORD=1] [GRID_ARGS=] [PART_ARGS=]`,
    `bench-clean [CONFIRM=yes]`, `test-bench`. All use `docker compose exec` into the running app container.
  - Compose: app `mem_limit` 1536m -> 4096m (user-approved); only the app container was recreated
    (`up -d --no-deps --no-build --force-recreate app`), limit verified 4294967296.
  - Changes from the approved plan, all forced by smoke-run measurements:
    - local driver heap 2g instead of 2560m: at 2560m the driver RSS was 3.4 GB and the guard killed the
      first cell (1 season, x1) at 3.61 GiB;
    - no linear memory projection: it projected 3.16 GiB (x1) to 12.65 GiB (x4) and skipped a cell that
      ran at 3.55 GiB. The guard now kills at 90 % of the container at runtime and then skips larger
      factors of the same (phase, seasons, master);
    - the telemetry summary uses every per-lap aggregate: with only three of them Spark pruned the
      gear-change lag window from the plan (unit test checks the plan has a `Window`);
    - partitioning averages over `decimal(20,6)`: a double average flipped a 6-decimal rounding between
      layouts (108.706062 vs .063), caught by the checksum test;
    - the smoke also runs local[4] at x4 so the estimate is an affine x1/x4 fit, not linear.
  - Smoke runs (data/bench only; `results/` and HDFS raw/clean/features listings identical before/after):
    - scalability `bench_20261113T072050Z_smoke`: 11/11 cells ok. Build at 1 season x1, one run:
      local[1] 44.5 s, local[2] 37.0 s, local[4] 33.1 s, cluster 42.3 s; local[4] x4 94.0 s. Telemetry
      (5 rounds): 8.5 / 6.8 / 5.5 / 7.7 s. Peak app container 2.9-3.1 GiB at x1, 3.55 GiB at x4.
      Input ~75 MB, shuffle ~13 MB per x1 build run; executors imported the shipped zip.
    - partitioning `bench_20261113T072933Z_psmoke` (laps x1, 5 telemetry rounds, 1 run): 84 rows,
      every checksum identical across layouts, variants and file systems.
    - Estimate (affine x1/x4 fit, excludes costs that grow faster than the rows): full grid 72 cells
      ~119 h; partitioning ~0.5 h. Proposed reduced grid, ~6.3 h (45 cells): 1/3/5 seasons x every
      master at x1 and x4, x16 for 1 season on local[4] and the cluster, no x64, 1 warm-up + 3 timed runs.
  - Tests: 104 new (`test_bench_*.py`, `test_makefile_bench.py`): timing harness with a trivial and a
    real Spark job, median/IQR, guard skip and runtime kill of a real child, bench-clean refusals
    (10 roots) and fake HttpFS, replication x1/x4 row counts and unique keys, REST metrics, docker stats
    parsing, plots, record vs default outputs. Full unit suite: 1400 passed in 744 s, results guard silent.
- Step 10 follow-up (user request): resumable `make experiments-spark`
  - The grid appends each finished cell's row to `data/bench/<run_id>/scalability.csv` at once
    (`report.append_rows_atomic`: temp file, fsync, rename), with the host's docker peaks of that cell
    (read from the shared `docker_stats.jsonl`) and the git sha passed into the container.
  - `RESUME=<run_id>` (the exact command is printed at the start of every run): the stored
    `grid_spec.json` is used (`GRID_ARGS` must not differ); stale cell processes of the run are killed;
    cells with a row are skipped; an interrupted cell reruns from its warm-up (its old result file and
    outputs are removed first); a prep with pending cells reruns and reuses its HDFS copy via the
    `_BENCH_PREP.json` marker (or prepares it again); the guard's skips are restored from the CSV.
  - Partitioning resumes by group (dataset, fs, layout, variant), reusing its marked layouts.
  - `RECORD=1`: `results/` only when the grid (then partitioning) is complete; one fingerprint per run id.
    HDFS data are deleted only after a complete run. The host exits 0 when complete (aborted or
    skipped cells are recorded results), so make goes on to partitioning; before, a single aborted
    cell would have stopped make before partitioning.
  - Tests (`test_bench_resume.py`, updated host, workload and make tests): fake grid killed after 2 cells
    then resumed (every cell exactly once; a second grid on the same run is refused by a flock; the interrupted cell rerun, prep rerun without a second row);
    a real grid process SIGKILLed mid-cell then resumed (orphan killed, CSV complete, each cell once);
    guard state restored; refusals; atomic CSV/JSONL append with a partial last line; marker reuse of
    the replicated copy and of the partitioning layouts (Spark); record only when complete.
  - Live check on the stack (`bench_20261113T100000Z_smoke`): the grid was SIGKILLed in the container
    after 2 cells; the resume killed the orphaned cell (pid 50092), reused the x1 copy (0.3 s), ran the
    other 9 cells, and the CSV has all 11 cells once; HDFS data deleted at completion.
  - Finding: in that run `build_s1_x4_local4` was killed by the guard at 3.64 GiB (it passed at 3.55 GiB
    in the previous smoke). Local x4 cells at 3 and 5 seasons in the approved grid will very likely be
    killed too (see Next).
- Step 10 follow-up (user-approved): app container `mem_limit` 4096m -> 6144m
  - Only the app container was recreated (`up -d --no-deps --no-build --force-recreate app`); limit
    6442450944 bytes (docker inspect and the container's cgroup `memory.max`); every other service kept
    running. The local driver heap stays 2g.
  - Re-run of the cell alone (`bench_20261113T095530Z`: `--seasons 1 --factors 4 --masters local4
    --warmup 0 --repeats 1`, prep + build): `build_s1_x4_local4` ok, 74.5 s; peak app container memory
    3.49 GiB (process tree RSS 3.61 GiB, docker stats 3.28 GiB) against the 5.40 GiB guard (90 % of 6 GiB);
    host MemAvailable never below 5.98 GiB (api and web still running). The prep peaked at 1.29 GiB.
  - The x4 cells at 3 and 5 seasons have 2.9x and 4.7x the rows. Memory grew from 3.14 to 3.49-3.64 GiB
    between x1 and x4 at 1 season, so they should fit under 5.40 GiB, but that is not measured.
  - `docs/architecture.md` memory budget: app 6 GiB, core about 9.6 GiB, full about 15 GiB of limits;
    api and web are stopped during the overnight grid (about 12.5 GiB). `docs/experiments.md` updated.
- Step 15 (W7): what-if pit strategy simulator, API route and dashboard panel (#26, #32, #40, #41)
  - User decisions (plan): `stay_out` is an overcut (A pits the lap after D); live lap history comes from an
    API lap recorder on the race channel; the tyre model is an offline artefact in `models/sim/`.
  - `docs/sim_spec.md`: pre-registration of the strategies, every constant, the checks, the 2025 held-out row and
    the stop rule. It was written before any backtest run. Two amendments are recorded there, both decided before
    any backtest, from the data and a unit test:
    - the stop noise is a robust SD (1.4826 x MAD), because the sample SDs (3.4 s and 8.9 s) are dominated by
      tails;
    - the fuel trend phi is one joint value per race, because a per-compound phi is not identified.
  - `sim/tyre_model.py`: per circuit x compound degradation from strictly earlier races. Linear unless quadratic
    wins on leave-one-race-out RMSE; fallbacks circuit -> compound -> global -> none with flags. Real
    TracingInsights compounds in full mode (`compound_conflict` gives UNKNOWN), synthetic and flagged in sample
    mode. Written atomically to `models/sim/tyre_model_{sample,full}.json` only.
    - Full lake 2021-2024: 90 races; phi median -0.046 s/lap (range -0.067 to -0.040); 2024 Catalunya MEDIUM
      beta 0.071 s/lap; stop-noise SDs 0.76 s and 1.13 s.
  - `sim/race_sim.py`: seeded Monte Carlo (n=500, NumPy) with common random numbers, traffic hold, race-end
    infeasibility; about 1 ms per state.
  - `sim/whatif.py`: one decision-state builder for live and backtest; a pure-Python port of
    `streaming.priors.priors_from_frames`, equal to Spark on the sample lake; `WhatIfService` caches 8 races.
  - API: `POST /api/races/{s}/{r}/whatif` (200 / 404 / 409 / 422 / 503) and `api/lap_log.py`, fed by the SSE
    `on_sent` hook (no second subscription, so the Step 13 disconnect tests are unchanged) and a subscriber
    started by a replay start or the first what-if.
    - The lake readers gained a zone and table allowlist. The race catalog is unchanged; the what-if readers are
      `clean/{races,laps,stints,stints_tracinginsights}` and `features/{pit_loss,outlap_features}`; raw is never
      readable.
    - Setting `API_SIM_DIR` (default `models/sim`); the tyre model file is chosen per race from the catalog's
      `synthetic` flag.
  - Dashboard: `WhatIfPanel` (labelled selects, the defender follows the car ahead, keyboard run, status and alert
    lines, a captioned table with row headers, P as text plus an `aria-hidden` bar, sensitivity row group,
    model P as text, reserved height, reduced motion respected, no overflow at 375 px), `lib/whatif.ts` (guards
    and helpers).
  - Experiment: `experiments/whatif_consistency.py` -> `sim/consistency.py` + `sim/backtest.py`;
    `make whatif-consistency-{sample,full}`, `make sim-tyre-model-{sample,full}`. Only `RECORD=1` writes
    `results/` (refuses to overwrite) and opens 2025.
  - **Development run** (`make whatif-consistency-full`, 2021-2024, no 2025 read, output in
    `data/whatif/full_20261113T142444Z/`, not committed):
    - 157 labelled attempts (as in the Step 12 parity check), 155 feasible: the 2 infeasible ones have no
      pit-loss prior (the first race).
    - Mean P_sim - P_model = -0.025 (stop rule 0.20: not triggered); mean |difference| 0.138; Spearman 0.66.
    - Simulator Brier 0.185 (model 0.152 on its own training and calibration rows), ECE (10 bins) 0.090 (model
      0.058), mean P 0.295 against an observed 0.303.
    - Monotonicity in the attacker's loss: 0 of 155 states with an increase (pass). Both cars' loss is flat, as
      expected (info).
    - Determinism: 157/157 byte-identical (pass); seed + 1 changes P by at most 0.06.
    - Ordering grid: 17/18 pass/fail rows pass. **One failure**: opening at -0.5 s/lap with a 5.0 s gap,
      P_next - P_now = +0.022. The mean gap moves against the attacker (-6.10 -> -6.58 s), but the extra
      simulated lap widens the 80% interval (10.4 -> 12.1 s), and that raises a small tail probability (0.062
      -> 0.084). Reported as it is; nothing was tuned.
    - User decision (a): the pre-registered rule stays unchanged, and the failed cell is part of the result.
      - A post-hoc supplementary column was added, labelled as such and never pass/fail: `check = ordering_posthoc`,
        `post_hoc = true`, the sign of E[gap next] − E[gap now]. It is recorded in `docs/sim_spec.md`
        ("Post-hoc supplement", dated).
      - Rerun (`data/whatif/full_20261113T145605Z/`): identical pre-registered results; the expected-gap sign
        follows the closing rate in 10/10 cells (−0.479 / +0.021 / +0.521 s); the failing cell's E[gap]
        difference is −0.479 s.
  - Test fix: `test_bench_grid.py::test_subprocess_cell_ok` read the host's live cgroup and `MemAvailable`. It
    failed when the machine used more than 0.9 x 4 GiB, and it did here at 3.7 GiB. It now injects a fake cgroup
    and meminfo through `sampler_kwargs`, as its sibling test does. The guard's behaviour in real runs is unchanged
    (`src/f1sa/bench` is untouched).
  - Verified live on the host (no container changed): `make api` with replay plus `next start` on :3001; a 60x
    replay with the Playwright smoke test including the what-if steps (pass, 1.8 min); `POST …/whatif` 200 in
    about 9 ms, byte-identical body for the same seed, 409 / 404 / 422 / 404 for the bad cases.
- Step 10 follow-up (2026-11-14): StackOverflowError in 6 build cells (`build_s1_x16_{local4,cluster}`,
  `build_s5_x4_{local1,local2,local4,cluster}` of `bench_20261113T152740Z`)
  - **Root cause.** `etl/clean.select_races` OR-ed one `(season, round)` condition per race (`reduce(|, ...)`).
    The benchmark passes every replicated race to the unchanged `compute_features`, and Spark's recursive
    Column conversion overflowed at the `.filter` call (trace in `data/bench.log`). Reproduced: 264 race keys
    pass, 384 and 456 overflow.
  - **Fix.** One flat `struct(season, round) IN (...)` (an `InSet` after optimisation). Same rows, nulls match
    nothing, partition pruning is kept, no `-Xss`. The full `compute_features` now runs on the real s5_x4
    input (456 races).
  - **Same result.** `compute_features` with the old and the fixed filter on s1_x4 (96 races) and s3_x1 (68
    races): all 9 persisted feature tables have identical checksums. A rerun of `build_s1_x4_local4` /
    `build_s3_x1_local4` with the fix (no RECORD) gives identical `output_bytes`, with input and shuffle bytes
    within 0.31 %.
  - **Timing.** Both cells are faster than their recorded IQR: 54.0 s against 64.7 s [64.2, 70.6], and 43.7 s
    against 49.4 s [48.6, 51.8].
    - The cause is mostly the fix: filtering the 9 cached input tables once takes 5.38 s with the OR chain
      and 3.08 s with `IN` at 96 races, planning of the deep tree included.
    - Some environment variance is likely too (the unaffected prep cell was faster as well).
    - Cells timed with the fix are therefore not strictly comparable with the recorded ones (documented
      in `docs/experiments.md` and in the supplementary rows' `note`).
  - **Regression test.** `tests/unit/test_select_races.py`: 540 / 2000 keys of 600+ synthetic race keys,
    null keys, a flat `InSet` plan, `restrict`, and partition pruning. 4 of its 6 tests fail on the old
    implementation with StackOverflowError.
  - **Build plot.** `bench/report.plot_build_axes` draws (a) real seasons at x1 and (b)–(d) replication per
    season count, from the same data. Missing cells are marked and named; a hollow marker is a re-run.
    `make bench-replot [RECORD=1]` redraws it. Only `results/scalability_build.png` changed (the CSV, README
    and telemetry PNG were checked byte-identical).
  - **Supplementary re-run tooling (not run).**
    - `GridSpec.only` / `--only-cells` selects cells plus their prep, stored in `grid_spec.json`.
    - `--supplement-of <run>` takes the original grid's settings.
    - `make bench-supplement [RECORD=1]` merges the rows into `results/scalability.csv` with the new
      columns `rerun_of` and `note`; the failed rows stay, and the run's own `run_id` and `git_sha` are kept.
    - It refuses before running if a cell's recorded row is ok or already re-run.
    - Tests are in `tests/unit/test_bench_supplement.py` and `test_makefile_bench.py`, and the results-guard
      windows cover the new targets.
- Step 10 wrap-up (2026-11-14, write-up only, no new measurements): **Step 10 is Done** (#27, #28, #33, #34, #38)
  - Supplement run `bench_20261114T052031Z_supp` is committed. After the `select_races` fix, `build_s1_x16_local4`
    and `build_s5_x4_local1/2/4` were aborted by the memory guard (5.44-5.56 GiB of the 6 GiB container); the
    standalone cluster completed `s1_x16` (175.6 s) and `s5_x4` (213.6 s). Documented as a single-host scale-out
    observation, not a speed claim; the cluster `s1_x16` cell also peaked at 5.20 GiB (guard 5.40).
  - `docs/experiments.md`: final findings for telemetry (speed-up over local[1]: 1.5-1.7x local[2], 2.2-2.4x
    local[4], 1.8-2.2x cluster), the feature build (fixed overhead at small sizes; cluster fastest at 3 seasons
    x4), the supplement, and partitioning and caching (pruning 1.6-1.7x on file:// but only up to 1.2x on HDFS;
    full scans and joins 0.12-0.32x on the partitioned layout; caching only for small lap queries).
  - Plot footnote: `bench/report._missing_build_cells` now describes a cell with a re-run row once, by its
    re-run outcome, and no longer says "pending" or "again". `make bench-replot RECORD=1` redrew only
    `results/scalability_build.png`. Test: `tests/unit/test_bench_supplement.py::test_not_drawn_groups_cells_by_reason`.
  - `docs/traceability.md` rows 27, 28, 33, 34 and 38 are marked Done with their result files.
- Step 16 (2026-11-14): final experiments (#30, #31, #35, #36, #37, #38). **Done.**
  - **Part 0.** The working tree was clean. An earlier, stopped Step 16 session had left gitignored files in
    `data/`:
    - `data/ablation_record.log` and `data/ablation/full_20261114T101856Z/`: a complete paired-ablation run at
      10:18–10:21 UTC that printed the 2025 PR-AUC and Brier differences;
    - `data/oracle_record.log`: a development ORACLE run.

    Its code was restored to HEAD at 10:26 and its `results/` files were removed at 10:27. The files in
    `data/` were kept. User decision: rerun, and the rerun must reproduce that run exactly.
    Cause of the removal: the VS Code Git integration, not repo code. Its log
    (`~/.vscode-server/data/logs/20261113T113403/exthost2/vscode.git/Git.log`) shows discards at 10:26:21:
    `git clean -f -q -- results/ablation_paired.csv results/ablation_paired.png`, the new code files, and
    `git checkout -q -- Makefile results/README.md ...`. At 10:27:30 it shows
    `git clean -f -q -- results/model_dev_{eval,loso}_oracle*.csv`. There is no reflog entry, and
    `data/ablation_record.log` ends normally (`exit 0`).
  - **Paired ablation (#30)**, `make ablation-full RECORD=1` → `model/ablation.py`, `experiments/ablation.py`.
    - It uses the frozen 9f models only (no refit, re-tuning or re-calibration).
    - Exact match before any interval: all 720 rows (9,360 values) of the six committed `model_eval` files
      were reproduced, and the 252-line test table matched.
    - The per-attempt scores equal the earlier run's in all 6 files, and its 24 printed differences were
      reproduced.
    - One shared list of 1000 race-cluster resamples (seed 42) per setting reproduces all 756 committed per-set
      interval values.
    - 48 differences (`real_tyre − real`, `real_ti − real`, `real_ti − real_tyre`; calibrated LR and GBT;
      PR-AUC, Brier, ROC-AUC, ECE10; both settings) → `results/ablation_paired.{csv,png}`.
    - 46 of the 48 intervals contain 0; there is no significance claim.
    - Reading in `docs/model_results.md` "Paired ablation intervals (Step 16)". That section is outside
      "## Results", and a test keeps it byte-identical under `run_summary`.
  - **ORACLE**, `make oracle-dev-full RECORD=1` → `model/oracle_dev.py`.
    - `real` plus the realised out-lap delta. It is not usable at decision time.
    - 2021-2024 only: 2024 validation and LOSO; 2025 is never loaded. Outputs:
      `results/model_dev_{eval,loso}_oracle{,_G5.0_k3}.csv`.
    - At the primary setting, calibrated LR validation PR-AUC is 0.693 against 0.594 for `real`, and the raw
      LOSO mean is 0.469 against 0.413. At the sensitivity setting it is about the same.
    - The numbers equal the earlier session's log.
  - **Streaming (#31, #35, #36, #38).** `make stream-latency-suite RECORD=1` (`bench/streaming_runs.py`;
    `streaming/demo.py` gains `--sse-url`, `--window-s` and `--idle-s`; `streaming/latency.py` gains the SSE
    join and summaries; the producer, stream job and serving contract are unchanged).
    - Core profile only. HDFS, Spark and app were stopped with user approval and restored with `make up-full`.
    - 2024 R5 at 10x and 60x (full race) and at 1x (900 s window).
    - Steady-state end to end p50 / p95 / p99: 786.5 / 1227 / 1586.5 ms (10x), 798 / 1461.5 / 1757 ms (60x),
      729 / 1039 / 1115.4 ms (1x).
    - The first race batch (prior loading) costs about 1.3–1.4 s more and is reported separately.
    - Redis → SSE client: 2 ms p50.
    - Throughput equals the produced rate (12.7 msg/s at 60x).
    - Peaks: host job tree 1.6–1.85 GiB, kafka about 640 MiB, api below 90 MiB, redis below 30 MiB.
  - **UI segment.** `make stream-latency-ui RECORD=1`.
    - The api was recreated with `DEBUG=1 UI_LATENCY_CSV=data/demo/ui_latency/ui_latency.csv` and the web
      container was stopped, both with approval. Both were restored afterwards.
    - SSE send → paint p50 / p95 / p99: 28 / 37 / 40 ms.
    - 1252 samples for 1252 messages (nothing dropped at 60x). The samples are a subset by design (at most 50
      in flight).
  - **Redis (#37) rerun on the quiet stack.** `make redis-latency RECORD=1` → `results/redis_latency_quiet.csv`.
    - 60.00/s with 0 late ticks; every p99 is below 3.1 ms.
    - The Step 11 values stay in `results/redis_latency.csv` as the first run (noisy; old WSL config with 6 CPUs
      and 9.7 GiB, against 12 CPUs and about 14 GiB now).
    - `latency_bench` now writes to `data/redis_latency/<stamp>/` unless `--record` is given.
  - **`make experiments` / `make experiments-sample`** (`experiments/run_all.sh` → `bench/experiments.py`).
    - Every regenerable non-2025 generator runs in a sandbox `data/experiments/<id>/`, and its outputs are
      compared with `results/` by sha256. `results/` is never written.
    - Generators that open 2025 and the measurements are skipped and printed.
    - Full run: 19 min 26 s; 66 OK, 2 DIFF (the what-if CSV and PNG, which have the 2025 row; the CSV matches
      without it).
    - Sample run: 1 min 27 s; 7 OK, 1 OK (metadata differs) for the tyre model (`created_utc`, `git_sha`
      masked; all else byte for byte), 2 NEW, exit 0.
  - **Stale sample outputs regenerated (user request).** `results/model_eval_sample.csv` and
    `calibration_sample.csv`, committed 2026-11-11 before `decision_threshold` and `ece_5bin` existed, were
    rewritten with the normal `make model-eval-sample`.
    - Only those two files changed; they equal the sandbox outputs of the current code.
    - No full-data or 2025 file changed.
  - **Results.**
    - New files only (each RECORD target refuses existing names).
    - The Step 11 and Step 12 files are byte-identical.
    - `results/README.md` gains appended fingerprint sections: ablation, Redis, and one per streaming and UI
      file. The ORACLE files carry their stamp line and no README section, like the other `model_dev_*` files.
  - **Correction during the step.** The recorded `results/ui_latency_summary.csv` first used the lap and pit
    count (1110) as the denominator, giving subset 1.128. It was rebuilt from the same raw samples
    (`streaming_runs.resummarise_ui`, no new measurement); `ui_latency.csv` was unchanged.
  - **Guard fix.** The full unit suite caught `ablation.py` calling `dataset._issue_test_token` directly
    (`test_model_dataset.py::test_only_evaluate_issues_test_tokens`). The test split is now opened only through
    `evaluate.evaluate_test`, and the guard is unchanged. A non-RECORD rerun of the fixed code reproduced the
    recorded `ablation_paired.csv` and `.png` and all six score files byte for byte
    (`data/ablation/full_20261114T121522Z`).
  - **Infra.** `docker-compose.yml` api gains `API_UI_LATENCY_CSV` (default `results/ui_latency.csv`, unchanged),
    and `make api-up` gains `UI_LATENCY_CSV=`.
  - **Tests.** New: `test_ablation.py`, `test_oracle_dev.py`, `test_experiments_runner.py`,
    `test_streaming_runs.py`. Extended: `test_demo.py`, `test_latency.py`, `test_latency_bench.py`,
    `test_makefile_api.py`, `test_model_test_summary.py`. New gated `web/e2e/latency.spec.ts`.
- Step 17 (2026-11-14): clone-and-run for others (#42). **Done.**
  - **Why.** A fresh clone could not run a demo: there was no `make demo`, `models/` is gitignored (the stream job and
    the API need a deployment model), and the sample Spark steps ran on the host (Java 17 needed).
  - **`make demo`** = `demo-pipeline` + `demo-replay`. It needs `make up` and `make sample-data`, and no credentials,
    HDFS or host Java.
    - The sample ETL, features (counts to `data/demo/<run>/`; `features.build.check_results_dir` now also accepts
      `./data/demo/<run>`), the sample deployment model and the tyre model all run in the app container.
    - Then only the api is recreated (`make api-up REPLAY=1 MODEL_DIR=...`).
    - `f1sa.demo_replay` (new, stdlib) checks health (model version, synthetic lake), the race, starts a 60x replay
      and waits for 20 cars in Redis (`DEMO_WAIT=finished` also waits for the end). It prints the dashboard URL
      with SYNTHETIC DEMO DATA.
  - **Sample deployment model** (`model/deploy.py --source sample`, user decision: built at demo time, nothing
    committed).
    - It writes `models/undercut/sample_deploy_real_G3.5_k2/`, never `deploy_*`, and never `results/`.
    - Metadata: `source: sample`, `smoke_test: true`, a SMOKE TEST stamp.
    - The development comparison is skipped and recorded as skipped. The round trip and the scorer-vs-Spark check
      still run: MATCH, max diff 0.
    - The full path is unchanged (`--source full` default, same target and checks).
  - **API.** `API_MODEL_DIR` reaches the replay's stream job (`replay.stream_job_argv(model_dir=...)`), so
    `/api/health` and the replay use the same model. Compose default unchanged (`deploy_real_G3.5_k2`).
  - **Fresh-clone fixes.**
    - `api-dirs` also creates `models/undercut` and `models/sim`, which Docker would otherwise create as root.
    - Without a `.env`, the Makefile exports `APP_UID=$(id -u)`. With one (this machine), nothing changes.
    - Compose images `f1sa-{app,web}:${F1SA_IMAGE_TAG:-dev}`.
  - **CI** (`.github/workflows/ci.yml`): three parallel jobs, each ≤ 30 min, with the uv and npm caches.
    - `python`: ruff (now also `experiments scripts`), format, mypy (+ `scripts/check_traceability.py`),
      traceability, unit tests.
    - `web`: unchanged.
    - New `e2e`: free disk, `make up`, `make sample-data`, `make demo DEMO_WAIT=finished`, a `results/`-unchanged
      check, `npx playwright install --with-deps chromium`, the smoke test against the web container, logs on
      failure, `make down`.
    - `tests/integration` stays out of CI (documented).
  - **`scripts/check_traceability.py`** (+ `make lint`/`typecheck`).
    - It found two stale matrix entries, both fixed in the matrix:
      - `lake/writer.py` never existed (git log empty). The writers are `ingest/sinks.py` and
        `etl/io.write_partitioned`.
      - `results/calibration.*` became `results/calibration_*.csv` and `results/reliability_*.png`.
    - Now OK 227, GENERATED 5 (gitignored outputs), PENDING 2 (S18 `docs/report/`, `docs/demo_script.md`), MISSING 0.
  - **Docs.**
    - README rewritten: purpose, mermaid architecture, quickstart for WSL 2 and Linux/macOS, full-data mode, the
      experiment table, key results copied from model_results.md / experiments.md and the committed
      `results/whatif_consistency.csv` (the 2025 what-if row is in no doc), limitations, licensing, team, course.
    - New `docs/reproduce.md` (sample and full mode, every target that writes `results/` and whether it refuses,
      tests and CI, clean-up) and `CITATION.cff`.
    - `docs/architecture.md` reviewed: the "skeleton" note, the diagram (TracingInsights, LR + GBT), the module table
      (no lake writers), API model mount, image tag/UID, and a "Demo and CI" section.
    - `DATA_LICENSES.md`: models, demo and CI.
  - **On the dev stack** (user approved; api recreated, then restored by `make up-full`):
    - `make demo` took 110 s, and the Playwright smoke passed (1.9 min).
    - sha256 of `data/lake` + `models/` before and after: 501 files identical, 3 changed, 76 removed, 126 added.
      - All 19 rewritten lake tables have identical content checksums (row count + xxhash64): only part-file names
        changed.
      - The changed files are `clean/_quality/report.json` (+ `.crc`: `generated_at`, and `clean_root`/`raw_root`
        now `/workspace/...`) and `models/sim/tyre_model_sample.json` (`created_utc`, `git_sha`).
      - Added: the 50 files of `sample_deploy_real_G3.5_k2`.
    - `data/manifest*.json` byte-identical; nothing under `/f1/` touched.
  - **Clean-clone check** (user approved).
    - `make down` (volumes kept), then a GitHub clone at `df48f66` + the Step 17 patch (26 files) in
      `/tmp/f1sa-clone`, project `f1sa-clone`, tag `:clone`, no `.env`.
    - Times: build `--no-cache` 224 s + `make up` 26 s + `make sample-data` 4 s + `make demo` 103 s = **357 s**
      (target 15 min).
    - The Playwright smoke passed (1.8 min), and `results/` was unchanged in the clone.
    - Clone containers and `:clone` images removed; volume `f1sa-clone_kafka-data` left (no volume deletion).
    - `make up-full`: all 11 services healthy, api back on `deploy_real_G3.5_k2` with replay off.
  - **Tests.**
    - New: `test_demo_replay.py`, `test_makefile_demo.py`, `test_check_traceability.py`, `test_ci_workflow.py`,
      `test_repo_docs.py`.
    - Extended: `test_model_deploy.py` (sample source), `test_api_replay.py`, `test_api_config.py`,
      `test_features_build.py`.
    - Updated for the intended changes: `test_makefile_api.py` and `test_makefile_web.py` (image tag, mkdir line).
    - Full unit suite: 1688 passed. `make web-test`: 152 passed.
- Step 17 follow-up (2026-11-15): real tyre compound in the full-mode live replay. **Done.**
  - **Problem.** In full mode every car showed `Unknown`. The producer took `compound` from
    `df_jobs.tyre_age` over the v1 clean `stints`, which are `jolpica_inferred` (compound null).
  - **Investigation.**
    - The shared rule only carries `tyre_compound` / `tyre_age_laps`. The 21 live inputs, the scorer and the
      alerts never read the compound. `tyre_age` is used (the x-axis of the three degradation slopes), so it is
      unchanged.
    - The live what-if reads the TracingInsights stint starts first in full mode. Redis and the race channel are
      fallbacks only, so its compound is unchanged.
    - The what-if backtest (`sim/backtest.py`) builds its states from `laps_enriched` and the TI stint starts,
      not from the producer. The stream parity run calls `producer.race_inputs` directly.
  - **Change** (`streaming/producer.py`, `streaming/parity.py`; nothing in `sim/`, `features/` or `model/`).
    - `resolve_compound`, in order:
      1. the `stints_tracinginsights` stint in progress, i.e. the largest `start_lap <= lap`, using
         `sim.whatif.stint_starts` (never `end_lap`, conflict gives no compound);
      2. the v1 stint's compound;
      3. null, which Redis writes as `UNKNOWN`.
    - `normalise_compound` maps names to the five that the dashboard renders.
    - Synthetic v1 stints ignore TI, so sample mode stays synthetic. A missing TI table gives a warning and the
      v1 stints.
    - The producer prints the share per source. `LapRecord.compound_source` is new.
    - The parity runner passes `stints_tracinginsights`, so it replays this path.
    - The Redis contract is unchanged.
  - **Evidence.**
    - Sample 2024 R5 with the deployed model: 113 new_candidate, 19 probability_crossed and 9 attempt
      alerts (141 in total), as before the change. The dump of every alert, all 409 decisions and all 1113
      events (without `event_id`) is byte-identical to the pre-change run.
    - Stream parity 2021-2024 (the `stream-parity-full` command with `--out data/demo/parity_check/...`): 90
      races, 157 labelled attempts, 34,608 eligible pairs and 0 mismatching races. The CSV is byte-identical to
      `results/stream_parity_full.csv` (sha256 aad8df67…).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0. The sample what-if CSV and PNG are
      byte-identical to the 2026-11-14 runs.
    - Full mode, 2024 R1: the compound is known on 1129 of 1129 laps (100%, all TracingInsights). In
      `make stream-demo FULL=1 SEASON=2024 ROUND=1 SPEED=60`, all 20 hashes held real compounds after the
      leader's lap 30. At the session end there were 14 HARD and 6 SOFT.
  - **Tests.**
    - `test_producer.py` covers normalisation, the pit boundary (the in-lap keeps the old compound, the out-lap
      gets the new one), that no later stint is used, the unknown cases, the source precedence, coverage, TI in
      `race_inputs` and the synthetic guard.
    - `test_stream_parity.py::test_tracinginsights_compound_changes_no_model_input` checks that events differ
      only in `compound`, and that decisions, alerts and Redis fields (except `tyre_compound`) are identical.
    - `test_redis_sink.py` checks the compound in the hash and on the channel.
    - Full unit suite: 1704 passed.
  - There was no "Unknown in full mode" entry under Known issues to remove; the gap was not recorded before.
  - Rebuilt `f1sa-app:dev` (`docker compose build app`, user approved). Recreated only the five containers
    using it (api, app, spark-master, spark-worker-1, spark-worker-2) with `up -d --no-deps --no-build`. The
    baked `/opt/venv` copy now has the change, and all 11 services are healthy. No volume was touched.
- Step 17 follow-up 2 (2026-11-15): real tyre life on the dashboard (display only). **Done.**
  - **Problem.** In full mode the Age column showed the Jolpica-inferred stint age, which assumes every stint
    starts on a new set.
  - **Investigation.**
    - Readers of the event `tyre_age` / hash `tyre_age_laps`:
      - live features: the x-axis of the degradation slopes (kept as it is);
      - the `live_state` snapshot and the detector (carried, never scored);
      - `RedisSink`;
      - the what-if fallbacks after the TI stint;
      - API `/state`, the what-if route and `lap_log`;
      - the web reducer, tower and tyre panel;
      - `latency_bench`.
    - TyreLife = laps on the set including earlier use (1 on the first lap of a new set). The clean
      `tyre_age_at_start` = that value − 1. `tyre_age_at_start + lap − start_lap + 1` equals the raw per-lap
      value on 1129/1129 laps of 2024 R1.
    - Used sets: 419 / 246 / 339 / 263 stints in 2021-2024.
    - `decode_state` rejects any 10th hash field.
  - **Redis (user approved 2026-11-15).** A new, additive, display-only HASH
    `race:{s}:{r}:tyre:{driverId}` (`tyre_life_laps`, `tyre_life_at_start_laps`, `lap`, `updated_at`).
    - It is queued in the batch's one pipeline. It gets the safety TTL and the `session_end` EXPIRE, because it
      matches `race:{s}:{r}:*`.
    - The 9-field driver hash, the zset and the channel are unchanged.
    - Documented in the key contract of `docs/architecture.md`.
  - **Change.**
    - The producer has `ti_tyre_life_at`: the TI stint in progress, never `end_lap`; null when the start life
      is unknown or the race is synthetic.
    - `RaceEvent` gets two last fields, `tyre_life_laps` and `tyre_life_at_start_laps`
      (`events.DISPLAY_FIELDS`).
    - `RedisSink` writes the tyre hash for the latest lap per car (an older lap never overwrites it) and adds
      the fields to the lap payload. `WriteRecord.n_tyres` is new.
    - `redis_store` has `TyreLife`, `encode/decode_tyre`, `Batch.tyres` and `get_tyre`.
    - The API adds `RaceStateOut.tyres` (optional; a malformed hash is skipped). The what-if uses `drivers`
      only.
    - Web: `lib/tyre.ts`, `components/TyreAge.tsx`, and the reducer fields. The Age column and the tyre panel
      show the real life with a `used` tag, or the inferred age with `est.` (text plus a screen-reader
      sentence, no colour coding). Sample mode shows its synthetic age as `est.`.
  - **Evidence.**
    - Sample 2024 R5 alert check: 113 / 19 / 9. All 141 alerts and 409 decisions are byte-identical to the dump
      before the change. The 1113 events are identical except the two new fields (null in sample mode).
    - Stream parity 2021-2024 (`--out data/demo/parity_check2/`): 90 races, 157 labelled attempts, 0
      mismatches, byte-identical to `results/stream_parity_full.csv` (sha256 aad8df67…).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0. The what-if CSV and PNG are
      byte-identical.
    - Full replay of 2024 R1 at 60x:
      - Tyre life is known on 1129 of 1129 laps; 145 laps are on a used set.
      - After the leader's lap 10, the nine cars that started on a used SOFT show real 12–13 against inferred
        9–10 (at_start 3). At lap 44 hulkenberg shows real 4 against inferred 3 (at_start 1). After lap 30 all
        20 cars are on new HARD sets (real = inferred).
      - 41 race keys. The tyre and driver hashes have TTL 21600 before `session_end` and 3593 after it.
    - **Latency** (2024 R1, FULL=1, 60x; two runs before, two after; `stream_batches.jsonl` and
      `streaming_latency.csv`):
      - commands per batch: 50 → 63 (+1 HSET + 1 EXPIRE per lap event, about 6.6 tyre hashes per batch);
      - `write_ms` p50: 1.20 / 1.18 → 1.32 / 1.32 ms;
      - `write_ms` p95: 1.56 / 1.58 → 1.83 / 1.91 ms;
      - `write_ms` p99: 2.57 / 1.94 → 2.35 / 2.26 ms;
      - `end_to_end_ms` p50: 705 / 712 → 703 / 710 ms, and p95 1300 / 1263 → 1298 / 1290 ms.
      - About +0.13 ms per batch at the median, well inside the noise of the end-to-end numbers.
      - One `execute()` per batch (test_tyre_writes_share_the_batch_pipeline).
  - **Tests.**
    - Python: `test_producer` (pit boundaries, used sets, no later stints, nulls, synthetic guard),
      `test_events`, `test_keys`, `test_redis_store` (fields, TTL, session_end expire, one pipeline, key
      validation, async), `test_redis_sink`, `test_stream_parity` (events differ only in `DISPLAY_FIELDS`;
      decisions, alerts and the 9 fields identical), `test_api_state` (tyres map, malformed skipped) and
      `test_api_whatif` (a tyre hash never changes a what-if).
    - Vitest: `tests/tyre.test.ts` (view, parsing, reducer newest-lap rule, reload, rendering).
    - Full unit suite: 1741 passed. Web: lint and typecheck clean, 161 Vitest tests passed.
  - Resolved the known issue "the tyre age shown next to a real compound is assumed-new".
  - **Services** (user approved).
    - Rebuilt `f1sa-app:dev` (be37257d283d) and `f1sa-web:dev` (dd94baedc24b).
    - Recreated only their containers: app, spark-master, spark-worker-1/2 and web with `--no-deps
      --no-build`, and the api with `make api-up REPLAY=1` (sample) for the smoke.
    - The Playwright smoke (`E2E_NO_SERVER=1 npx playwright test e2e/smoke.spec.ts`, against the web
      container) **passed** in 20.8 s.
    - The live `/state` returns `tyres` for 20 cars (null life in sample mode), and the driver hashes keep
      the 9 fields.
    - After the smoke's replay finished, the api was restored with `make api-up FULL=1 REPLAY=1`.
    - All 11 services are healthy: health ok (redis, kafka, model). Volumes were not touched.
- Step 17 follow-up 3 (2026-11-15): self-explanatory dashboard markers (web only). **Done.**
  - **Problem.** Viewers could not tell what these meant: the yellow left bar and ▲, the Undercut % and its
    "—", Age with `used` / `est.`, Int / Gap, "+1 L", the alert badges and %, and the what-if rows.
  - **Change.** No data, API, model, Python or Redis change.
    - `web/src/lib/legend.ts`: one glossary (`GLOSSARY`) is the only source of every explanation, so the
      legend and the tooltips cannot disagree. The wording follows the shared undercut rule, the alert
      triggers (threshold 50% = the deployed `decision_threshold`) and `lib/tyre.ts`.
    - `components/Legend.tsx`: "How to read this", a native `<details>` above the timing tower, collapsed by
      default and keyboard-operable without script. Grouped tower / alerts / what-if; the yellow bar is shown
      next to its text.
    - `components/InfoTip.tsx`: a "?" `<button>` named "About …".
      - Its text is an always-present `role="tooltip"` linked with `aria-describedby`.
      - It shows on hover, on keyboard focus or after a click/tap. Escape hides it (also when it was shown by
        hover or focus). Blur closes a click-opened one.
      - Hidden tips use `display: none`, so the 375 px no-scroll check holds. Width is clamped to the
        viewport.
    - Timing tower: tips on the Pos (flag), Driver (+n L, IN PIT), Int, Gap, Age and Undercut headers.
      - Per-row markers keep their visible text and a screen-reader sentence ("Undercut opportunity on the car
        ahead", "not a candidate", "undercut success probability").
      - They point to the header tip with `aria-describedby`, so a column has one tab stop, not 20.
    - Alerts: a short visible key under the heading ("Opportunity new candidate or ≥ 50%", "Attempt attacker
      pitted", "% = success probability"), each with a tip. Badges and percentages are described by them.
    - What-if: one line ("The rows compare three pit strategies with a race simulator; the model probability
      below them is the stream's calibrated outcome estimate.").
    - Tyre panel: its own Age tip, "About tyre age", so no two tips share an accessible name. The smoke
      caught the duplicate "About Age".
  - **Tests.**
    - `web/tests/legend.test.ts` (10, `renderToStaticMarkup`):
      - the glossary;
      - InfoTip markup and its accessible name and description;
      - the legend's entries and groups;
      - the tower's header tips;
      - that the row markers reference them;
      - the alert key;
      - the what-if line;
      - unique ids and names, with every `aria-describedby` resolving, across the dashboard.
    - `e2e/smoke.spec.ts` now:
      - opens the legend by keyboard and checks three explanations;
      - focuses "About Undercut" (the tooltip shows; the accessible description matches);
      - Escape hides it, and Enter opens it again with `aria-expanded="true"`;
      - checks that six more tip buttons have descriptions.
    - Web lint and typecheck clean; Vitest 171 passed.
  - **Services** (user approved).
    - Rebuilt `f1sa-web:dev` (0f7a3bed7ee0) and recreated only `web`.
    - The api was recreated in sample mode (`make api-up REPLAY=1`) for the smoke. The Playwright smoke
      (`E2E_NO_SERVER=1 npx playwright test e2e/smoke.spec.ts`) passed in 1.6 min.
    - The api was then restored with `make api-up FULL=1 REPLAY=1`. All 11 services are healthy and volumes
      were not touched.
- Step 17 follow-up 4 (2026-11-15): Fix D, "1 unknown drivers" in the dashboard footer. **Done.**
  - **Evidence** (SSE recorded with `curl -N` and folded through the real `raceReducer`; scratchpad harness):
    - 2024 R1, full mode, 60x, subscribed before the replay with no race keys: footer "1341 events applied ·
      0 malformed · 1 unknown drivers". The one unknown is frame #1: `lap`, leclerc, lap 1, P2. It came after
      an empty `snapshot-0` (0 drivers, 0 order) and just before `snapshot-1`.
    - `snapshot-1` held only leclerc's hash plus the full order zset (20). The zset created the other 19 rows,
      so every later event was known.
    - 2024 R5 behaved the same way: 1 unknown, `lap` russell lap 1 P6.
    - A mid-race connect of 2024 R1 showed 0: the connect snapshot already listed 20 drivers.
    - **Cause:** `api/sse.py` sent the per-lap snapshot after the first lap frame of the lap. On a race without
      keys at connect, that frame always reached the browser before any snapshot listing its car.
    - The driver was never missing from Redis: the sink writes hashes and order before its PUBLISH in one
      pipeline.
  - **Fix** (API stream only; no reducer, streaming, Redis-contract or model change; the counter is kept).
    - The per-lap snapshot is now read and sent **before** the lap frame that starts its lap.
    - `sse_sent_at_ms` is stamped right before each frame is sent.
    - A snapshot SCANs again while the previous one found no driver, so a fresh race's lap-1 snapshot holds
      all 20 hashes, not 1.
  - **Proof.**
    - Stream parity 2021-2024 (`--out data/demo/parity_check3/`): byte-identical to
      `results/stream_parity_full.csv` (sha256 aad8df67…; 90 races, 157 labelled, 0 mismatches).
    - Sample 2024 R5 alert check: 113 / 19 / 9, and the dump is byte-identical to the previous one.
    - After the fix (api recreated with `make api-up FULL=1 REPLAY=1`, and the race keys deleted first, user
      approved), the browser footer read "0 unknown drivers" on both races: "1341 events applied · 0
      malformed · 0 unknown drivers" (2024 R1) and "1251 … · 0 unknown drivers" (2024 R5). The harness agrees.
  - **Latency** (`docs/experiments.md`, "Change after Step 16"): the lap's first frame went from Redis → SSE
    send p50 2 → 5 ms, and the other lap frames gained 0–1 ms at p50 and about +3 ms at p95 (one subscriber,
    same races). The committed latency results are unchanged.
  - **Tests.**
    - `test_api_events.py`: a fresh race never sends an event before a snapshot that lists its car, and the
      lap-1 snapshot holds every hash. The order expectations of two tests were updated.
    - `web/tests/reducer.test.ts`: the new order gives 0, the old order gives 1 (the artefact), and genuinely
      unknown ids (lap, pit, alert) still increment, once each.
    - Full Python suite 1742 passed; web lint and typecheck clean, Vitest 174 passed.
- Step 17 follow-up 5 (2026-11-15): Fix C, every recording path refuses to overwrite `results/`. **Done.**
  - **Audit** (full table in `docs/reproduce.md` §3; all 154 files in `results/` are git-tracked):
    - Two RECORD paths overwrote committed files silently: `make stream-demo RECORD=1` (the Step 12
      `streaming_latency.csv`, `stream_{progress,batches}.jsonl`) and `make experiments-spark RECORD=1`
      (`scalability.csv`, `scalability_{build,telemetry}.png`, `partitioning.csv`,
      `partitioning_speedup.png`).
    - `make bench-replot RECORD=1` also overwrote its plot.
    - `make api-up DEBUG=1` appended to the committed `results/ui_latency.csv` by default.
    - The deterministic generators (features-*, model-eval-sample, model-dev-*, report-full, etl-ti-full,
      stream-parity-full, model-test-summary) rewrite their files by design and `make experiments` checks
      their bytes. They are left as they are (user decision) and listed.
  - **Change.**
    - New `src/f1sa/recording.py`, the one guard:
      - `check` refuses before any work, naming the files and how to proceed;
      - `backup` moves files to `data/results_backup/<UTC stamp>/`. It never deletes and refuses an
        existing folder;
      - a small CLI for Makefile-side checks.
    - `stream-demo RECORD=1`: refused before any process starts. With `OVERWRITE=1` the files are backed up
      before the run, because its stream job writes into `results/` while running.
    - `experiments-spark RECORD=1`:
      - `python -m f1sa.bench.host check-record` covers all five files before the grid, and each script
        checks again at its start;
      - `OVERWRITE=1` backs up only right before the complete run writes, so an interrupted run leaves
        `results/` intact. The resume command carries `OVERWRITE=1`;
      - **RESUME of the same run** may rewrite only the files whose last README fingerprint section is that
        run's (`fingerprinted_file`). Because the 2026-11-14 supplement merged into `scalability.csv` after
        the original grid, `RESUME=bench_20261113T152740Z RECORD=1` is now refused for scalability, so it
        cannot drop the merged rows. Its partitioning files still count as its own.
    - `bench-supplement` keeps its own merge guard and ignores `OVERWRITE`.
    - `bench-replot RECORD=1` refuses unless `OVERWRITE=1`, with a backup first.
    - The streaming suite, the UI run and `redis-latency` keep refusing (now through the shared helper) and
      gained `OVERWRITE=1`.
    - The pre-registered recordings (`model-test-full`, `ablation-full`, `oracle-dev-full`,
      `whatif-consistency-full`) stay refuse-only, without `OVERWRITE`.
    - UI latency: the default is `data/demo/ui_latency/ui_latency.csv` (config, Makefile, compose,
      `.env.example`). With `DEBUG=1`, `make api-up` checks an explicit `results/` CSV before recreating the
      container (`OVERWRITE=1` backs it up), and `LatencyRecorder` refuses at api start-up.
  - **Evidence.** No recording was run.
    - `sha256sum results/*` (154 files) is identical before and after, and `git status results/` is clean.
    - Dry runs:
      - `make -n stream-demo … RECORD=1 OVERWRITE=1` gives `--record --overwrite`;
      - `make -n experiments-spark RECORD=1` runs `check-record` first;
      - `make -n bench-supplement … OVERWRITE=1` has no `--overwrite`.
    - Against the real `results/`:
      - `python -m f1sa.bench.host check-record --run-id bench_20991231T000000Z` refuses both scripts (exit 2);
      - with `--overwrite` it passes and says 5 files would be moved;
      - `python -m f1sa.recording check results/stream*` refuses (exit 2);
      - `experiments/streaming_latency.py --record` refuses before starting anything.
  - **Tests.**
    - New `tests/unit/test_record_guard.py` (15), in temp directories only:
      - the helper and the CLI;
      - stream-demo refusal (nothing run, nothing written) and its overwrite backup;
      - scalability and partitioning refusal (no cell run, no run folder) and overwrite only when complete;
      - an interrupted overwrite leaves results intact;
      - resume of the same run, and a later supplement making the run lose ownership;
      - `check-record`, replot, suite, `redis-latency` and the api recorder.
    - Updated: `test_demo_outputs` (RECORD=1 now refuses; OVERWRITE=1 records with a backup),
      `test_makefile_{api,bench,stream}`, `test_api_config` and `test_repo_docs`.
    - The bench-supplement and RESUME tests pass unchanged.
    - Full unit suite: 1759 passed.
- Step 17 follow-up 6 (2026-11-15): Fix E, deployment model re-saved from a clean tree. **Done.**
  - **Why.** `models/undercut/deploy_real_G3.5_k2/{lr,gbt}/metadata.json` recorded `git_dirty: true` and
    `git_sha 36c369b` from the Step 9c save. There is no top-level `metadata.json`.
  - **How.**
    - The tree was clean at `b8eb0a9` (checked right before the save).
    - The whole folder (50 files) was copied first to `data/model_backup/deploy_real_G3.5_k2_20261115T102348Z/` (gitignored), and its manifest was checked
      equal to the original.
    - `make model-save-full FORCE=1` (1 min 33 s) passed `F1SA_GIT_DIRTY=false`. It read only the
      `season=2021..2024` feature partitions (8 partition lines, no 2025).
    - The reproduction check MATCHED the committed development results on all 10 checks:
      - LR: Platt a 1.5444072248837364, b −0.7114782477332869; Brier 0.168438, PR-AUC 0.593775;
      - GBT: Brier 0.205233, PR-AUC 0.560198.
  - **What changed** (28 files, `.crc` checksums aside):
    - **Byte-identical (15):** `lr/scorer.json` (sha256 0a9b7dfb…), `lr/calibrator.json`,
      `gbt/calibrator.json`, `reproduction.json`, and all `_SUCCESS` markers.
    - **Different bytes, same model (13):**
      - `{lr,gbt}/metadata.json`: only `created_utc`, `git_sha` (→ b8eb0a9) and `git_dirty` (→ false);
      - the Spark `metadata/part-*.txt` files: only `timestamp`, `uid` and the uid-derived defaults
        (`defaultParamMap.outputCol` = `<uid>__output`, overridden by the set `features_raw` / `features`; the
        GBT default `seed`, a hash of the uid, overridden by the set seed 42);
      - the parquet weight files (LR coefficients, StandardScaler, GBT nodes) have identical rows; only their
        bytes and the stage-uid folder names differ;
      - the GBT `treesMetadata`: tree ids and weights identical. The per-tree metadata JSON differs only in
        `timestamp`, `uid` and the default seed.
    - **Functional check (Spark, old vs new):**
      - LR: 52 coefficients and the intercept (−0.21097365184916145) identical; scaler mean and std identical;
      - GBT: all 50 trees (`toDebugString` without the uid line) and their weights identical;
      - every explicitly set param identical.
  - **Checks.**
    - The api was recreated (`make api-up FULL=1 REPLAY=1`, user approved). `/api/health` now shows `git_dirty`
      false, `git_sha` b8eb0a9…, the same `scorer_sha256` 0a9b7dfb… and `created_utc` 2026-11-15T10:25:25Z.
    - The sample 2024 R5 alert check with the re-saved folder gives 113 / 19 / 9. The dump of all alerts,
      decisions and events is byte-identical.
    - `results/` is byte-identical (154 files); nothing in `models/` or `data/` is tracked.
  - **Incident.** The api recreate stopped a 1x replay of 2024 R3 that was running (started 09:43:56, about
    half the race, batch 592). The pre-check printed it, but I did not stop on it.
    - Its outputs stay in `data/demo/2024_3_20261115T094356.761Z/`, and its Redis keys keep the 6 h safety TTL.
    - It has no `session_end`, and a new replay of 2024 R3 starts over.
  - The backup can be removed once you no longer need it. It restores with `cp -a` back to
    `models/undercut/deploy_real_G3.5_k2/`.
- Feature 1 (2026-11-15): per-race entrants, team names and team colours (display only). **Done.**
  - **Investigation** (read-only; HDFS only through HttpFS GET):
    - The clean `drivers`, `results` and `constructors` tables are per race: 114 races, 2,278 entrants, 0 nulls,
      0 duplicate keys. `drivers.constructor_id` and `car_number` equal `results` on every row.
    - `drivers.permanent_number` is today's season-table number (Verstappen 3, Norris 1 in every season), so it is
      not used. The per-race `car_number` is.
    - Jolpica keeps one constructor name per id across seasons ("RB F1 Team" in 2024 and 2025), so the season
      display names come from a committed table.
    - TracingInsights `drivers.json` (raw, as received) has the team colour `tc` for 102 of 114 races.
      `drivers.parquet` drops it.
    - Every TI code maps to the race's `drivers.code`, and teammates always share one colour and one name.
    - Licence: TI/FOM data is never committed, so the committed fallback is a project-chosen palette (your
      choice).
  - **Change**:
    - `etl/entrants.py` writes `clean/entrants` and `clean/_quality/entrants.json` (`make entrants-sample`,
      `make entrants-full`; `make demo` runs it after the clean job).
    - `etl/entrants_reference.py` holds `TEAM_NAMES`, `PROJECT_PALETTE`, `NATIONALITY_CODES` and the badge text
      contrast rule. The schema is `lake/schemas_entrants.py` (outside `CLEAN_SCHEMAS`).
    - `colour_source` is `ti_race`, `ti_neighbour_round_<n>` or `project_palette`. The 12 neighbour-filled races
      are listed in `docs/data_dictionary.md`.
    - The job fails on:
      - an unmapped constructor, a Jolpica name mismatch or a missing constructors row;
      - an unmapped demonym, a malformed `tc` or teammates with different colours;
      - a team without any colour, or a duplicate key.
    - API: `GET /api/races/{s}/{r}/entrants` (`api/entrants.py`, `api/routes/entrants.py`).
      - It is read-only and limited to `clean/entrants`.
      - It returns 404 for an unknown race or a sealed 2025, 422 for bad parameters, 500 for a malformed row and
        503 when the lake is down.
      - The cache is Redis `meta:entrants:{s}:{r}` with `SET EX API_ENTRANTS_CACHE_S` (3600), outside
        `race:*`, so the driver hash is never touched. A Redis error falls back to the lake.
      - The API still imports no pyspark (tested).
    - Dashboard:
      - the tower has team badges (a text code on a swatch; the API picks the text colour, ≥ 4.5:1; outlined by
        the border token);
      - the real code and surname are shown;
      - the badge tooltip holds the team name and the teammate, and the teammate is also in screen-reader text;
      - a hovered row is outlined solidly and its teammate's row dashed;
      - a new Drivers view at `/race/{s}/{r}/drivers` (a table sorted by grid);
      - a "Team badge" glossary entry and tooltip;
      - the footer "Unofficial project; not associated with the Formula 1 companies.";
      - no logo files, `<img>` or `<svg>`.
  - **Cache fix found during the checks.**
    - The first version keyed the cache by race only.
    - After the api was switched from sample to full mode, it served the sample's palette colours for 2024 R5
      (confirmed live).
    - Entries now carry a lake fingerprint (16 hex digits of sha256 of the lake URI; the URI is never stored). An
      entry of another lake is a miss. Tested.
    - The running api still has the old code (see Known issues).
  - **Evidence.**
    - `make entrants-full`: 2,278 rows, 114 races. Of the team races, 1,020 are `ti_race` and 120 are
      neighbour-filled (exactly the 12 races of the data dictionary). TI rows unmapped: 0; team-name
      mismatches: 0.
    - `tests/integration/test_entrants_full.py`: 8 passed. It covers Bearman 2024 R2 / R17 / R21, Colapinto,
      Lawson, the Tsunoda/Lawson swap at 2025 R3, Colapinto at Alpine from 2025 R7, Hamilton at Ferrari in
      24/24, car numbers and the colour source of every race.
    - Stream parity 2021-2024 (`--out data/demo/parity_check4/`): 90 races, 157 labelled attempts, 34,608
      eligible pairs, 0 mismatching races. The CSV is byte-identical to `results/stream_parity_full.csv`
      (sha256 aad8df67…).
    - Sample 2024 R5 alert check: 113 / 19 / 9 (141 alerts, 409 eligible pairs). The dump is byte-identical
      to the Fix E dump (sha256 7eee6557…).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0. The sample what-if CSV and
      PNG are byte-identical to the previous run.
    - Python: the full unit suite gave 1822 passed and 1 failed: the exact-route list in `test_api_app.py`,
      which needed the new route and was updated. After the cache fix, `make test-api` gave 215 passed, and the
      entrants, keys and docs tests 111 passed. ruff and mypy are clean.
    - Web: lint and typecheck are clean; Vitest 198 passed.
    - `make web-e2e`: the smoke test passed. It covers the badges in the tower, the teammate outline on hover,
      the footer and the Drivers view (20 rows, RB and Kick Sauber, no img/svg, no horizontal scroll at
      375 px).
    - `results/` is unchanged (sha256 of every file before and after, and `git status results/` clean).
  - **Services** (user approved):
    - the api was recreated in sample mode for Playwright;
    - web was stopped for `make web-e2e`, then rebuilt and started;
    - the api was returned to `make api-up FULL=1 REPLAY=1`.
  - **Incident.**
    - The last api recreate stopped the smoke test's own 60x replay of sample 2024 R5 (started 16:44:46),
      which was still running after the test passed. The pre-check printed it, but my command chain did not
      stop on it.
    - Its partial outputs stay in `data/demo/2024_5_20261115T164446.116Z/`.
    - Its 41 Redis `race:2024:5:*` keys have no `session_end` and expire with the 6 h safety TTL.
    - No orphan process is left.
- Feature 1 follow-up (2026-11-15): `make api-up` refuses to cut off a running replay. **Done.**
  - The api was recreated (`make api-up FULL=1 REPLAY=1`, user approved) after a check that exits non-zero on
    a running replay; none was running. The entrants cache fix is live: 2024 R5 now gives `ti_race`, and the
    sample-mode entry was replaced by a lake-tagged one.
  - New `src/f1sa/replay_guard.py` (stdlib only), the first line of `api-up`. It refuses with exit 2 while
    `GET /api/replays` lists a running replay (naming each one), and with exit 3 when the answer cannot be
    read. `FORCE=1` overrides both. An unreachable api passes.
  - `make demo` / `demo-replay` use the same target.
  - `make up` and `make up-full` run the same guard before `compose up -d --build`, which recreates the api
    when its image or configuration changed. FORCE=1 overrides it. An unreachable api (a stack that is down)
    passes. The Makefile has one `REPLAY_GUARD` variable for all three targets.
  - The tests cover all three targets: a real `make up` / `up-full` / `api-up` against a fake api with a running
    replay stops at the guard (compose never runs), plus a dry-run order and FORCE check per target, and the CLI
    passing for an unreachable api.
  - Tests: `tests/unit/test_replay_guard.py`:
    - the decision;
    - real local HTTP servers (answering, closed port, HTTP 500, timeout);
    - the Makefile order (the guard runs before the UI-latency backup and the recreate);
    - FORCE only with 1;
    - a real `make api-up` against a fake api with a running replay: it stops at the guard, and the
      recreate never runs (`COMPOSE` replaced, so nothing real could be touched).
  - **Dependency-free** (follow-up): the Makefile runs the guard as `python3 -I src/f1sa/replay_guard.py` with
    the system `python3`, so `make up` on a fresh clone needs no uv.
    - The module imports only the standard library and nothing from `f1sa`. It is 3.8-safe: tuple
      `isinstance` checks, and `collections.abc` only under `TYPE_CHECKING`.
    - Behaviour, exit codes (0 / 2 / 3), `FORCE=1` and `python -m f1sa.replay_guard` are unchanged.
    - Checked live with Python 3.14.4 (system) and 3.12.16 under `env -i PATH=/usr/bin:/bin` (no uv).
    - New tests:
      - the imports are stdlib-only (AST against `sys.stdlib_module_names`), and no sibling module shadows
        one;
      - the script runs with the system `python3` and no uv on PATH (exit 0 / 0 / 2 / 0 forced / 3);
      - every recreating target's guard line is `python3 -I …`, never `uv`;
      - the real `make up` / `up-full` / `api-up` refusal runs with a system-only PATH and `UV=false`.
    - README prerequisites: `python3` (3.8 or newer) is listed for `make up`. `uv` stays, because
      `make sample-data` runs `uv run` on the host.
- Feature 2 (2026-11-16): "Race analysis" tab for finished races (display only). **Done.**
  - **Investigation** (read-only; HDFS only through HttpFS GET, copies in the scratchpad):
    - The v1 clean `laps` are Jolpica only. Sector times, speed traps, the per-lap track-status codes, deleted
      laps and the real per-lap tyre life exist only in the raw TI `laps.parquet` (the TI clean job keeps 12 of 42
      columns). Coverage per season is in `docs/data_dictionary.md` ("Race-analysis tables"): lap time ≥ 99.7%,
      S2/S3 ≥ 99.6%, S1 ~98% (lap 1 has none), speed trap ST ≥ 99.7%, compound and tyre life ≥ 97.8%.
    - Race control is in the lake for all 114 races (lap known on 99.98% of messages); no FastF1 data anywhere.
    - The sample has no TracingInsights: its tyres are the synthetic v1 stints (shown, labelled SYNTHETIC: your
      choice), and it has no sectors, deleted laps or race control.
  - **Change**:
    - `etl/analysis.py` (`--source sample|lake`; `make analysis-sample`, `make analysis-full`; `make demo` runs it
      after the entrants) writes `clean/analysis_{race,laps,stints,pitstops,race_control}` and
      `clean/_quality/analysis.json`. Schemas in `lake/schemas_analysis.py` (outside both clean schema lists).
      - Rows are the Jolpica laps with TI left-joined (no fan-out, checked); neutralised from the per-lap TI
        track-status codes (heuristic fallback); deleted unknown (null) without TI; quick laps with one stored
        exclusion reason (lap 1, pit in/out, SC/VSC/red, deleted, > 107% of the stint's fastest: your choice).
      - Stint fits with Spark SQL `regr_slope`/`regr_intercept`; race-control `kind` with a Spark SQL CASE;
        per-season coverage counts with RDD `reduceByKey`.
    - API: `GET /api/races/{s}/{r}/analysis/{laps,stints,pitstops,race-control,positions}` and `…/compare?a=&b=`
      (`api/analysis.py`, `api/routes/analysis.py`). Read-only reader limited to the analysis tables and
      `entrants`; 404 no analysis / sealed 2025, 422, 500, 503 as the other routes. Cache `meta:analysis:{s}:{r}:{view}`
      (`SET EX API_ANALYSIS_CACHE_S`, lake fingerprint, outside `race:*`; compare has no key). The key contract has the
      additive line. The API still imports no pyspark.
    - Dashboard `/race/{s}/{r}/analysis` ("Race analysis" in the race page's nav): WAI-ARIA tabs for tyre
      strategy, lap times, tyre degradation (labelled "a lap-time proxy, not tyre wear", excluded laps listed),
      positions (team colours + dashes + code/full-name labels), compare (lap delta, cumulative gap, sector
      totals), pit stops and race control (key events, lap links). Hand-written SVG (`lib/plot.ts`; `useWidth`
      shared from `lib/useWidth.ts`), each chart with a title, a description, a text summary and a table behind
      "Show table". Compound colour tokens in `lib/theme.ts` (≥ 3:1, bar text ≥ 4.5:1), always with a letter,
      name or glyph. A glossary group `analysis` (shown only on the tab; `Legend` takes `groups`).
  - **Evidence.**
    - `make analysis-full`: 114 races; 124,834 laps (= the Jolpica counts per season), 6,421 stints (5,196 fitted,
      1,200 too few quick laps, 25 without tyre life), 4,161 pit stops, 10,191 race-control messages. Tyre and
      neutralised source TI / track status in all 114 races. TI rows unmapped 0; TI-only laps dropped 221 (the lap
      reconciliation count). Track-status cross-check: 463 leader laps flagged by both, 0 by only one source.
    - `tests/integration/test_analysis_full.py`: 5 passed (every stored row of every race validates against the
      API models; 2024 R5 SC laps 22–31 from track status with race control VSC 22 → SC 23 → SC in 26 → SC 27 →
      SC in 31; 2021 R12 one lap, 40 uncompleted laps dropped, no pit stops).
    - Stream parity 2021-2024 (`--out data/demo/parity_check5`): 90 races, 157 labelled attempts, 34,608 eligible
      pairs, 0 mismatching races; byte-identical to `results/stream_parity_full.csv` (sha256 aad8df67…).
    - Sample 2024 R5 alert check: 113 / 19 / 9 (141 alerts, 409 eligible pairs); the dump is byte-identical to the
      Feature 1 dump (sha256 7eee6557…).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0; the what-if CSV and PNG are
      byte-identical to the Feature 1 run.
    - Web: lint and typecheck clean; Vitest 223 passed; `next build` clean; `make web-e2e` passed (opens the tab
      from the race page, arrow keys/End across tabs, 20 strategy rows and the SYNTHETIC note, compare summary,
      race-control empty state, a pit-stop lap link marks the lap, no horizontal scroll at 375 px).
    - Python: the full unit suite gave 1928 passed in 771 s (once, after all changes); targeted: `test_analysis.py`
      23, `test_api_analysis.py` 36, keys/app/config/entrants 123, Makefile 42. ruff, format and mypy clean.
    - `results/` is unchanged (sha256 of all 154 files before and after; `git status results/` clean).
  - **Services** (user approved): api recreated in sample mode (REPLAY=1) for Playwright, web stopped for
    `make web-e2e` and rebuilt/started with `--no-deps`; after the smoke test's own replay had finished, the api
    was returned to `make api-up FULL=1 REPLAY=1`.
- Feature 3 (2026-11-16): "Engineer view" for a live (replayed) race (display only). **Done.**
  - **Known issue fixed first:** the gap chart's SVG `<title>` is a single template string (React 19 rendered the
    multi-part one empty); `web/tests/gapchart.test.ts` checks the text.
  - **Investigation** (read-only): Redis holds only the latest driver/tyre hashes (no lap field) and the order;
    `undercut_prob` is the attacker's value against the car then directly ahead at its latest decision lap (about one
    lap behind); per-lap history exists only in the API's lap log (last 30 laps, fed from the race channel); track
    status reaches the stream but is dropped from the Redis payload; the lake has exact per-lap track-status codes
    and race-control messages in full mode only (the sample's flags are a hindsight heuristic); the pit-loss prior is
    `features/pit_loss`; no typical-stint table exists.
  - **Change** (your choices: lake codes + causal fallback; per-lap probabilities in the lap log; typical stint at
    this circuit, else all circuits; race pit-loss prior only):
    - `GET /api/races/{s}/{r}/engineer/{driverId}?lap=N` (`api/engineer.py`, `api/routes/engineer.py`), from laps
      <= N only: cards for the car ahead, the focus and the car behind (position by race time at lap N, compound,
      real or estimated tyre life and delta, stint vs the typical stint, last-3-lap pace and delta, the stream's
      probability), pairs (gap, gap trend after the latest pit lap of either car, sparkline points, the rear car's
      probability with `pair_matches`), a pit-rejoin estimate (the race pit-loss prior with its source text, e.g.
      "circuit prior from earlier races"; unreliable under SC/VSC/red flag, without a prior or with projected cars),
      the track status at lap N, and the strategy calls (7 display rules, listed in `docs/architecture.md`).
      Read only (no Redis key written; tested); 404 / 409 / 422 / 503 and the 2025 seal as the other routes.
    - Lap log (additive; `records()` for the what-if unchanged): the real tyre life per lap, and the published
      probabilities of every driver hash per leader lap (read only).
    - Dashboard: "Race | Engineer" tabs on the live page (the race view stays mounted); `EngineerPanel` with the
      focus picker (lock per browser, guarded `localStorage`), three cards with team badges and a teammate tag, gap
      sparklines, the rejoin bar, the calls labelled "display rules, not model output" with one live region for new
      calls only, and an `engineer` glossary group. The rejoin glossary entry and `docs/architecture.md` say that the
      what-if panel additionally adjusts for the driver's expected stop and out-lap, so the two estimates can differ
      slightly. Styles use only the shared tokens.
  - **Found live and fixed:** in the sample replay the car behind had just pitted, so its gap trend mixed laps from
    before and after the stop (+5.07 s/lap), and the threat call fired although the stream's value referred to
    another car. The trend now starts after the latest pit lap of either car, and the threat rule also needs the
    pair to match (tests added). The Playwright run before this fix checked the layout only.
  - **Evidence.**
    - Full lake (read-only): 2024 Las Vegas uses the 2023 Las Vegas stints (circuit prior 25.7 s); 2024 China and
      2023 Las Vegas have no earlier race at the circuit, so both stints and pit loss fall back to all circuits. The
      first call reads every race's circuit in 2.6 s; later calls are cached.
    - Stream parity 2021-2024 (`--out data/demo/parity_check6`): 90 races, 157 labelled attempts, 0 mismatching
      races; byte-identical to `results/stream_parity_full.csv` (sha256 aad8df67…).
    - Sample 2024 R5 alert check: 113 / 19 / 9 (141 alerts, 409 pairs); the dump's sha256 is the recorded
      7eee6557… (the scratchpad had been cleared, so the script was recreated and compared by hash).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0; the what-if CSV and PNG are
      byte-identical to the earlier runs.
    - Python: the full unit suite gave 1960 passed in 792 s (once, after all changes); targeted:
      `test_engineer.py` 20, `test_api_engineer.py` 8, lap log / app / what-if / analysis / entrants 127. ruff,
      format and mypy clean; `results/` unchanged (sha256 of all 154 files before and after).
    - Web: lint and typecheck clean; Vitest 238 passed; `next build` clean; `make web-e2e` passed (the Engineer
      tab by keyboard during the 60x replay, a focus driver, three cards, calls, the pit loss with its source, a lap
      update, no overflow at 375 px, the lock kept after a reload).
  - **Services** (user approved): the api was recreated in sample mode (REPLAY=1) for Playwright, web was stopped
    for `make web-e2e` and rebuilt with `--no-deps`, and after the smoke test's own replay had finished the api was
    returned to `make api-up FULL=1 REPLAY=1` (it now runs the fixed code).
- Feature 4 (2026-11-16): post-race viewer, any finished race scrubbed lap by lap (display only). **Done.**
  - **Investigation.** A live replay's states, alerts and probabilities all come from
    `StreamProcessor.process_rows` (the `foreachBatch` function) writing through `RedisSink` to any `Store`. The
    parity harness already feeds the producer's events to it without a broker. The archive does the same with the
    **real** `RaceStore` on an in-process stand-in (`archive/memory_redis.py`), so the frozen encoder writes every hash
    field and published message; each snapshot is read back with the API's `read_race_state`. Nothing is re-derived.
    The 113 / 19 / 9 alert check is sample 2024 R5 with `deploy_real_G3.5_k2`; its script was never committed.
  - **Your choices:** the lap-N snapshot is the **end of lap N**; the live proof is a controlled real replay; `make
    demo` builds the sample archive; the lake path is `archive/race_bundle/season=S/round=R/`.
  - **Change** (new package `src/f1sa/archive/`):
    - `replay.py`: the producer's events (`build_events`), one Kafka row each (`parity.kafka_batches`), cut into one
      micro-batch per leader lap. Derived uuid4-format ids and one simulated clock (race start + 180 s + race time)
      make a rebuild byte-identical; the rule, features, scorer and alert policy read neither.
    - `schema.py` (schema v1, pydantic only): meta (race, model version, scorer sha256, model and builder git sha),
      entrants, per-lap snapshots (the 9 driver-hash fields, order, tyre hash), every published message with its SSE
      id, every scored decision, the leader's track status and race control. gzip `mtime=0`, sorted keys, no NaN.
    - `build.py` (`python -m f1sa.archive.build --source sample|lake`; `make archive-sample`, `make archive-full`):
      writes only `{lake}/archive/race_bundle/season=S/round=R/{bundle.json.gz,_manifest.json}` (`FileSink` under
      `./data/lake`, or `HdfsSink` through HttpFS); never raw, clean, features or `results/`; 2025 only with
      `--allow-test-season`; missing prerequisites give exit 1 with the make target. `make demo-pipeline` builds the
      sample archive with the sample model after the model step.
    - `equivalence.py` (`make archive-equivalence SEASON ROUND LAPS [FULL=1]`): rebuild check, parity-harness run plus
      `check_alerts` / `compare_race`, and the controlled live replay (real Kafka → stream job → Redis; Redis read
      after every lap/pit message sent up to each checked lap, and after `session_end`). It refuses while an api
      replay runs. Outputs `data/checkpoints/demo_*` and `data/demo/<run_id>/` (`make demo-clean` removes them).
    - API: `GET /api/archive` and `GET /api/archive/{s}/{r}` (`api/archive.py`, `api/routes/archive.py`;
      `catalog.archive_reader`: zone `archive`, two file names, LISTSTATUS/OPEN only, 2025 sealed). Stored gzip with
      `Content-Encoding: gzip` (else JSON), `ETag` = sha256, `Cache-Control: no-cache`, 304; 404 / 422 / 500 (sha or
      schema) / 503. The listing is cached in process (`API_ARCHIVE_CACHE_S`); no Redis key. Still no pyspark.
    - Dashboard: a "Live | Post-race (archive)" tab pair on the race page (only the selected mode is mounted, so
      post-race opens no SSE). The URL holds `?mode=archive&lap=N`. `lib/archive.ts` drives the **unchanged** reducer
      (lap messages, then the snapshot); `PostRaceView` reuses the tower (caption names the archive), gap chart, tyre
      panel and alert feed (silent), adds a race-control list up to lap N and links to the analysis tab with lap N
      marked. `ArchiveControls`: a native range slider (`aria-valuetext` "Lap N of M"), −1 / Play-Pause / +1, and
      client-side 1×/10×/60× playback (one leader lap time per lap ÷ speed). The markers (P, SC, VSC, R, N
      estimated, A announced alerts) are one toolbar with text codes, border styles and full accessible names. An
      `archive` glossary group. Styles use only the shared tokens. `TimingTower` gained an optional caption note
      (default unchanged).
  - **Evidence.**
    - Sample: `make archive-sample` gave 2023 R5 at 1,417,039 B JSON → 139,465 B gzip and 2024 R5 at 1,257,110 →
      123,092 B. A rebuild is byte-identical (`sha256sum -c`: both OK).
    - `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`:
      - rebuild identical;
      - alerts 113 / 19 / 9 (141) and 409 decisions, equal to the parity run, with 409 batch-eligible pairs; the
        labelled attempt is included; `check_alerts` and `compare_race` OK;
      - live: Redis == bundle at laps 5, 22, 45 and after `session_end`; all 1,252 published messages equal.
      - Verdict: EQUIVALENT.
    - Full lake: `make archive-full ARCHIVE_SEASON=2024 ARCHIVE_ROUND=1` gave 1,298,084 B → 133,877 B. `make
      archive-equivalence FULL=1 SEASON=2024 ROUND=1 LAPS=10,30,50`:
      - rebuild identical;
      - 93 / 13 / 19 (125) alerts and 405 decisions, equal to parity; 7 labelled attempts;
      - Redis == bundle at laps 10, 30, 50 and the final lap 57; all 1,341 messages equal.
      - Verdict: EQUIVALENT.
    - `make archive-full` (every 2021-2024 race; 2025 sealed): 90 bundles, 0 failed. 116,508,466 B JSON → 11,790,654 B
      gzip (11.3 MB on HDFS, replication 1). Per race min 4,898 B (2021 R12, 1 lap), median 130,041 B, max 167,818 B
      (2023 R13, 72 laps). 2024 R1 rebuilt to the same sha256 (d07a36eb…) as the single-race build. Only
      `/f1/archive/race_bundle/` was written. The full-mode api serves all 90 over HttpFS (2024 R1: 200 gzip, ETag
      = sha256).
    - Stream parity 2021-2024 (`--out data/demo/parity_check7/`): 90 races, 157 labelled attempts, 34,608 eligible
      pairs, 0 mismatching races; byte-identical to `results/stream_parity_full.csv` (sha256 aad8df67…).
    - Sample 2024 R5 alert check (recreated: deployed model, parity harness at batch 7 with partition 1 lagging):
      113 / 19 / 9 = 141 alerts, 409 decisions, `check_alerts` OK. The old dump (sha256 7eee6557…) could not be
      compared because its format was never recorded. `git diff` is empty for `src/f1sa/{streaming,serving,features,
      model,sim,etl}` and `results/`.
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0. The 2 NEW files (the sample
      what-if CSV and PNG, no committed file) are byte-identical to the Feature 2 / 3 runs. `results/` equals HEAD
      with nothing untracked.
    - Python: the full unit suite gave 2037 passed in 891 s (once, after all changes). Targeted: archive, API,
      Makefile, docs and config 354 passed. ruff, format and mypy clean. `scripts/check_traceability.py`: OK 304,
      MISSING 0. `tests/integration/test_archive_live.py` was not run; `make archive-equivalence` (above) ran the same
      check in the app container.
    - Web: lint and typecheck clean; Vitest 265 passed (27 new); `next build` clean. `make web-e2e`: 2 passed (the
      existing 60x smoke test and the new post-race test: keyboard mode switch, slider steps with
      `aria-valuetext`, ±1 buttons, a marker jump, the toolbar End key, 60x playback, reload keeps mode and lap, no
      overflow at 375 px, back to Live).
  - **Services** (user approved): the api was recreated in sample mode (REPLAY=1) for Playwright. web was stopped for
    `make web-e2e`, then rebuilt and started with `--no-deps`. After the smoke test's replay finished, the api
    returned to `make api-up FULL=1 REPLAY=1`. A Docker/WSL restart afterwards (not caused by this step) left the
    stack down.
- Feature 5 (2026-11-18): timing-tower extras for the live and post-race views (display only). **Done.**
  - **Investigation** (read-only):
    - Sector times and speed traps exist only in TracingInsights (`clean/analysis_laps`; S1 about 98%, S2/S3
      and ST at least 99.6% per season). The sample has none.
    - The producer's events, Redis and the lap log carried no sectors. Pit counts came only from the
      reducer's `pit_in` count since connecting, which is wrong after a reload.
    - The lap event's `track_neutral` is the batch heuristic (hindsight), so the banner does not use it.
      Feature 3's `lake_neutral` / `estimated_neutral` are causal.
    - Archive v1 had no sectors, no timing in its snapshots and no causal status.
  - **Transport** (your choice): display-only lap-event fields plus an **additive** Redis hash
    `race:{s}:{r}:timing:{driverId}` (key contract line approved 2026-11-18).
    - The 9-field hash, the order zset, the channel and the tyre hash are unchanged.
    - `RaceState.apply` copies only the model's fields into `LapInput`, so no rule, live feature, scorer,
      `state.json` or alert reads the new fields.
    - The producer computes the running values from each driver's own laps <= L, so the sink stays
      stateless (the `tyre_lives` pattern).
    - The banner is a read-only API route that reuses the engineer's function.
  - **Change**:
    - `streaming/events.py`: `TOWER_FIELDS` (sectors, speed trap, the driver's bests so far, `pit_stops`) are
      lap-only and in `DISPLAY_FIELDS`.
    - `streaming/producer.py`: the optional `clean/analysis_laps` source and `running_timing`. Deleted laps
      count, because a deletion is decided later.
    - `streaming/parity.py` loads `analysis_laps` too.
    - `serving/keys.py` `TIMING_FIELDS` / `timing_key`; `serving/redis_store.py` `TimingRow`,
      `encode_timing` / `decode_timing`, `Batch.timings` (same pipeline, safety TTL, `session_end` EXPIRE);
      `streaming/redis_sink.py` `timing_rows` and the payload fields.
    - API: `RaceStateOut.timing` (`/state` and the SSE snapshot; a malformed hash is skipped).
    - New `GET /api/races/{s}/{r}/status?lap=N` (`api/race_status.py`, `api/routes/status.py`):
      `engineer.neutral_at`, laps <= N; 409 for a lap not reached yet; no key written.
    - Archive **schema v2**: `snapshots[].timing` and `status[]`, from the same `race_status` over a `LapLog`
      fed the bundle's own messages. The reader accepts v1 and v2; the equivalence compares timing.
    - Dashboard:
      - S1 / S2 / S3, Trap and Pits columns with "PB" / "OB" text tags (`--ok` / `--line-4`) and a "Best so
        far" line;
      - a pin per row (`aria-pressed`, one car, kept per browser, scrolled into view only while the tower is
        on screen);
      - a "Columns" disclosure with Minimal / Full / Custom and per-column checkboxes, kept per browser;
      - the race-status banner (GREEN / SC / VSC / RED FLAG / SC / VSC est. / UNKNOWN, the latest key message
        and its lap, the source), with a polite live region only on a status change (silent post-race);
      - a `tower` glossary group; shared tokens only.
  - **Evidence.**
    - Stream parity 2021-2024 (`--out data/demo/parity_check8/stream_parity_full.csv`, with `analysis_laps`
      loaded): 90 races, 157 labelled attempts, 34,608 eligible pairs, 0 mismatching races. `cmp` with
      `results/stream_parity_full.csv`: identical (sha256 aad8df67…).
    - Sample 2024 R5 alert check (deployed model, parity harness at batch 7 with partition 1 lagging):
      113 / 19 / 9 = 141 alerts, 409 decisions, `check_alerts` and `compare_race` OK.
      - The alerts-and-decisions dump has sha256 e0689163…, identical to the same script run on HEAD's
        `src/` (exported with `git archive`).
    - Redis cost (sample 2024 R5, app container, real Redis db 15 only, cleaned after; 3 alternating runs each):
      - commands per batch: 62.2 → 75.1;
      - `write_batch` p50: 1.18 → 1.35 ms; p95: 1.56 → 1.68 ms.
    - Sample archive v2 (`make archive-sample`, approved):
      - 2023 R5: 1,883,740 B JSON → 148,931 B gzip; 2024 R5: 1,700,600 → 132,069 B (v1 was 139,465 / 123,092 B).
        Messages, alerts and decisions are unchanged (1,395 / 216 / 567 and 1,252 / 141 / 409).
      - A second rebuild is byte-identical (`sha256sum -c` OK).
      - 2024 R5 status, estimated from lap times: neutralised on laps 21-31.
    - `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`: **EQUIVALENT**.
      - Rebuild identical; 113 / 19 / 9 and 409 decisions equal to the parity run.
      - Live Redis == bundle, timing hash included, at laps 5, 22, 45 and after `session_end`; all 1,252
        messages equal.
    - Full archive v2 (`make archive-full`, approved):
      - 90 bundles, 0 failed, in 3 min 20 s; 161,067,831 B JSON → 15,755,709 B gzip (v1: 11,790,654 B). Per
        race min 5,742 B, median 173,902 B, max 225,053 B. Only `/f1/archive/race_bundle/` was written.
      - 2024 R1: 1,793,542 → 177,471 B, 125 alerts, 405 decisions.
      - 2024 R5 status from track status: VSC on lap 22, then SC on laps 23-31, with the lap-26 "SAFETY CAR IN
        THIS LAP" and the lap-27 redeployment as the messages; green from lap 32.
      - 2024 R1 is green throughout, its PBs are monotone for every car, and 20 cars have sectors.
    - `make archive-equivalence FULL=1 SEASON=2024 ROUND=1 LAPS=10,30,50`: **EQUIVALENT**.
      - Rebuild identical; 93 / 13 / 19 (125) alerts, 405 decisions and 7 labelled attempts equal to the parity
        run.
      - Live Redis == bundle at laps 10, 30, 50 and the final lap 57.
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0. The 2 NEW what-if files are
      byte-identical to the Feature 4 run.
    - Python: the full unit suite gave **2105 passed** in 972 s (once, after all code changes). Targeted runs:
      events / keys / store / sink 174; producer 42; parity (tower and TI) 2; race status 10; state / app 33;
      archive 70 + 3; engineer / docs / Makefile / traceability 105. ruff, format and mypy are clean;
      `scripts/check_traceability.py`: OK 304, MISSING 0.
    - Web: lint and typecheck clean; Vitest **300 passed** (35 new: `tower.test.ts`, `status.test.ts`, archive
      v2). `make web-e2e`: 2 passed (the latency spec is skipped by design).
      - The live smoke checks the S1 / S2 / S3 / Trap / Pits / Pin headers, the "no sector data" note, numeric
        pit counts, and the banner labelled "estimated".
      - It also checks the Minimal preset by keyboard (S1 hidden, Escape returns focus), one pin with
        `aria-pressed`, both kept after a reload, and no overflow at 375 px.
      - The post-race smoke checks the v2 banner at laps 1 and 21 and the pit counts.
      - The first `web-e2e` run failed in the post-race test: the banner's parts ran together ("Lap 1not
        enough laps…") for screen readers too. Hidden ". " separators were added (Vitest checks them) and the
        rerun passed.
    - `results/` is unchanged (sha256 of all 154 files before and after; `git status results/` clean).
  - **Services** (user approved):
    - the api was recreated in sample mode (`make api-up REPLAY=1`) for Playwright;
    - web was stopped for `make web-e2e`, then rebuilt and started with `--no-deps`;
    - after the smoke test's replays had finished, the api was returned to `make api-up FULL=1 REPLAY=1`.
      It now serves `/status`, timing in `/state` and the 90 v2 bundles.
    - The equivalence live replays wrote their races' Redis keys (sample 2024 R5 in db 0, full 2024 R1; 1 h
      after `session_end`).
- Feature 6 (2026-11-18): telemetry lap overlay for 2024 races, Race analysis tab "Telemetry" (display only). **Done.**
  - **Investigation** (read-only, HttpFS LISTSTATUS/OPEN streamed into memory; nothing downloaded or saved):
    - The kept raw telemetry is `raw/tracinginsights/telemetry/season=2024/round=R/driver=CODE/` (Parquet +
      manifest): 1.94 GB, 956 files, 24 rounds, 478 driver-races, 18,998,812 samples in 26,606 lap files (= the TI
      2024 lap rows). Channels: speed, RPM, gear, throttle, brake (bool), DRS (0/1, binarised by TI), distance, rel.
      distance, x/y/z, accelerations, car ahead, time in lap, session time.
    - About 7.7 Hz (median Δt 0.129 s). One file per lap; distance restarts at about 0 every lap (TI integrates
      it; lap ends differ by up to about 16 m). The maximum time in lap equals the TI lap time from lap 2 on; lap 1
      starts at the grid slot. Details and the table are in `docs/data_dictionary.md` ("Telemetry traces").
  - **Change** (additive; no streaming, serving store, feature, model, sim or archive file changed):
    - `etl/telemetry_trace.py` (`make telemetry-trace-full`, app container; `--seasons` accepts 2024 only) and
      `etl/telemetry_resample.py` (pure numpy, `applyInPandas` per driver-lap) write only `clean/telemetry_trace`
      (`partitionBy(season, round, driver_code)`, zstd) and its `_quality.json`; `output_path` refuses anything
      else. Schema: `lake/schemas_telemetry_trace.py`, outside every other table list.
      - One row per lap: 5 m distance grid (plus the finish point) arrays for distance, elapsed time, speed,
        throttle, RPM (linear), brake, gear, DRS (held), and a summary (top speed and where, slowest braking-zone
        apex, full-throttle / brake / DRS distance shares, braking zones, coverage at the Step 4C thresholds).
      - `driver_id` comes from `analysis_laps`, else the race's clean `drivers.code`. **Found on the first full
        run:** mapping through `analysis_laps` only dropped 13 lap files of drivers without a completed Jolpica lap
        (lap-1 retirements, e.g. Monaco HUL, MAG, OCO, PER). They now map through `drivers`; a code mapped to two
        ids fails the job (tested).
    - Sample mode: `make telemetry-trace-sample` writes a SYNTHETIC 2024 R5 fixture (`ingest/synthetic_telemetry.py`,
      seeded, scaled to the sample's real lap times) under `data/lake/fixtures/` and builds the table with
      `is_synthetic = true`. Tests and Playwright only; `make demo` does not run it (tested).
    - API (`api/telemetry.py`, `api/routes/telemetry.py`): `GET /api/races/{s}/{r}/telemetry/laps?driver=CODE`
      and `…/telemetry/compare?a=&alap=&b=&blap=`. Any season but 2024 is **404 "telemetry traces are available for
      2024 only"**, checked before Redis or the lake. Other errors: 404 race, driver or lap; 422; 500; 503, as the
      other routes. Cache `meta:telemetry:{s}:{r}:laps:{CODE}` and `…:trace:{CODE}:{lap}` (`SET EX
      API_TELEMETRY_CACHE_S`, lake fingerprint, outside `race:*`); compare has no key. The new catalog method
      `read_driver_rows` opens only `clean/telemetry_trace/…/driver_code=XXX/` (LISTSTATUS/OPEN). The key contract has
      the additive line. The API still imports no pyspark.
    - Delta time: both laps on A's grid, B read at the same fraction of its own lap (TI lap lengths differ by up
      to about 0.3%, so equal metres would move the finish line); `delta = elapsed A − elapsed B`, positive = A
      behind; 25 mini-sectors whose changes add up to the delta's change (telescoping, tested).
    - Dashboard: an eighth "Telemetry" tab (`TelemetryView.tsx`, `lib/telemetry.ts`, `lib/useTelemetry.ts`):
      - driver + lap pickers for A and B (fastest clean lap by default, marked "(fastest)"; URL `ta/talap/tb/tblap`);
      - seven stacked lanes on one distance axis, A solid and B dashed in team colours with a halo, brake and DRS as
        one row per car;
      - one crosshair (`role="slider"`; pointer, arrows 5 m, Shift 50 m, Page 250 m, Home/End) with a readout table
        of every channel and the delta;
      - a text summary (lap times, top speeds, slowest corner, full throttle, where A gains and loses, the line),
        a mini-sector table, notes (SYNTHETIC, gaps, pit lap, lap 1), and a `telemetry` glossary group;
      - other seasons show the 2024-only note and send no request. Shared theme tokens only.
  - **Evidence.**
    - `make telemetry-trace-full` (4 min 41 s): 24 races, **26,604 laps** of 476 driver-races; 2 laps without a
      trace (GAS R12 and STR R21 lap 1: speed and distance 0 in every sample); unmapped 0; 30 rows without lap
      info; coverage full 26,570 / partial 34; 405,419 samples moved forward (in 4,600 laps); **209,217,336 B**
      on HDFS (replication 1, about 0.48 MB per driver partition). `/f1/raw` before and after: 2,024,360,565 B and
      3,542 files. Only `/f1/clean/telemetry_trace` was written.
    - Real data through the API (in-process, read-only): 2024 R5 VER lap 33 (1:38.406) vs NOR lap 33 (1:38.751):
      final delta −0.345 s = the lap-time delta; 1,080 points, 101 KB; cached compare 10 ms. 2023 and 2025: the
      2024-only 404.
    - Stream parity 2021-2024 (`--out data/demo/parity_check9/stream_parity_full.csv`): 90 races, 157 labelled
      attempts, 34,608 eligible pairs, 0 mismatching races; `cmp` with `results/stream_parity_full.csv`:
      identical (sha256 aad8df67…).
    - Sample 2024 R5 alert check (the Feature 5 script): 113 / 19 / 9 = 141 alerts, 409 decisions, `check_alerts`
      and `compare_race` OK; dump sha256 e0689163…, identical to Feature 5.
    - `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`: **EQUIVALENT** (rebuild identical; 113 / 19 / 9
      and 409 decisions equal to parity; live Redis == bundle at laps 5, 22, 45 and after `session_end`; all
      1,252 messages equal). No bundle was rebuilt in the lake.
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0; the 2 NEW what-if files are
      byte-identical to the Feature 4 / 5 runs.
    - Python: the full unit suite gave **2209 passed** in 953 s (once, after all code changes; the doc tests were rerun
      after the last doc edits). Targeted: resample 19, job 18, synthetic fixture 8, compare maths 10, API 34,
      keys / app / Makefile 145+. ruff, format and mypy clean; `scripts/check_traceability.py`: OK 304, MISSING 0.
    - Web: lint and typecheck clean; Vitest **322 passed** (22 new in `telemetry.test.ts`; the tab-count, query
      and legend expectations updated for the eighth tab). `make web-e2e`: 3 passed, 1 skipped (latency, by design);
      the new test opens Telemetry by keyboard, checks both "(fastest)" defaults, the SYNTHETIC note, 7 lanes,
      ArrowRight / Shift+ArrowRight / End on the crosshair, a lap change in the URL, no overflow at 375 px, and
      2023 R5 showing the note with no telemetry request.
      - Visual check (screenshots, dark 1280 px and light 375 px) found the readout table inside the tower's
        tall wrapper and tick labels over the lines; fixed (own wrapper, right-margin ticks) and Playwright rerun.
    - `results/` is unchanged (sha256 of all 154 files before and after; `git status results/` clean).
  - **Services** (user approved): `make telemetry-trace-full` and the parity run in the app container; the
    sample archive equivalence (wrote the sample 2024 R5 Redis keys, TTL); the api recreated in sample mode
    (`make api-up REPLAY=1`) for Playwright, web stopped for `make web-e2e` and rebuilt with `--no-deps`; after the
    smoke test's replay the api returned to `make api-up FULL=1 REPLAY=1` (it now serves the telemetry routes).
- Feature 7 (2026-11-18): replay controls: stop, pause / resume and a speed change (1×/10×/60×) during an API
  replay, from the API and the dashboard. Only the pacing changes. **Done.**
  - **Investigation** (before the change):
    - Start and supervision (`api/replay.py`): `start()` refuses a second job of the race or above the cap (409) and
      makes `run_id` and `data/demo/<run_id>/`. The stream job starts in its own process group, then the producer
      once the ready file exists. The stream job stops after `session_end` (within 180 s of the producer's exit).
      States were starting / running / finished / failed. Every outcome ends with SIGTERM to each group, SIGKILL
      after 10 s and a group sweep.
    - Pacing (`producer.replay`): every event is built up front (ids included), then sent at
      `start + (t - t_first) / speed`, with one speed for the whole run.
    - When a run ends normally, `session_end` publishes and EXPIREs the race keys at 1 h. A failure sends no
      `session_end`, so the keys keep the 6 h safety TTL. Either way the checkpoint `data/checkpoints/api_<run_id>`
      (never reused) and `data/demo/<run_id>/` stay.
  - **Change:**
    - Producer:
      - `replay_controlled` re-reads `data/demo/<run_id>/replay_control.json` (`ReplayControl`, written atomically
        by the API) between sleeps of at most 0.1 s. It re-anchors the race clock where it stands, never past the
        next unsent event.
      - It writes `replay_progress.json` (the lap reached, events sent).
      - New flags `--control-file` and `--progress-file`; exit 4 when orphaned.
      - Without a control file the old `replay()` runs unchanged.
    - API:
      - `POST …/replay/{stop,pause,resume,speed}`: 200, 409 when the race has no active replay or it is stopping,
        422, 403 when disabled or for 2025, 500 when the control file cannot be written.
      - New states `paused` and `stopped`; `failed` keeps its name (your choice).
      - New fields: `paused`, `lap`, `events_sent`, `note`, `running_at`, `paused_at`, `updated_at`.
      - Stop uses the failure path's teardown, publishes no `session_end` and keeps the partial outputs.
      - Pause cap `API_REPLAY_MAX_PAUSE_S` (1800 s, total per run; past it the run is stopped with a note).
      - The stream job's backstop is now ready + 7200 s + the cap + end, whatever the speed.
      - The stream job writes `decisions.jsonl` (`--decisions-out`, an output only).
    - **Lifecycle rule (approved):** a replay start DELs `race:{s}:{r}:*` (`delete_race`), only after the slot checks
      and before any launch. A Redis error gives 503 with nothing registered. Recorded in the key contract of
      `docs/architecture.md`.
    - **Found live and fixed:** between a run's final state and `_finish`, while its processes were still being
      stopped, the job was in neither `running` nor `recent`, yet a new start already got 409 (pre-existing).
      `running` now lists every replay that holds a slot.
    - Dashboard (`ReplayControl.tsx`, `lib/replays.ts`, `useReplays.ts`):
      - Start, Pause/Resume and Stop buttons, and the speed radios, usable during a run.
      - A polite `role="status"` line gives the state and speed; the lap reached is shown, not announced.
      - A new run id resets the live stream (`trackRun`).
      - Shared tokens only.
      - **Found by Playwright and fixed:** the controlled speed radio snapped back to the API's speed until the
        next poll. It now shows the requested speed while the change is in flight.
    - Proof tool `streaming/control_check.py` (`make replay-control-check`, api container).
      - **Found live:** a 20 s pause let 4 messages through 1-10 s in. They were events sent before the pause and
        published while the stream job drained them; the lap reached did not move.
      - The check now requires that the producer sends nothing while paused (events sent and lap unchanged) and
        that the channel is quiet over the pause's second half.
  - **Evidence.**
    - `make replay-control-check SEASON=2024 ROUND=5 EXPECT_TRIGGERS=113,19,9 EXPECT_DECISIONS=409`:
      **EQUIVALENT** (sample lake, deployed model).
      - baseline 60×, switch (1× to 60× at lap 2), pause (20 s at lap 10) and restart (a fresh 60× run right
        after the stop) all have 1,030 lap, 40 / 40 pit, 141 alert (113 / 19 / 9) and 1 `session_end` messages;
      - their messages are identical without ids and timing fields, and so are the 409 decisions, the final Redis
        state (driver, tyre and timing hashes, order) and the 61 race keys;
      - pause: events sent 199 -> 199, lap 10 -> 10, messages 238 at 1 s, 10 s and 20 s;
      - stop at lap 15: state `stopped`, lap 15, no `session_end`, 6 replay processes seen and 0 left;
      - summary: `data/demo/control_check_20261118T122856Z.json`.
    - `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`: **EQUIVALENT** after the DEL change
      (rebuild identical, 113 / 19 / 9 and 409 decisions equal to parity; Redis == bundle at laps 5, 22, 45 and after
      `session_end`; every message equal).
    - Live error codes: 409 for stop, pause and resume with nothing running, 422 for speed 5, 403 for 2025.
    - Stream parity 2021-2024 (`--out data/demo/parity_check10/stream_parity_full.csv`): 90 races, 157 labelled
      attempts, 34,608 eligible pairs, 0 mismatching races; `cmp` with `results/stream_parity_full.csv`:
      identical (sha256 aad8df67…).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0. The 2 NEW what-if files are
      byte-identical to the Feature 6 run.
    - Python: the full unit suite (once, after all code changes) gave **2312 passed, 1 failed** in 915 s. The failure
      was `test_demo_outputs.py::test_api_replay_writes_only_under_data_demo`, a guard that the producer writes no
      file. It now writes the progress file the API passes, so the guard was tightened to the rule it protects:
      the control, progress and decisions paths are inside `data/demo/<run_id>/`, and the producer's only file
      write is `write_json_atomic`. That file then passed (6), as did the doc and traceability tests (17).
      Targeted (producer, API replay and controls, store, stream job, guard, demo,
      control check, Makefile, docs) 457 passed before the live fixes; the API, controls and checker tests were rerun
      after them. ruff, format and mypy clean. `scripts/check_traceability.py`: OK 320, MISSING 0.
    - Web: lint and typecheck clean; Vitest **336 passed** (14 new in `replays.test.ts`). `make web-e2e`: 4 passed,
      1 skipped (latency, by design). The new spec starts at 1×, switches to 60×, pauses by keyboard (the lap stays
      put for 4 s), resumes, stops by keyboard ("Stopped at lap N"; `/api/replays` shows `stopped`, none running).
    - `results/` is unchanged (`git status results/` clean).
  - **Services** (user approved):
    - the parity run in the app container;
    - the api recreated in sample mode (`make api-up REPLAY=1`), and a second time to load the status fix;
    - the control check and the archive equivalence (they wrote the sample 2024 R5 Redis keys, `data/demo/` and
      `data/checkpoints/`);
    - web stopped for `make web-e2e`, then rebuilt and recreated with `--no-deps`;
    - the api returned to `make api-up FULL=1 REPLAY=1`.
- F37 fix (2026-11-18): the live order after opening or reconnecting mid-lap. **Done.** It was a client reducer
  bug, not a data bug.
  - **Cause.** The snapshot set no lap on a row. `liveOrder` therefore ranked only cars whose lap frame arrived
    on this connection, and every car that crossed before the page opened sank to the bottom. The design
    review's lap-10 capture showed PIA/LEC/RUS/SAI at P17-P20 with +15-18 s gaps.
  - **Investigation (scratch, not committed).**
    - A 10× replay of 2024 R5 (full lake) was recorded: 1,308 SSE frames and 2,323 Redis probes.
    - Redis is consistent: a client connected from the start matched the zset after 446 of 446 batches.
    - The HEAD reducer, opened at each probe, disagreed with that client in 1,279 of 2,323 openings.
  - **Fix** (`web/src/lib/reducer.ts` only; `applySnapshot` and `liveOrder` stay pure):
    - `DriverRow.snapshotRank` is the car's index in the latest snapshot zset, when that snapshot holds the car's
      latest crossing.
    - The snapshot gives each car its latest lap from the timing hash (else the tyre hash). It overwrites a
      row's lap only when that lap is newer than the one the page saw. An older or equal lap never overwrites,
      and no hash keeps the previous fallback.
    - `liveOrder` ranks by laps completed (desc) first. Within one lap, crossings the snapshot holds come first
      in zset order, and crossings that arrived later follow by crossing time.
    - This differs from the first proposal (a snapshot-only lap first, by crossing time). That proposal broke a
      reconnect: a car timed before the drop fell behind a car that only the snapshot knew. It also put KMAG/HAM
      at P1/P2 while a lap-1 snapshot arrived before their frames.
    - No change to the Redis contract, the API, the stream job or any Python file.
  - **Tests** (Vitest 336 -> 348):
    - `reducer.test.ts`, the "opening mid-lap (F37)" cases:
      - the exact F37 tower (PIA/LEC/RUS/SAI P5-P8, no gap inversion);
      - the tyre-hash lap;
      - a lapped car;
      - an older or equal snapshot lap;
      - no hash;
      - a leader-lap snapshot before its frames;
      - purity (deep-frozen state).
    - `reducer.test.ts`, a reconnect test.
    - `web/tests/f37.test.ts` with `web/tests/fixtures/f37_2024_5.json` (41,772 B), cut from the recording:
      - The fixture holds only the fields the ordering needs. Every kept number equals the committed sample
        Jolpica 2024 R5 laps. Compound, tyre, sector, speed-trap and undercut fields are dropped or
        neutralised.
      - It holds the exact F37 opening (the order equals the recorded zset after each batch) and lap 1 from the
        start.
    - 9 of the new tests fail on HEAD's reducer.
  - **Evidence.**
    - Web: lint and typecheck clean; Vitest **348 passed**; `archive.test.ts` 34 passed.
    - The scratch harness on the real fixed reducer gives:
      - relative order: 0 of 2,323 openings disagree with the reference client;
      - zset after each batch: 0 of 2,323 openings disagree, and the reference matches it 446 of 446 times.
      - Strict full-list equality: 1 of 2,323. That page opened when Redis held 17 cars, and for 2 frames
        (0 ms) it lacked HAM/KMAG, whose first frames had not arrived yet.
    - `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`: **EQUIVALENT** (sample api).
      - Rebuild identical.
      - Alerts 113 / 19 / 9 = 141, and 409 decisions equal to parity.
      - `check_alerts` and `compare_race` OK.
      - Redis == bundle at laps 5, 22 and 45 and after `session_end`; every message equal.
    - The R5 alert check is taken from this output (the Feature 5 alert script is not in the repo).
    - `make experiments-sample`: OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0. The 2 NEW files are the
      what-if consistency outputs in `data/whatif/`.
    - `results/` byte-identical: `git status results/` clean, `results/stream_parity_full.csv` sha256
      aad8df67….
    - The full 90-race stream-parity rerun was skipped on purpose: no stream-job, API or Python file changed.
  - **Services:**
    - the api was recreated in sample mode (`make api-up REPLAY=1`) for the archive equivalence, which wrote the
      sample 2024 R5 Redis keys, `data/demo/` and `data/checkpoints/`;
    - the api then returned to `make api-up FULL=1 REPLAY=1`.
  - **Cleanup:** the aborted run `data/demo/2024_5_20261118T171728.726Z` was deleted (it stopped after lap 1).
    `data/demo/` is gitignored.
  - **Critique:**
    - F37 is marked fixed;
    - new **F38 (P2)**: mark cars still on the previous lap, so cross-lap gap inversions read correctly.
- UI redesign Step 2 (2026-11-18, branch `redesign/ui` from `5e50881`; not committed, awaiting approval).
  Display only: no change to the reducer logic, the SSE contract, the stream job, the API, Python, the Redis
  contract or `results/`.
  - **Part A:** `docs/design/inventory.md`, one row per screen and state (data, source, findings F01–F38).
    Four findings need an additive server/API change for a full fix (F09 alert history, F10 smoke flag, F23
    summary after a late join, F24 causal gap history); none was made.
  - **Part B:** `docs/design/DESIGN.md` and the tokens in `web/src/lib/theme.ts` (the single source):
    - OKLCH colours with derived hex fallbacks;
    - dark by default with a Dark/Light/Auto switch, applied before the first paint;
    - one signal amber, blue/orange gain/loss;
    - type, space, radii, elevation and motion tokens.
    - Fonts are self-hosted with `next/font/local` in `web/src/fonts/`: Barlow Semi Condensed, Barlow and IBM
      Plex Mono, Latin subset, 8 files, each family's `OFL.txt`.
    - Contrast: 178 of 178 pairs pass AA (`web/scripts/contrast-report.mjs`, `web/tests/theme.test.ts`).
    - The dataviz validator passes the chart lines in both themes. The signal set passes in light; in dark it
      fails only the lightness band, on purpose (text-bearing colours). Tyre compounds fail by convention and
      always carry a glyph and a letter.
  - **Part C:** the live race view, rebuilt.
    - The status strip: mode, SMOKE TEST, lap, track status, model id, connection, the replay drawer.
    - "The call": the flagged pair, the model estimate with its model id and the base rate, the gap against
      pit loss gauge, the reasons, Simulate.
    - The alert feed, including the late-join list of the pairs flagged now.
    - The tower: every column at 1440 px, Undercut next to the driver, the L-tag for cars on the previous lap,
      one Key, FLIP moves.
    - The what-if as a modelled comparison, plus the mobile layout.
    - Critique items fixed in this view: F01, F02, F03, F05, F06, F07, F09 (client side), F10 (prefix rule), F11,
      F12, F13, F14, F15, F16, F17, F18, F19, F22, F24 (axis), F25, F26, F27, F28, F29, F30, F31, F33, F34, F38.
  - **Tests:**
    - Vitest 348 -> 454. New: `call.test.ts`, the theme tests, the what-if wording tests. DOM-only selector
      updates in `legend`, `tower`, `gapchart` and `theme`.
    - The `next/font/local` stub is aliased in `vitest.config.ts`.
    - New Playwright spec `web/e2e/race-layout.spec.ts`. The smoke, replay-controls and latency specs got
      selector-only updates.
    - `make web-e2e` (sample mode): 7 passed, 1 skipped (latency, by design).
  - Screenshots in `docs/design/after/` (6 files, each under 400 KB).
  - **Services** (user approved):
    - the web container was stopped while testing, then restarted with its original image (it does not
      contain the redesign);
    - 10× and 60× replays of 2024 R5 were run;
    - the api ran in sample mode (with the real model, then the sample model) and was restored to
      `make api-up FULL=1 REPLAY=1`.
  - **Follow-up decisions (2026-11-19):**
    - **F24:** the gap chart says "History from when you opened the page (from lap N)". The window's laps
      before that are a hatched band labelled "Before you opened the page, not received", and there is an
      honest empty state. It is live only (a `live` prop); the archive is unchanged.
    - **Violet:** checked against the other series (all pairs, CVD) and the 35 team colours the API serves
      (2021–2024). It clashed: the OB tag against PB blue (deutan ΔE 2.1) and three line colours against team
      blues (down to ΔE 4.6).
      - The lines are now four colours that pass the validator on all pairs in both themes. One is violet,
        used only in the lap-times chart, which shows no team colour. They are never cycled
        (`seriesColour`): a fifth series is neutral.
      - The archive gap chart and the positions fallback are neutral.
      - The OB tag has no hue: text ink, 2px outline, bold. The `--best` token was removed.
    - **`make web-up`** (new): rebuilds the web image and recreates only the web container, behind the
      replay guard. Tested in `tests/unit/test_makefile_web.py`. Run: the web container now serves the
      redesign and is healthy; the api is untouched (FULL=1 REPLAY=1).
    - **Local design-tool files:** the surface brief is to be committed; the tool's local config, cache and
      logs are gitignored.
    - **Detector:** the five `side-tab` hits are recorded in the inventory.
    - **Tests:** Vitest 454; `gapchart` and `seriesColour` tests and the four-line ΔE test were added; the 8
      contrast cases for `--best` were removed. The Makefile tests pass.
- UI redesign: bug fixes and a hierarchy polish round on the approved layout (2026-11-19, branch `redesign/ui`;
  not committed). Display only: no change to the reducer, the API, the stream job, Redis, Python or `results/`.
  - **Bugs:**
    - **Retired cars.** The client receives no retirement signal (none in the driver, tyre or timing hashes,
      the events, the entrants or the engineer view; race control is full-race analysis only). New
      `web/src/lib/stale.ts`: a car is stale when the leader has completed 2 or more laps since its last
      crossing, beyond the laps it is down (`lapsDown` from the crossings received, else the gap to the leader
      in leader lap times, for a late join). Stale cars are excluded from the call and the pairs flagged now,
      show "no timing since L19" across Int and Gap, are dimmed (faint text, flag faint), sorted to the bottom
      and never removed. A lapped car that keeps crossing stays eligible.
    - **After the finish** (replay finished, `session_end`, or the leader on the last lap) the call reads
      "Race ended at lap N", with no pit instruction, no Simulate and "Open the post-race archive".
    - **Labels:** the gauge reads "gap now"; the rule line reads "gap at decision (lap N)" from this page's alert
      for the pair, or "not received" after a late join.
    - **Clipping:** no tower cell, alert line or call block is cut off at 1440 px in either theme (column widths
      rebalanced, Gap 6.25rem for three-digit gaps; the alert meta wraps; the call 23.5rem tall).
  - **Hierarchy:**
    - the amber band is on the call's attacker and defender rows only (solid and dashed left rule, the role as
      a word); other flagged rows have no band, the % semibold from 50%; alert types are neutral outlines, amber
      only for alerts from the leader's lap or the one before, with the word "new";
    - the boxed L-tag is now a small muted lap number in Gap; lapped cars show "+1 lap"; the strip shows
      "N of M crossed";
    - the gauge runs 0 to max(5 s, gap × 1.5), shades and labels "rule window 3.5 s", draws the trend as an
      arrow to next lap's gap, and states the pit loss in text (no "G");
    - PB/OB start on lap 2; PB is quieter (no outline);
    - the gap chart's Highlight follows the call until the viewer picks; labels for the highlighted cars and
      the top 5; the rest thin grey; the lap-1 label clear of the y labels;
    - the what-if is preselected from the call (never run on its own), with "How to read this" and no empty
      table;
    - space: the tower is sized to the field; with no call while a replay streams the call keeps its height
      and shows the closest pair (why, a muted gauge, "N cars flagged, none qualifies", a neutral Simulate);
      it is one line only while idle, before lap 1 or after the finish (user decision 2026-11-19, so the feed
      never moves while streaming); the feed ends on a whole row with "N more below"; on a phone the head and
      the strip are one line each and the call starts at 168 px.
  - **Retired-car check (read-only, 2024 R5):** last laps BOT 19, TSU 26, RIC 33. After its last lap no car had
    an `undercut_alert` or a decision (0 and 0 each; race totals: alerts 12 / 8 / 9, decisions 28 / 19 / 12).
    BOT's driver hash kept `undercut_flag` for laps 20–56, and from lap 27 BOT sat directly behind TSU: before
    this change the call showed BOT → TSU for 30 laps. Sources: the archive bundle and
    `data/demo/2024_5_20261119T054513.908Z/decisions.jsonl`.
  - **Tests:** Vitest 454 -> 492 (new `stale.test.ts` and `polish.test.ts`; new cases in `call`, `tower`,
    `gapchart` and `theme`; the L-tag, gauge and "+1 L" assertions updated for the new markup). Playwright
    `race-layout.spec.ts`: at most 2 banded rows and only the call's pair; no tower cell, alert line, call block
    or alert row cut off; the first-viewport and layout-shift checks in both themes; the call within 180 px on
    a phone. Contrast: 184 of 184 pairs pass AA (3 new pairs per theme for the call's band).
  - **Evidence:** lint and typecheck clean; Vitest 492 passed; `node web/scripts/contrast-report.mjs --check`
    passes. Playwright against the rebuilt web container (`make web-up`, then
    `cd web && E2E_NO_SERVER=1 npx playwright test`): full lake, race-layout 4 of 4 and replay-controls passed
    (smoke.spec needs the sample lake); sample lake, 8 passed, 1 skipped (latency, by design).
  - **Screenshots** (`docs/design/after/`, 10× replays of 2024 R5, each under 400 KB): `d-dark-early` (lap 3,
    no call: the closest pair), `d-dark-mid`, `d-light-mid`, `m-dark-mid` (lap 38: the call's band on two rows,
    RIC/TSU/BOT stale at the bottom), `d-dark-latejoin`, `m-dark-latejoin` (page opened at lap 45),
    `d-dark-finished` ("Race ended at lap 56"), `d-dark-sample-smoke` (sample lake and model: SYNTHETIC DEMO DATA
    and SMOKE TEST).
  - **Services:** `make web-up` rebuilt only the web container (replay guard, no FORCE; replays stopped through
    the API first). The api ran `make api-up REPLAY=1 MODEL_DIR=models/undercut/sample_deploy_real_G3.5_k2` for
    the smoke shot and the sample suite, then returned to `make api-up FULL=1 REPLAY=1` (health: hdfs full,
    `deploy_real_G3.5_k2`; replay enabled).
- UI redesign: final race-view fixes from the screenshot review (2026-11-19, branch `redesign/ui`; not committed).
  Display only: no change to the reducer, the API, the stream job, Redis, Python or `results/`.
  - **Phone header (390 px).** The race head and the status strip wrap instead of scrolling sideways, so
    nothing is cut ("GREE") and every control is on screen: the Live/Post-race tabs, the Race/Engineer tabs and
    the page links.
    - Short labels on a phone only (`PhoneLabel`; the full text stays the accessible name): "Analysis",
      "Replay", "Connected". The "Model" key word is visually hidden.
    - The SYNTHETIC DEMO DATA notice wraps rather than being cut, and the call's heading no longer breaks.
    - The call starts at 188 px on the full lake. The sample deployment's stamps get a 240 px budget (user
      decision).
  - **Pit loss after a late join.** Cause: the call took the pit loss from the engineer response
    (`useCallContext`), which was fetched only once `state.maxLap >= 1`. A snapshot never sets `maxLap`, so a
    page that held only the snapshot fetched nothing until the next crossing (m-dark-latejoin was taken in that
    window), and the value was also dropped whenever the call's attacker changed. It was not a mobile path.
    Fix: the fetch keys on `leaderLap(state)`, and the race's pit loss (one value per race, `pit_loss(season,
    round)` in the API) is kept from any response.
  - **Unknown drivers.** Cause: the reducer's `unknownDrivers` counts, once per car, an event that arrived before
    any snapshot listed that car. It has nothing to do with the entrant list. A replay start clears the race
    keys, so cars whose lap-1 frame beat the snapshot listing them were counted (10), and a late joiner's first
    snapshot lists all 20 (0). The counter only grows, though every car was listed by the next snapshot.
    Fix (display only): the panel shows "Cars not yet in a snapshot", the cars still unlisted (`unlistedCars`,
    `known === false`), with a tooltip (glossary `unlisted`, new legend group "Pipeline"). The reducer counter is
    unchanged.
  - **Alert feed.** Sampled pixels showed only the lap-55 badge amber in the finished shot (laps 49–53 were
    already neutral). After the finish no alert is new (user decision; live keeps "leader's lap or the one
    before"). The "4×" counter has a title and the accessible text "4 alerts for this pair".
  - **Gap chart.** Before the first lap frame the live chart is one line, "First lap arrives at the next
    crossing.", not an empty 0–1 s axis.
  - **What-if.** The status line reserves one line (it was 2.6rem), and the empty error region takes no space,
    so the panel height follows its content.
  - **Tests:**
    - Vitest 492 -> 512: new `final-fixes.test.ts` and `pipeline.test.ts`; `gapchart.test.ts` updated for
      the new empty state.
    - Playwright `race-layout.spec.ts`:
      - at 390×844: every header and strip control is fully in the viewport, and no box in the notice, head
        or strip is cut;
      - the call starts within 200 px (240 px with the sample stamps);
      - the call's pit loss equals the engineer API's at both widths;
      - the what-if has no gap under its status line.
  - **Evidence:** lint and typecheck clean; Vitest 512 passed; `node web/scripts/contrast-report.mjs --check`
    reports all pairs meet AA.
    - Playwright against the rebuilt web container (`make web-up`): sample lake 8 passed, 1 skipped (latency,
      by design); full lake race-layout 4 of 4.
  - **Screenshots** (`docs/design/after/`, a 10× replay of 2024 R5, each under 230 KB): `d-dark-early` (lap 3),
    `m-dark-mid` (lap 38), `d-dark-latejoin` and `m-dark-latejoin` (both opened at lap 45: both show "pit
    loss 23.1 s from all earlier races"), `d-dark-finished` (no amber in the feed).
  - **Services:**
    - only `make web-up` and `make api-up` were used (replays started and stopped through the API);
    - the api ran in sample mode for the e2e suite and is back on `make api-up FULL=1 REPLAY=1` (health:
      hdfs full, `deploy_real_G3.5_k2`; replay enabled; no replay running).
- UI redesign Step 3 (2026-11-19, branch `redesign/ui`; not committed): F09 alert history and F10 smoke-test flag,
  both additive in the API, plus the e2e replay cleanup. The stream job, the Redis contract, the stream's decisions
  and alerts, and `results/` are unchanged (`git diff --stat` lists no file under `src/f1sa/streaming`, `serving`,
  `archive` or `results/`).
  - **F09 source (read-only survey first).**
    - Redis holds no alert history; adding one would change the contract.
    - `data/demo/<run_id>/decisions.jsonl` is written only when the stream job stops.
    - Kafka carries the producer's events, not the alerts.
    - **Chosen:** the API's own race-channel recorder, `api/lap_log.py`.
      - The replay start already ran one Pub/Sub subscriber per race for the what-if. It now also keeps the
        race's `undercut_alert` frames, deduplicated by `event_id` and capped at 1000 per run.
      - The route tags the fresh log with the run id; only such a log serves history.
      - API-only, no stream-job change.
  - **Connect snapshot.**
    - `snapshot-0` gets `recent_alerts`: at most 50, oldest first, each the exact live frame with the same
      `event_id`.
    - It is `[]` when the race has no Redis state, or when the API did not start the run.
    - Per-lap snapshots and every other field are unchanged.
    - **Barrier:** before reading, `history()` sends a PING on the subscriber's own Pub/Sub connection and
      waits for its reply (≤ 1 s), so every earlier message is recorded.
    - **Found while building:** redis-py 8 on RESP3 with decoded responses returns a subscribed PING's reply as
      a bare string, and `get_message` drops it. The subscriber therefore reads raw replies
      (`parse_response` + `handle_message`). Checked against the real Redis.
  - **Client.**
    - `events.ts` parses `recent_alerts` with the live alert parser. Bad or foreign items are dropped and counted
      in `malformed`.
    - The reducer applies them after the snapshot, deduplicated against `seen`. They are marked
      `history: before_open` (the page's first snapshot) or `while_away` (a reconnect). They never set a row's
      flag, are never announced and are never "new".
    - The feed shows them below a quiet divider in muted ink, "Received before you opened the page" ("Received
      while reconnecting" after a reconnect); the row fit subtracts the divider.
    - The call's "gap at decision" now fills after a late join.
  - **F10.** `checks.model` adds four fields, and the top-level `lake` object is unchanged:
    - `smoke_test`: the UI's rule, folder prefix `sample_`;
    - `trained_on`: `sample` from the metadata's `source`, else `full`;
    - `model_id`: the same value as `model_version`;
    - `stamp`: the metadata stamp or null.

    The UI takes SMOKE TEST from `smoke_test`, with the prefix as the fallback only.
  - **e2e cleanup.**
    - New `web/e2e/replay.ts` (`waitForIdle`, `stopReplay`).
    - `smoke.spec` and `replay-controls.spec` stop their replay in `afterEach`/`afterAll` (the started flag is
      set before the click).
    - `race-layout.spec` keeps `afterAll` only: its four tests share one replay. `afterAll` runs after a failed
      test too.
    - `latency.spec` starts no replay.
  - **Tests.**
    - **Python:**
      - new `tests/unit/test_api_alert_history.py` (13), including a snapshot contract test: every pre-existing
        key has the same name and value with and without history;
      - `test_api_health.py` +6, including a health contract test: every pre-existing field, among them
        `lake.scheme/mode/synthetic` and `checks.model.model_version`, is unchanged, and the rule is checked
        against the real deployed metadata of both folders;
      - new integration test `tests/integration/test_alert_history_live.py` (2, real Redis: the barrier with
        the API's client settings, and an alert published before subscribing is in `snapshot-0` once).
    - **Vitest 512 -> 524:** new `history.test.ts`, covering dedup of history and live, a reconnect repeating
      the history, `while_away`, never new, malformed items, the divider markup, and `smoke_test` overriding
      the prefix both ways. `call.test.ts` expects the four new nullable fields.
    - **Playwright:** new `latejoin.spec.ts`. It starts a 10× replay through the API and opens the page at
      lap 12, wrapping the page's EventSource. The feed already shows the history below the divider. After the
      next live alert, every pair's count equals its distinct event ids and no pair is shown twice.
  - **Evidence.**
    - **Python:**
      - `uv run pytest tests/unit -q`: **2333 passed**;
      - ruff, format and mypy clean;
      - integration: alert history 2 and `test_api.py` 4 passed.
    - **Web:** lint and typecheck clean; Vitest 524 passed; `contrast-report --check`: all pairs meet AA.
    - **Playwright** (sample lake, `make api-up REPLAY=1`, `make web-up`, `E2E_NO_SERVER=1 npx playwright
      test`): 9 passed, 1 skipped (latency, by design); `/api/replays` running `[]` afterwards.
      - Late join at lap 12: 41 history alerts (26 pairs), 2 live, 0 counted twice.
    - **`make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`: EQUIVALENT.**
      - The rebuild is identical.
      - Alerts are 113 / 19 / 9 = 141 and decisions 409, equal to parity.
      - Redis equals the bundle at laps 5, 22 and 45 and after `session_end`, and every message is equal.
    - **`make experiments-sample`:** OK 7, OK (metadata differs) 1, DIFF 0, MISSING 0, NEW 2 (the what-if
      files, as before).
    - **`results/`:** `sha256 results/stream_parity_full.csv` = `aad8df67…`, and `git status results/` is
      clean.
  - **Screenshots** (`docs/design/after/`, full lake, a 10× replay of 2024 R5, page opened at lap 45):
    - `d-dark-latejoin` (223 KB) and `m-dark-latejoin` (76 KB);
    - the feed holds 38 pairs below "Received before you opened the page";
    - the call shows "gap at decision (lap 41) 1.4 s" and "pit loss 23.1 s".
  - **Services.** Only make targets were used: `make api-up REPLAY=1`, `make web-up`, `make archive-equivalence`
    and `make experiments-sample`. Replays were started and stopped through the API. The api ends on
    `make api-up FULL=1 REPLAY=1`:
    - health ok, `lake` hdfs/full, `deploy_real_G3.5_k2`, `smoke_test` false, `trained_on` full;
    - replay enabled, no replay running.
- Freeze checks for `submission-rc1` (2026-11-19, on `main` at acc8ae3):
  - **CI:** run 44514775234 green (python 2326 passed / 7 skipped, web 524 Vitest, e2e demo + Playwright 2 passed
    / 1 skipped). No annotations; log warnings are harmless (eslint@9 deprecation notice from npm, git default-branch
    hint, JDK incubator-module notice, netlib BLAS fallback, the sample's missing `stints_tracinginsights` table).
  - **Clean clone** from GitHub as its own compose project (`COMPOSE_PROJECT_NAME=f1sa-clone F1SA_IMAGE_TAG=clone`,
    no `.env`), warm image cache: `make up` 63 s, `make sample-data` ok, `make demo` 193 s. Health ok (sample,
    synthetic, smoke-test model), 20 cars in Redis, SSE carried 137 `undercut_alert` and a `session_end`,
    dashboard 200 and Playwright smoke 2 passed / 1 skipped. The full stack was then restored (`make up-full`,
    `make api-up FULL=1 REPLAY=1`, `make web-up`); the HDFS `/f1` tree is identical before and after (12,094
    directories, 13,596 files; before = offline fsimage + edit log of the stopped namenode).
  - **Traceability:** `docs/traceability.md` rewritten with Status, Code, Tests and Proof columns (same 44
    commitments; the proposal PDF is not in the repo). `scripts/check_traceability.py` now checks every cell
    after Step (each cell on its own); new test `test_every_cell_after_step_is_checked`. Result: OK 490,
    GENERATED 2, PENDING 3 (S18), MISSING 0. Partial: #4 (FastF1 via TracingInsights), #43 and #44 (S18 open).
  - **Hygiene:** only `data/sample/` is tracked as data, no `models/`, no `.env`, no credentials; regex secrets
    scan 0 hits (one `FAKE_PASSWORD` test constant); OFL 1.1 present for all three fonts; one tracked file over
    1 MB (a local design tool's font index, 1.05 MB; untracked since). `.gitignore` now also
    ignores `checkpoints/`.
  - **README fixes** from the clean clone: a note on a second checkout (fixed project name `f1sa`, the isolation
    variables of `docs/reproduce.md` §4); "What `make demo` does" lists the entrants, analysis and archive steps,
    with the 193 s timing; full-data step 5 says `make up-full` comes before `make api-up FULL=1 REPLAY=1` after a
    `make down`.
- Step 18a, the report and the demo script (2026-11-19, documentation; #43 and #44):
  - **`docs/report/report.md`:** the final report, 17 sections in the order of the traceability matrix, plus
    Appendix A "Claims and sources" (62 headline numbers, each with its source file and place).
    - Every number is copied from a committed file in `results/` or `docs/`; nothing was recomputed.
    - Figures are the committed PNGs and the redesign screenshots.
    - No new 2025 number. The what-if 2025 row is the README's (user decision).
    - Section 16 (team contributions) has a "TODO: fill in" cell per member, left for the team (now "TO BE
      COMPLETED BEFORE SUBMISSION", review fixes below).
  - **`docs/report/report.pdf`** (committed, the submission file): `make report-pdf` renders it.
    - The renderer is `web/scripts/report-pdf.mjs`: marked turns the Markdown into HTML, mermaid draws the diagram
      inside Playwright's Chromium, and Chromium prints A4 with page numbers, PDF bookmarks and a linked table of
      contents.
    - Result: 18 pages (body 15, Appendix A 3), 2252.8 KiB.
  - **New devDependencies** (user approval, exact pins): `marked` 18.1.3 and `mermaid` 12.3.0, both MIT.
    - marked 18.2.1 was 3 days old, so the newest release at least two weeks old was pinned.
    - `package-lock.json` is updated.
    - The web runtime image is unaffected: a separately tagged build had no marked or mermaid files (mermaid only
      in the copied `package.json`), and its size was 403,671,409 bytes against 403,671,405 for `f1sa-web:dev`. The
      temporary tag was removed.
  - **`docs/demo_script.md`:** a 10-minute and a 5-minute timed demo (full lake, 2024 R5, 10x), with pre-checks,
    the fallback plan (sample mode with the SMOKE TEST explanation, the screenshots, stopping a hung replay) and
    answers to likely grader questions.
  - **Checks.**
    - `scripts/check_traceability.py` now knows `.pdf` (it read `report.pdf` as a module attribute).
    - Row 44's Step is `S18A, S18B`, so its references are checked rather than PENDING: OK 505, GENERATED 2,
      MISSING 0.
    - New tests in `test_repo_docs.py`: the sections, links and images, Appendix A values verbatim in their sources
      and in the report body, and the PDF present. Also `test_makefile_web.py` (`make report-pdf`, dev-only pins)
      and `web/tests/reportPdf.test.ts`.
  - **README fix.** "Full-data mode" said the 2021–2025 lake has 90 races. It now says the lake holds 114 races
    (2021–2025) and the API serves the 90 of 2021–2024 (2025 is the sealed test season).
- Step 18a review fixes (2026-11-19, documentation; #43, #44): the report review's P0, P1 and P2 findings applied to
  `docs/report/report.md` and `docs/demo_script.md`, each P1 claim checked against its source first.
  - Report:
    - conclusion corrected: better than the majority baseline on PR-AUC, ROC-AUC, F1 and Brier, not ECE;
    - in-sample selection Brier; sparse LR (6 of 52 columns); development LOSO 0.559 against 0.533;
    - the label's dependence on the defender's response;
    - the race-filter cost in the recorded build cells; the two Redis hosts;
    - data volume; track status and the frozen label;
    - a planned-vs-actual timeline (#43); the what-if screenshot (#26); plain names for step labels; a Terms
      paragraph;
    - Appendix A has 79 rows.
  - Figures:
    - every figure at full text width, with the screenshots stacked;
    - five report-only copies in `docs/report/figures/`, re-plotted from the committed `results/*.csv` by
      `docs/report/make_figures.py` (`uv run python docs/report/make_figures.py`; deterministic; `results/`
      unchanged);
    - file names in tables no longer break mid-word.
  - PDF: 21 pages (body 18, Appendix A 3).
  - Demo script:
    - segment 9 commands fixed (`sed … | head -12`; the checker prints no MISSING entry);
    - Enter after Ctrl+V; segment 9 now 90 s;
    - the sample fallback is prebuilt (`make demo-pipeline`, 153 s), so during the demo it is only `make up`
      plus `make demo-replay DEMO_SPEED=10` (28 s, measured on the dev host).
  - Tests: `test_repo_docs.py` expects "TO BE COMPLETED BEFORE SUBMISSION" and allows `docs/report/figures/`.
- UI redesign Step 4A (2026-11-19, on `main`; not committed): the engineer tab, the post-race archive and the race
  picker moved onto the DESIGN.md system, plus the analysis race-control F35 row (user decision). Display only:
  `LiveRaceView`, the reducer, the API, the stream job, Python, Redis and `results/` are unchanged, and so are the
  shared components (`TowerPanel`, `GapChart`, `AlertFeed`, `StatusStrip`). The archive only passes them props
  they already take.
  - **Engineer** (`EngineerPanel.tsx`, `lib/engineer.ts`):
    - **Cards:** the three cars are columns of one panel split by hairlines (no panel in a panel). The focus
      column has a 2px text-ink top rule and no amber.
    - **Status line:** separate cells (lap, track, race control).
    - **F21:** each pair's sparkline sits right beside its sentence. It is a 2px neutral line with the latest lap as
      its only dot and a direct end label; with no laps it says why.
    - **F20:** the rejoin bar is a seconds axis behind the focus:
      - car codes sit in lanes that never overlap (`rejoinLanes`, reusing the archive's `markerRows`);
      - 0 s and the scale are written out;
      - the rejoin slot is an authored SVG triangle with the word "rejoin" in its own row, replacing the `▼`
        glyph and the amber;
      - "Pit loss: no estimate" replaces "—".
    - **F35:** strategy calls carry a Watch / Info chip (word and outline), not a side bar.
    - **F19:** with nothing locked and no call, the focus defaults to P2 (`pickFocus`).
  - **Archive** (`PostRaceView.tsx`, new `ArchiveStrip.tsx`, `ArchiveControls.tsx`, the archive branch of
    `RaceDashboard`):
    - **F08:** the head follows the live order (crumbs, h1, mode tabs, Race analysis / Drivers). It is rendered
      once above the loading and loaded states, so a keyboard switch keeps focus on the tab.
    - **F31:** a skip link to the lap controls.
    - **Status strip:** POST-RACE, lap, a track code chip carrying the border style (as in the live strip), model
      and scorer. On its own line, as visible text, the latest key race-control message with its lap and the status
      source (user decision: the banner's information is kept).
    - **Banner removed:** `RaceStatusBanner` and its side-border CSS are deleted. These were the two "intentional"
      side-tab hits. Nothing is suppressed.
    - **F07:** the Tyres panel is removed (`TyrePanel` deleted, user decision).
    - **F13 / F22:** the alert rows show both cars' tyres. Amber appears only on alerts from the scrubbed lap or
      the one before, as on the live page at that lap, and never after the finish.
    - **Controls:** a neutral slider and alert markers; 24 px markers (WCAG 2.5.8) inset so they stay inside
      their lane.
    - **F35:** race-control key rows use weight and a "Key" chip.
    - **F33:** all sizes are tokens.
  - **Picker** (`RacePicker.tsx`, `lib/races.ts`):
    - **F36:** a "Start here" card above the search (`startHere`): the race replaying now, else the `make demo` race
      (2024 R5), else the newest race, with links to the race and, when one exists, its post-race archive. It is
      neutral (no amber) and its height is reserved while the lists load.
    - **Cards:** token type.
    - **F34:** re-checked (the placeholder is `--faint`, 5.33:1 and up).
  - **Analysis:** `.rc-list li.is-key` lost its side bar (weight and a "Key" chip).
  - **Live parity:** two rules the live strip had inherited from deleted blocks are kept on purpose, with comments:
    the track cell's flex values, and the 12.8 px `.mode-note`. The live phone-head rules are untouched; the
    archive head has its own copies.
  - **Tests:**
    - Vitest 532 passed:
      - `engineer.test.ts`: rejoin slot markup, Watch chip, `rejoinLanes`, `zeroPct`, the `pickFocus` fallback,
        the empty sparkline;
      - `status.test.ts`: the banner render tests moved to `ArchiveStrip`;
      - `tyre.test.ts` and `legend.test.ts`: TyrePanel cases dropped;
      - new `picker.test.ts`;
      - `archive.test.ts` unchanged and green.
    - Lint and typecheck are clean, and `contrast-report --check` says all pairs meet AA.
    - `smoke.spec.ts` (selector-only changes):
      - the picker link is scoped to `#race-list`;
      - the archive mode check is `.status-strip .ss-mode` "POST-RACE";
      - the lap 1 / 21 race-status checks moved to the strip (`.ss-lap`, the track chip, `.ss-rc` with the source).
    - New `e2e/screens-layout.spec.ts` (picker, archive at lap 30, engineer; 1440 dark and light, and 390):
      - no page overflow and nothing cut;
      - the key controls are in the first viewport;
      - no amber on the archive controls;
      - every marker is inside its panel;
      - rejoin labels do not overlap;
      - the sparkline is beside its sentence.
    - Sample lake (`make api-up REPLAY=1`, `make web-up`, `E2E_NO_SERVER=1 npx playwright test`): 17 passed,
      1 skipped (latency, by design).
    - Full lake: `race-layout.spec` 4 of 4 and `screens-layout.spec` 8 of 8.
  - **Anti-pattern scan** (`web/src/app web/src/components`): 0 findings and no suppressions. HEAD's stylesheet had
    5 side-tab hits.
  - **Screenshots** (each under 130 KB):
    - `docs/design/before/`: `d-dark-archive.png`, `d-light-archive.png`, `m-dark-picker.png` (new; the engineer
      and picker dark ones were already there);
    - `docs/design/after/`: `d-dark-engineer.png`, `d-dark-archive.png`, `d-light-archive.png`,
      `d-dark-picker.png`, `m-dark-picker.png`.
- UI redesign Step 4B (2026-11-19, on `main`; not committed): the last screens on the DESIGN.md system. These are
  the race analysis (8 tabs), telemetry, drivers, the Pipeline panel, "How to read this" and the footer. The
  legacy token aliases are removed. This was display only: the reducer, the API, the stream job, Python, Redis and
  `results/` are unchanged. The race view, engineer view, archive and picker keep their markup; the Pipeline panel
  and legend got CSS only.
  - **Head (F08):** the new `RaceSubHead` serves analysis and drivers, in the live order (crumbs, h1, then "Live
    race", "Race analysis", "Drivers"). It replaces the old head with the doubled "/ / Race /" crumbs.
  - **Analysis tabs:** text-ink underline, no amber (F05). They wrap on a phone, so all 8 are visible at 390 px.
  - **Charts (dataviz):**
    - each chart has a visible text summary, a legend for two or more series, `<title>` + `<desc>` and
      "Show table";
    - the new `ChartHover` gives a hover readout (lap crosshair or mark box) that the keyboard reaches too (a
      slider: arrows, Page Up/Down, Home, End);
    - series names are text ink; whole-lap ticks only (a short race had 1.5, 2.5 …); lap-time ticks drop ".000".
  - **New pure helpers** (unit-tested): `lapTimesSummary`, `positionsSummary` and `pitStopsSummary` in
    `lib/analysis.ts`, `nearestPoint` and `hoverKey` in `lib/plot.ts`, and `lapTick` in `lib/format.ts`.
  - **Per tab:**
    - **Strategy:** the authored pit triangle replaces "▼", which is not in the font subset. A 2 px surface gap
      replaces the bar borders.
    - **Lap times:** end labels never overlap.
    - **Degradation:** keeps "A lap-time proxy, not tyre wear". The fit legend is the stint list.
    - **Positions:** full names only at 560 px or wider.
    - **Compare:** gain/loss replace red/blue `--ok`/`--danger`. Both charts have a `<desc>`. "Delta" replaces
      "Δ". The charts now fill the panel; they were stuck at 760 px because the ref was mounted after the
      loading state.
    - **Pit stops:** authored arrow in place of "→".
    - **Race control:** kind chips with border styles; no uppercase tracking.
  - **Telemetry fallback:**
    - A car without a team colour is now neutral text ink, never `--line-0/1` next to the other car's team colour.
    - `strokesClose` (`lib/telemetry.ts`) and the new `deltaE` with protan/deutan simulation (`lib/theme.ts`) flag
      similar strokes for the legend note.
    - The dataviz validator was run on text ink against all 35 served team colours, in both themes: 68 of 70
      pass. The 2 dark failures (`#ffffff`, `#27f4d2`) are exactly the ones `strokesClose` flags.
  - **Drivers:** one panel with h2 and count. At 390 px the table fits with no sideways scroll; the tower's sticky
    phone cells no longer paint over Nat.
  - **Shared parts:**
    - the data banner reads `--raised`/`--text`;
    - the footer sits under a hairline;
    - the legend and pipeline disclosures have a chevron and a 24 px target.
  - **Legacy aliases:** removed from `theme.ts` (the `Theme` fields, `VAR`, CSS emission) and `globals.css`, along
    with the `--radius`/`--gap` shorthands. The new guard is `web/tests/legacy-tokens.test.ts`.
  - **Tests:**
    - Vitest 550 passed.
    - Lint and typecheck clean; `contrast-report --check` all AA (92/92 per theme, unchanged).
    - Anti-pattern scan: 0 findings, no suppressions.
    - Sample lake (`make api-up REPLAY=1`, `make web-up`, `E2E_NO_SERVER=1 npx playwright test`): 26 passed and 1
      skipped (`latency.spec.ts`, which runs only with `E2E_LATENCY=1`).
    - Full lake (`make api-up FULL=1 REPLAY=1`): `race-layout` + `screens-layout` 21 passed.
    - `git status results/` is clean.
  - **Screenshots:**
    - `docs/design/before/`: `d-dark-analysis-laps`, `-positions`, `-compare`, `-telemetry`,
      `d-light-analysis-laps`, `m-dark-analysis`, `d-dark-drivers`.
    - `docs/design/after/`: `d-dark-analysis-strategy`, `-laps`, `-positions`, `-compare`, `-telemetry`,
      `d-light-analysis-laps`, `m-dark-analysis`, `d-dark-drivers`.
    - All are full lake, 2024 R5, each under 240 KB.
- UI redesign Step 5 (2026-11-19, on `main`; not committed): final audit of the whole dashboard, then the approved
  display-only fixes. No reducer logic, API, stream, Python, Redis or `results/` change.
  - **Audit (read-only first):** every screen at 1440, 1280, 1024, 768 and 390 px and at 200% zoom, in dark, light
    and Auto. It covered the Tab walk, Escape, landmarks and headings, axe, reduced motion, CLS, long tasks and JS per
    route, and the honesty labels on the full lake and the sample deployment. The report is
    the local audit notes of 2026-11-19 (not committed).
  - **New devDependency:** `@axe-core/playwright` 4.14.0 (exact pin, released 2026-10-15).
  - **P0, tower Driver column:** it collapsed to 0 px at 768 and 1100–1366 px (`width: auto` in a fixed-layout
    table), live and archive. Below 1440 px it is now a fixed 7.25rem, and Pos/pin/Driver/Undercut stay sticky while
    the other columns scroll inside the tower.
  - **P1:**
    - The call never relabels its defender. When the alert's defender is no longer directly ahead, it shows
      "flagged at lap N against D; order changed since" (the car ahead now is in the accessible text), the alert's
      probability and a muted gauge at the decision gap with no trend, and the rule checks are not presented as
      passing (`pairAt`, `latestAlertOf`, `orderChangedText` in `lib/call.ts`). The first live capture at lap 45
      showed the longer wording cut off and the gauge label wrapping; both were fixed before the screenshots were
      retaken.
    - **Stored state:** an earlier run's Redis state with nothing streaming (for example after an API restart) is
      "NOT REPLAYING", never LIVE. The call is one line with no pair, probability or model id, and the tower's note
      says the flags came from that run (`storedLap`, `modeOf`).
    - The "2025 base rate" line is removed (option a).
    - Engineer: "Data to lap N", and one "Gaps" key (`enggaps` replaces `gaptrend` and `engprob`).
    - Only P1 says "Leader" (`towerGap`).
    - The archive strip stamps SMOKE TEST for a bundle scored by the sample model.
    - Archive a11y: the ±1 lap and marker names start with their visible text, and the archive's alert list is
      focusable.
  - **P2:**
    - The 60× archive border was verified as `--text`, not amber: no change.
    - SC/VSC are text ink in the archive markers and race-control lists; the strip's track chip keeps `--loss`.
    - Lap number right-aligned; Drivers table capped at 56rem; no-break spaces in the model line.
    - Positions starts on the summary's drivers, the others thin and grey.
    - Load CLS: `main` keeps a min-height, and the call reserves its height until `/api/replays` answers.
    - The race status is fetched at the leader lap the page holds; with none it shows a dash after the finish or
      for a stored state.
    - One h3 size (`--fs-md`), and the legend has its own h2.
    - The data banner is inside the header landmark; unique pit-stop region name; the gauge is a `div role="img"`.
    - On a phone the archive's button rows sit 4 px apart, so the sample bundle's SMOKE TEST stamp keeps the event
      markers in the first viewport.
  - **Investigation (read-only), "Leader" on VER at P3, lap 14:** Redis was right (end of lap 14: P3, gap ahead
    3.006, gap to leader 10.101; lap 13: P1, 0.0). The web reducer mixed laps for a page that joined mid-lap.
    `applyLap` recomputes gaps from the lap frames the page received and falls back to the previous value
    (`gapLeaderS: g.leader ?? r.gapLeaderS`). The leader's lap-14 crossing had arrived only in the connect snapshot,
    which writes no history, so VER kept his lap-13 value 0.0 until the next per-lap snapshot. The display fix hides
    the symptom; the reducer is unchanged (see Known issues).
  - **Tests:** `web/tests/step5.test.ts` (13 tests). `web/e2e/step5.spec.ts` covers the Driver column live and
    archive at 5 widths, the 1280×800 first viewport, and axe on every screen in both themes (0 serious/critical).
- Step 18 final (2026-11-20, on `main`; documentation only): the report and the demo script describe the final
  dashboard, then every proof was run.
  - **Report** (`docs/report/report.md`):
    - the "2025 base rate" line is gone from §10 and the honesty labels (the 2025 base rate of the test results in
      §11.3 is kept);
    - §10 describes the final live view (mode chip with NOT REPLAYING, the call with "order changed since"), links
      the final engineer, archive, analysis and picker shots in `docs/design/after/`, and adds the final audit;
    - Figure 4 caption now matches `after/d-dark-mid.png` (lap 20, SAR → ZHO, 78%) and Figure 5 matches
      `after/d-dark-latejoin.png` (lap 45, ALB → OCO, "order changed since"); Figure 3 keeps the pre-redesign
      what-if shot, the only one of that panel;
    - §13 adds the stale gap for up to one lap after a late join (the stale-car rule was already there); §15 future
      work and the §12 timeline are updated; §14 and Appendix A61 quote the final proofs below; new rows A84–A87.
      Section 16 still says "TO BE COMPLETED BEFORE SUBMISSION".
  - **Demo script** (`docs/demo_script.md`): the base-rate narration removed; NO REPLAY / NOT REPLAYING before a
    start, the Start here card, the call as on screen, the order-changed call at a late join, "Data to lap N" and
    Gaps in the engineer view, the POST-RACE strip, STOPPED with "Open the post-race archive"; the fallback
    screenshots are the final ones.
  - **Final proofs:**

    | Proof | Result |
    |---|---|
    | Python unit suite (`make test`) | 2340 passed in 951 s |
    | Web (`make web-test`) | lint and typecheck clean; Vitest 563 passed (28 files) |
    | Contrast (`contrast-report.mjs --check`) | 92 of 92 pairs per theme meet AA |
    | Anti-pattern scan of `web/src/app` and `web/src/components` | 0 findings, no suppressions |
    | Sample e2e (`make api-up REPLAY=1`, `make web-up`, `E2E_NO_SERVER=1 npx playwright test`) | 40 passed, 1 skipped (latency, by design) |
    | `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45` | EQUIVALENT; 113 / 19 / 9 (141 alerts), 409 decisions |
    | `make experiments-sample` | OK 7, OK (metadata differs) 1, DIFF 0, NEW 2 |
    | `scripts/check_traceability.py` | OK 506, GENERATED 2 |
    | `make lint`, `make typecheck`, `test_repo_docs.py` | clean; 153 files mypy-clean |
    | `sha256sum results/stream_parity_full.csv` | `aad8df67…` |
    | `git status --short results/` | empty |

    In short: python 2340 passed, web 563 Vitest, sample e2e 40 passed / 1 skipped.
  - **Notes on two proofs:**
    - `make demo-pipeline` had rebuilt the sample 2024 R5 archive bundle with the SMOKE TEST model, so
      `make archive-equivalence` without `MODEL_DIR` refused (scorer mismatch) and with the sample model gave
      EQUIVALENT with 113 / 15 / 9 (137 alerts). The 113 / 19 / 9 figure belongs to the deployed model, so the bundle
      was rebuilt with it (`make archive-sample ARCHIVE_SEASON=2024 ARCHIVE_ROUND=5
      MODEL_DIR=models/undercut/deploy_real_G3.5_k2`), checked, and rebuilt again with the sample model so the
      fallback demo is as `make demo-pipeline` left it. Only `data/lake/archive` was written.
    - `make experiments-sample` reports DIFF for `models/sim/tyre_model_sample.json` when the working tree is dirty:
      `git_dirty` is not an ignored metadata field. It was rerun on a clean tree (the three edited docs stashed and
      restored) for the result above.
  - **Services at the end:** `make api-up FULL=1 REPLAY=1`; health 200 (hdfs, full, `deploy_real_G3.5_k2`,
    smoke_test false, trained on full); no replay running. The web container was rebuilt from 98940c5.
- 2026-11-20: README landing page and a static architecture image (docs and README assets only; no app code,
  `results/` or `data/` change).
  - **README** rewritten as a landing page (175 lines, `---` between sections): hero, overview, one linked
    full-width screenshot per feature from `docs/design/after/` (the call and the timing tower refer to the hero),
    How it works, quick start, key results (copied verbatim from `docs/results.md`), documentation, team,
    licence. Every earlier link is kept; its 41 relative links and images resolve.
  - **Architecture image**: source `docs/assets/architecture.mmd`; `make readme-assets`
    (`web/scripts/readme-assets.mjs`, mermaid 12.3.0 + Playwright Chromium, no new dependency) writes
    `architecture-{dark,light}.svg` and `.png` (2x). The three rows (Data in, Batch, Live) sit on tinted stage
    bands. The links between rows are explicit and labelled, and the script routes them. mermaid cannot do this,
    because it drops a subgraph's direction once its nodes link outside it. Fonts are embedded and the labels are
    SVG text (no `foreignObject`), so the image renders inside `<img>`.
  - **Guards**: smallest text 11.4 px at 830 px (at least 11), in-row links left to right, no label overlaps. The
    README shows the image with `<picture>` (dark and light sources, dark PNG fallback).
  - **Diagram choices**:
    - the what-if simulator sits in the Batch row (its tyre model is fitted offline; it is run per request by the
      API);
    - FastAPI's replay control is in its node label, not drawn as a link back to Kafka.
  - **Report**: Figure 1 is now `docs/assets/architecture-light.svg` (Appendix A unchanged), and
    `make report-pdf` was rerun: 22 pages, body 19,
    Appendix A 3 (pypdf: the page whose first line is the Appendix A heading is page 20; the script's own
    "body 21, appendices 1" summary line is not used).
  - **Tests**: `test_repo_docs.py` README test, wording only: `` ```mermaid `` became the `<picture>` sources,
    and the platform names are read from `architecture.mmd`. New `web/tests/readmeAssets.test.ts` (11 tests).
  - **Shorter README** (same day): the Quick start moved word for word to the new `docs/getting-started.md`
    (Prerequisites, Installation, Run the demo, Full-data mode, Stop); "Getting started", "Key results" and
    "Documentation" are now one line or two links each, pointing to `docs/getting-started.md`,
    `docs/reproduce.md`, `docs/results.md` and `docs/README.md`. The README test now finds the demo commands in
    `docs/getting-started.md` and the headline PR-AUC in `docs/results.md`; traceability row 5 cites
    `docs/reproduce.md` for full-data ingestion instead of the README.
- 2026-11-20: repository layout made production grade (no app behaviour change; `results/`, `data/` and the frozen
  specs byte-identical).
  - **Untracked, kept on disk:** the local tool folders (skills, agents, commands, design-tool state and the
    knowledge-graph ignore file), then in `.gitignore`. The project notes and the tool settings file stayed
    tracked until the clean-up below.
  - **Moved:** `PRODUCT.md` to `docs/design/product-brief.md`; `docs/report/make_figures.py` to
    `scripts/report_figures.py` (paths fixed; rerun gives the same five PNGs in `docs/report/figures/`).
    Deleted the empty placeholders `docs/decisions/` and `tests/e2e/` (the Playwright tests live in `web/e2e/`).
    Older entries in this log keep the old paths as history.
  - **Added:** `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (v1.0.0) and `.github/pull_request_template.md`,
    linked from `README.md` and `docs/README.md`; traceability row 44 lists them.
  - **Version 1.0.0** in `pyproject.toml`, `f1sa.__version__`, the Jolpica User-Agent and `web/package.json`;
    `uv.lock` and `web/package-lock.json` were updated by `uv lock` and `npm install --package-lock-only` (only
    the project's own version lines changed). `data/sample/MANIFEST.json` keeps `f1sa_version 0.1.0`, the version
    it was built with (the validator does not compare it).
  - **Tests** (`test_repo_docs.py`): every relative link and heading anchor in every Markdown file resolves (the
    deliberate `web/tests/fixtures/report/report.md` excepted); the local tool files are not tracked; the new docs
    are linked and the CHANGELOG, pyproject, package.json and `__version__` versions agree.
- 2026-11-20: course submission report `docs/report/final_report.md` and `docs/report/final_report.pdf`
  (`make final-report-pdf`). `docs/report/report.md` and `report.pdf` are unchanged and stay the full report.
  - **Format:** 8 A4 pages, sections in the course order (Problem, Approach and Methods, Evaluation, Summary,
    References), 4 figures (architecture, live race view, feature-build scaling, paired ablation), no appendix.
    A "Real-Time Serving Layer: Redis 8.10 Schema" subsection answers the feedback on the serving layer.
  - **Renderer:** `web/scripts/report-pdf.mjs` gained `--style course` (exported `STYLES`, `styleOf`,
    `parseArgs`, `protectIntervals`): `@page` A4 with 25 mm margins, the page size taken from CSS (209.9 x 297.0 mm;
    Chromium's own A4 format is 210.2 x 297.3 mm), 9 pt tables, page numbers only. The default style's HTML for
    `report.md` is byte-identical to before. No new npm or Python dependency.
  - **Fonts (revision, same day):** body and headings in "Times New Roman", "Liberation Serif", serif and code in
    "Courier New", "Liberation Mono", monospace, as in the course proposal. Times New Roman is not installed on the
    dev host, so the PDF embeds Liberation Serif/Mono 2.1.5 (SIL OFL 1.1), committed as report-only files in
    `web/scripts/fonts/liberation/` (3 TTFs, about 1.1 MB, source and sha256 in its README). Redis keys never wrap;
    bracketed intervals never break; tables of up to 6 rows stay on one page.
  - **Wording (revision):** no statement about the proposal itself (1.5 opening, 4.1 opening removed, "Goal" column,
    4.2 "Changes and Additions"); 4.2 says LR and GBT were evaluated and the calibrated LR deployed.
  - **Checks:** pypdf (temporary `uv run --with`, no pyproject change): 8 pages, body text 10.0 pt in an embedded
    Liberation Serif subset, content within the 25 mm margins. Every number of the report (210
    distinct) appears in `report.md`, `results.md`, `architecture.md`, `experiments.md`, `model_results.md` or
    `traceability.md`; `test_repo_docs.py` now checks that, the course section order, the four figures and the
    committed PDF; `test_makefile_web.py` checks the target; `web/tests/reportPdf.test.ts` covers the style.
- 2026-11-20: local tool files out of the tracked tree (no history rewrite; no app behaviour change; `results/`,
  `data/`, the frozen specs and `docs/report/final_report.pdf` byte-identical).
  - **Moved first, then untracked:** the project notes' Redis key contract is now verbatim (without internal
    labels) in `docs/architecture.md` ("Redis serving", "Key contract"); the stack commands, safety rules
    (including: never touch `/f1/raw` or `data/manifest.json` by hand), pinned versions, data rules and
    environment notes are in `CONTRIBUTING.md`. The project notes file and the tool settings file are no longer
    tracked; they stay on disk.
  - **Ignore rules:** every local tool entry moved from `.gitignore` to `.git/info/exclude` (local only).
    `.dockerignore` excludes every top-level hidden entry (`.*`, `!.env.example`); a probe build shows the root
    context without hidden folders, and `make web-up`, `make up-full` and `make api-up FULL=1 REPLAY=1` rebuilt
    and started healthy (no build reads a root dotfile).
  - **Removed:** `docs/planning/playbook_v2.md` (mostly step-by-step build instructions). The frozen `docs/model_spec_v2.md` still
    cites it; it is unchanged at the git tag `model-spec-v2` (`git show model-spec-v2:docs/planning/playbook_v2.md`).
    `docs/README.md` and `docs/traceability.md` point there.
  - **Reworded:** `docs/design/product-brief.md` is a plain product brief; the design records name the
    "anti-pattern scan"; `report.md` cites `docs/architecture.md` for the Redis schema (`report.pdf` rebuilt,
    22 pages).
  - **Tests:** `test_keys.py` reads the contract from `docs/architecture.md`;
    `test_repo_docs.py::test_tracked_top_level_entries_are_the_project_layout` replaces the old tool-file check
    with an allowlist of tracked top-level entries and hidden names. Traceability: OK 522, GENERATED 2.
- UI replay transport (2026-11-21, on `main`; display only, not committed): the live race page's replay popover,
  which covered the call while a replay ran or was paused, is replaced by an inline transport at the right end of the
  status strip. The replay API, `useReplays`, the reducer, the stream, Python and Redis are unchanged.
  - **Component:** `web/src/components/ReplayTransport.tsx` replaces `ReplayControl.tsx` and `ReplayDrawer`. Phases
    (`transportPhase` in `lib/replays.ts`): idle (Start replay, neutral 2 px text ink, plus the 1×/10×/60× radios),
    blocked (Start disabled, the reason as text), active (Pause/Resume, Stop, speed), over (Replay again at the last
    run's speed, "Open the post-race archive", moved here from the strip). Authored icons with visible labels
    (`Marks.tsx`). Shared by the Race and Engineer tabs (the strip sits above both).
  - **Stop:** two presses (`confirmStep`): "Confirm stop" (2 px `--danger`) for 4 s; Escape, the timeout or the replay
    finishing or failing on its own disarms it and sends nothing. No modal, alert or `confirm()`.
  - **Announcements:** one visually hidden polite region (`liveText`) announces each mode or replay change once; the
    mode chip is no longer a live region (user decision 2026-11-21). "Lap N sent." is gone (`replayLapText` removed).
    A refused action or a failed replay's reason is a `role="alert"` line under the strip.
  - **The call:** its "Open replay controls" button is removed (the strip's Start replay is right above it at every
    width); the idle and stored lines say "Start one from the status strip above." After the finish it says "Race ended at lap N. The live
    call stops at the chequered flag." with no button: its "Open the post-race archive" (and the "not built yet"
    note) is removed, because the strip's transport offers the archive next to Replay again (once on the page).
    `call.test.ts` checks the ended call has no button; `replay-transport.spec.ts` checks the finished state offers
    the archive at most once, in the strip.
  - **Layout** (measured with `/api/replays` stubbed, full lake): the strip keeps one height in all 7 states at each
    width (1440 and 1280: 40 px, one line; 1024: 70; 768: 90; 390: 98). Below 1440 px the gaps narrow, the "Model" key
    word is visually hidden and the connection reads "Connected"; the model's detail is tooltip and screen-reader
    text at every width. Below 1180 px the transport takes the strip's second line; on a phone it is its own
    full-width line with 44 px targets. Phone budget for the call raised to 250 px (236 measured, full lake) and
    290 px with the sample's stamps (272 measured) (user decision 2026-11-21).
  - **Tests:** Vitest 593 passed (`replays.test.ts` rewritten: phases, `confirmStep` incl. the armed-then-finished
    path, `liveText`, transport markup; `call`, `step5`, `final-fixes`, `polish` updated). e2e: new
    `replay-transport.spec.ts` (stubbed: 5 widths × 7 states, Engineer tab at 1440/390, two-press Stop, armed then
    finished/failed, keyboard, axe both themes, a self-test of the cover check) and helper `e2e/transport.ts`;
    `replay-controls.spec.ts` rewritten (real sample replay; call never covered, one strip height, axe in every
    state); `smoke.spec.ts` (no drawer), `race-layout.spec.ts` (budgets 250/290, one-line strip at 1440, drawer
    exclusion removed), `step5.spec.ts` (strip checks at 5 widths). `smoke` and `replay-controls` start from the
    idle or the over phase (`startFromStrip`): after an earlier run of the race the strip offers Replay again (the
    last run's speed), and the speed is set once the run is active; the demo script says so.
  - **Docs:** `demo_script.md`, `getting-started.md`, `report.md` §10 (`report.pdf` rebuilt, 22 pages;
    `final_report.pdf` untouched), `DESIGN.md` (strip row, new Replay transport row, the call's idle line),
    `architecture.md`, `traceability.md` (row 25 path), `product-brief.md`. Traceability: OK 522, GENERATED 2.
  - **Screenshots** (`docs/design/after/`, full lake, 10× replays of 2024 R5, pages open from the start):
    `d-dark-early` (lap 3), `d-dark-mid` and `d-light-mid` (lap 20, SAR → ZHO 78%, as Figure 4 says), `m-dark-mid`
    (lap 20, 390×844), `d-dark-finished` (lap 56, Replay again and the archive in the strip); each under 240 KB.
  - **Proofs:**

    | Proof | Result |
    |---|---|
    | Web (`make web-test`) | lint and typecheck clean; Vitest 593 passed (29 files) |
    | Contrast (`contrast-report.mjs --check`) | all pairs meet AA |
    | Sample e2e (`make api-up REPLAY=1`, `make web-up`, `E2E_NO_SERVER=1 npx playwright test`) | 55 passed, 1 skipped (latency, by design) |
    | Full lake (`make api-up FULL=1 REPLAY=1`; `race-layout` + `step5`) | 18 passed; CLS outside the tower rows 0.0000 (dark) and 0.0014 (light) |
    | Docs (`test_repo_docs.py`), traceability | 17 passed; OK 522, GENERATED 2 |
    | `make report-pdf` | 22 pages; `final_report.pdf` byte-identical (sha256 checked) |
    | `git status --short results/ data/` | empty |

    The first sample run had 2 failures (`smoke`, `replay-controls`): an earlier spec's stopped run put the strip in
    the over phase, where those tests expected Start replay; fixed in the tests as above, then the whole suite was
    rerun.
- v1.0.1 (2026-11-21, on `main`; not committed): the replay transport's follow-ups, then the release entry.
  - **The call, finished:** only "Race ended at lap N. The live call stops at the chequered flag."; its archive
    button and the "not built yet" note are gone, because the strip's transport offers the archive (once on the page).
  - **Screenshots retaken** (`docs/design/after/`, 10× replays of 2024 R5, each under 230 KB): `d-dark-finished`
    (lap 56, Replay again and the archive in the strip, the call one line); `d-dark-engineer` (focus RIC, strip lap
    21, data to lap 20: HAM ahead, TSU behind, as the README caption says); `d-dark-latejoin` and `m-dark-latejoin`
    (pages joined at lap 45 until the call read "order changed since": ALB → OCO 48%, flagged at lap 33, as report
    Figure 5 says); `d-dark-sample-smoke` (sample lake and model, lap 15: SYNTHETIC DEMO DATA and SMOKE TEST, the
    strip on one line). Captions checked; none needed a change. `report.pdf` rebuilt (22 pages);
    `final_report.pdf` identical to HEAD.
  - **Proofs:** `make up-full`, `make api-up FULL=1 REPLAY=1`, `make web-up` (replay guard, no FORCE); sample mode
    (`make api-up REPLAY=1`): `replay-transport`, `replay-controls` and `smoke` specs, 19 passed. Replays started for
    the shots were stopped through the API or finished; the api ends on `make api-up FULL=1 REPLAY=1`.
  - **Release:** `CHANGELOG.md` 1.0.1; the project version is 1.0.1 in `pyproject.toml`, `uv.lock`,
    `src/f1sa/__init__.py`, `web/package.json` and `web/package-lock.json` (its root entries only), as
    `test_repo_docs.py` requires. The Jolpica user agent (`config.py`, `.env.example`) keeps "1.0.0": it names the
    ingest client, not the release.
  - **Local only:** `web/AGENTS.md` unstaged and listed in `.git/info/exclude`.
- Full-season coverage (2026-11-22): the archive now covers every race of 2021–2025; telemetry traces assessed only.
  - **Coverage audit** (read-only; an `hdfs dfs -ls` of every clean, feature and archive partition against the 114
    races of `clean/races`, plus the what-if tyre model's race list):
    - Complete for all 114 races: the clean core tables (races, results, laps, stints, drivers, constructors,
      qualifying), the TracingInsights clean tables (stints_tracinginsights, race_control, race_control_track_status,
      telemetry_lap_real, compound_coverage), entrants, the analysis tables (race, laps, stints, race_control), the
      feature tables the replay and the what-if read (pit_loss, outlap_features, gaps, laps_enriched, stints,
      race_summary, team_outlap_history) and the what-if tyre model.
    - 2021 R12 (Spa) has no rows in clean/pitstops, clean/analysis_pitstops, features/undercut_attempts or
      features/lap_time_distribution. That is by design, not a gap: the race had no green-flag racing and no pit stops.
    - Gaps: archive bundles 90/114 (no 2025) and telemetry traces 24/114 (2024 only).
  - **2025 archive bundles:**
    - 24 built, 0 failed, in 1 min 15 s, with the deployed model `deploy_real_G3.5_k2` (the same scorer sha256 as
      the 90 bundles of 2021–2024); 44,061,084 B JSON → 4,339,724 B gzip (4.34 MB), 136,127–229,401 B per race.
    - Only `/f1/archive` grew (96 → 121 directories, 180 → 228 files). `/f1/raw`, `/f1/clean` and `/f1/features`
      have the same counts, and `results/` (154 files) and `data/manifest*.json` the same sha256, as before.
    - At that time no make target could pass the test-season flag. The build therefore ran the builder's documented
      command, `python -m f1sa.archive.build --source lake --season 2025 --allow-test-season`, in the app container
      with the Makefile's `ARCHIVE_EXEC` environment (git sha `20afe99`, clean tree).
    - `make archive-full` and `make archive-equivalence` now take `TEST_SEASON=1`, which adds
      `--allow-test-season`. The default command lines are unchanged (`tests/unit/test_makefile_archive.py`).
      The same build is now `make archive-full TEST_SEASON=1 ARCHIVE_SEASON=2025`.
  - **API checks** (`make api-up FULL=1 REPLAY=1 TEST_SEASON=1`):
    - `GET /api/archive` lists 114 races (22, 22, 22, 24, 24), all scored by `deploy_real_G3.5_k2`.
    - `GET /api/archive/2025/5` returns 200 (gzip, 148,076 B) with `ETag` equal to the manifest sha256
      (`cd1255e5…`), and 304 on `If-None-Match`.
    - `GET /api/races` lists 114 races; without `TEST_SEASON=1` it lists the 90 of 2021–2024.
  - **Equivalence, 2025 R5 at laps 10, 30 and 50:** EQUIVALENT.
    - Rebuild identical.
    - Stream parity equal: 126 alerts (95 new_candidate, 25 probability_crossed, 6 attempt), 401 decisions,
      401 eligible pairs, 3 labelled attempts.
    - The live replay's Redis equals the bundle at laps 10 and 30 and after `session_end`, and every message is equal
      (897 lap, 19 pit_in, 19 pit_out, 126 undercut_alert, 1 session_end).
    - The equivalence report counts alerts by their `trigger` field, so the 6 attempt alerts appear there as
      `pit_in`. That is their trigger (the attacker of a candidate pair pitted), not the 19 pit-in events.
    - It ran as `python -m f1sa.archive.equivalence … --allow-test-season` before the make passthrough existed. It
      wrote only the race's Redis keys (TTL), `data/demo/<run_id>/` and a `data/checkpoints/demo_*` checkpoint.
  - **Telemetry traces for other seasons: not done.**
    - Why: the ingest kept raw telemetry samples for 2024 only (`DEFAULT_RAW_TELEMETRY_SEASONS = (2024,)`). The
      other seasons were aggregated and their samples discarded, so there is nothing to resample.
    - Re-download needed: the TracingInsights per-lap telemetry files at the pinned commits, about 98,400 files and
      14.7 GB (`docs/data_source_audit.md`):
      - 2021: 23,757 files, 3.69 GB;
      - 2022: 23,576 files, 3.51 GB (estimate);
      - 2023: 24,422 files, 3.49 GB;
      - 2025: 26,692 files, 3.98 GB (estimate).
    - Space: about 7 GB more raw Parquet (2024 keeps 1.8 GB) and about 0.8 GB of traces (2024: 199.5 MB). Free:
      918 GB on HDFS, 919 GB on the datanode volume and 945 GB on the host.
    - Time: about 3 h to download and aggregate (114 s per race at the 2024 R5 gate, 90 races), plus about 20 min of
      trace builds (4 min 41 s per season).
    - Code to change:
      - `ingest/tracinginsights_loader.py`: the kept-seasons default;
      - `ingest/manifest.py` `should_run`: it skips items already done, so the telemetry items need a redo path,
        and that run rewrites `data/manifest_tracinginsights.json` and the raw aggregates;
      - `lake/schemas_telemetry_trace.py` `SEASON` and `etl/telemetry_trace.py` `parse_season` plus its season
        filters;
      - `api/telemetry.py` (the 404 "available for 2024 only"; 2025 must sit behind `ALLOW_TEST_SEASON`);
      - `web/src/lib/telemetry.ts` (`TELEMETRY_SEASON`, `ONLY_2024_NOTE`, shown in `TelemetryView.tsx`);
      - the Makefile help and the tests of each.
  - **Docs:**
    - `report.md` §4.2, §10 and Appendix A (A88, A89); `report.pdf` rebuilt; `final_report.md` and
      `final_report.pdf` unchanged.
    - `architecture.md` and `data_dictionary.md` ("Post-race archive").
    - `getting-started.md` (the `TEST_SEASON=1` option).
- 2026-11-22: `final_report.md` wording pass; `final_report.pdf` re-rendered with `make final-report-pdf`
  (still 8 pages, course format unchanged).
  - Every abbreviation is expanded at its first body use, among them Formula 1 (F1), HDFS, RDD, MLlib, TTL,
    Pub/Sub, LR, GBT, PR-AUC, ROC-AUC, Brier score, ECE, F1-score, Platt scaling, κ, race-cluster bootstrap, WSL,
    VM and R5. HttpFS, KRaft and IQR are expanded at their single table or figure use. Common terms are not
    expanded: SQL, API, JSON, CPU.
  - The metric is written "F1-score" everywhere, so "F1" always means Formula 1.
  - No number changed (the digits added are those of the expansions); `tests/unit/test_repo_docs.py` passes.
## Next
- Telemetry traces for 2021–2023 and 2025: a team decision on the re-download (about 14.7 GB, about 3 h;
  see the full-season coverage entry). Nothing is started until then.
- S18B: the demo rehearsal with `docs/demo_script.md` (full lake, then the sample-mode fallback); fill in section 16
  (team contributions) of the report and run `make report-pdf` again. The report and demo script already describe
  the final dashboard (Step 18 final, 2026-11-20).
- The UI redesign is complete (Steps 2–4B). F23 remains: a session-end summary for a page that joined late needs an
  additive API change. It was not done in 4B and needs approval first.
  - F24 API stays declined (revisit only if time allows).
## Known issues
- Telemetry overlays exist for 2024 only: the lake keeps raw telemetry samples for 2024 only. Every other
  per-race feature covers all 114 races of 2021–2025.
- Report §16 team contributions still to be filled in (blocker for submission).
- UI Step 5 (2026-11-19):
  - **Reducer, late join:** for up to one lap after a late join or reconnect, a car's gap to the leader (and in the
    same way its interval) can be the previous lap's value. The leader's crossing came in the snapshot, and
    `applyLap` falls back to the old value. The tower now never shows "Leader" off P1, but a stale non-zero gap
    can remain until the next snapshot. The fix belongs in `lib/reducer.ts` and was out of scope.
  - **Stale Redis state:** a page opened after an API restart shows the stored state as "NOT REPLAYING" with no
    status: the API records track status only for laps it replays.
- Step 18a (2026-11-19):
  - **Report body page count.** `make report-pdf` prints "body N" from a separate render of the body alone, which
    paginates differently from the full document since the figures became full-width (it printed body 21 for a
    21-page PDF whose Appendix A starts on page 19). The real split is 18 + 3 (counted from the Appendix A heading).
  - **Rendering limits.** The PDF's table of contents links to each section but has no page numbers (Chromium
    cannot compute them); PDF bookmarks carry the outline. `make report-pdf` is not run in CI (Chromium), so the
    committed PDF must be re-rendered by hand after any change to `docs/report/report.md`. The tests check the
    Markdown, not that the PDF is current.
  - **Parity wording.** The parity result is "maximum input difference 0.0, maximum probability difference
    3.3e-16" (`docs/architecture.md`), not byte-identical. The report uses the docs' wording.
  - **Screenshots.** The what-if view exists only as a pre-redesign screenshot (`docs/design/before/`,
    2026-11-18), so report Figure 3 still uses it. Every other view has a final shot in `docs/design/after/`
    (retaken in UI Step 5).
- UI redesign Step 4B (2026-11-19):
  - **F23 not done.** A page opened after `session_end` gets no race summary; it needs an API change.
  - **Telemetry legend.** The "similar colours" note uses fixed ΔE floors (15 normal, 8 protan/deutan), with a
    Viénot simulation of protanopia and deuteranopia; tritanopia is not simulated. A and B also always differ by
    dash and width.
  - **Hover readout on positions.** It lists all cars at the lap (up to 20 rows); on a phone it covers much of
    the chart while open. The same values are in "Show table".
- UI redesign Step 4A (2026-11-19):
  - **Picker "Start here":** the card reads `/api/replays` once, when the page loads. A replay started later shows
    after a reload; it is not polled, to keep load off the API.
  - **Archive amber:** the archive's "new" alerts follow the scrubbed lap (alerts from that lap or the one before,
    as on the live page then). On 2024 R5 at lap 30 the newest alerts are from lap 20, so that view has no amber.
  - **Engineer history:** the engineer sparkline shows only the laps the engineer API returns for the pair. A
    longer pair history from before the page opened would need a causal laps endpoint (like F24); it is not built.
- Pinned versions reviewed on 2026-11-19 (no pin changed, freeze): Python 3.12 (security-only until 2028) and
  Java 17 LTS are kept on purpose for stability; newer minor releases exist for PySpark, Kafka, Hadoop and
  FastAPI.
- Freeze checks rc1 (2026-11-19): the clean-clone check left the `f1sa-clone_kafka-data` volume and the
  `f1sa-app:clone` / `f1sa-web:clone` images on the dev host (not removed; no volume removal or prune).
  `docs/reproduce.md` §4 still shows the 2026-11-14 timing table (`make demo` 103 s, before the entrants,
  analysis and archive steps); the README gives both measurements.
- Step 3 alert history (2026-11-19):
  - The history is in memory in the API. An API restart loses it; the restart also stops the API's replays, so
    no live run is affected. A page opened afterwards on the old run's leftover keys gets `[]`, plus the Step 2c
    "No alerts since you opened" text and the flagged-now list.
  - Runs the API did not start (`make stream-demo`, `make archive-equivalence`) send `recent_alerts: []`.
  - The history is the newest 50, so after a late join in a long race the "N×" counts cover only the alerts
    received.
  - A stopped run's log is dropped by the lap-log sweep: 30 min without messages or use, once another race is
    opened, at most 4 races. From then on its history is `[]`.
  - The "N more below" count ignores the divider's height when the list is scrolled (approximate by under one
    row).
- UI final fixes (2026-11-19):
  - On a phone, after a stop or the finish, the strip's "Open the post-race archive" button takes a third strip
    line, so the call starts at 220 px (188 px while a replay streams). The e2e check runs during a replay.
  - In sample mode, the SYNTHETIC DEMO DATA notice wraps to a second line on a phone once health loads: a
    one-time shift at page load, before anything streams.
  - The reducer's `unknownDrivers` counter is unchanged and still cumulative; only the panel shows the live
    "not yet in a snapshot" count instead.
- UI polish round (2026-11-19):
  - "Stale" is inferred (2 leader laps without a crossing, beyond laps down), not a retirement signal. A car
    that pits for a long repair is marked stale until it crosses again. After a late join under a safety car
    the gap-to-leader estimate of laps down uses the leader's last (slow) lap time and can under-count.
  - The stale car's last `undercut_flag` stays in Redis until `session_end` (the stream does not clear it);
    the view hides it. A server-side clear would change the stream job and needs approval.
  - `e2e/smoke.spec.ts` leaves its 60× replay running when it ends; a later `make web-up` is then refused by the
    replay guard until that replay is stopped (seen in this round; the spec was not changed).
- UI redesign Step 2:
  - SMOKE TEST is inferred from the `sample_` prefix of `model_version` (health does not expose the model's
    `smoke_test` stamp).
  - After a late join the alert feed lists the pairs flagged now, not the alerts sent before the page opened.
  - Line colours are cut to four, validated on all pairs. A lap-times chart with more than four drivers draws
    the rest in neutral, with a dash and an end label.
  - The archive gap chart is neutral (Highlight draws one car in text colour).
  - The pages not yet redesigned (analysis, telemetry, drivers) still read the legacy token aliases. The five
    `side-tab` hits are resolved by Step 4A (2026-11-19): the anti-pattern scan finds nothing and suppresses nothing.
    See docs/design/inventory.md, "Detector findings carried to later steps".
- Feature 7:
  - A pause or a speed change applies before the producer's next event. Events already sent still reach the
    dashboard for up to about 1 s (Kafka and the 500 ms trigger), and longer while the stream job catches up
    (seen live: 4 messages up to 10 s into a pause).
  - The lap shown is the highest lap the producer has sent, which can be a trigger ahead of what the stream job has
    published.
  - A stopped run has no `decisions.jsonl` (the stream job is ended with SIGTERM). Its alerts are on the channel.
  - A stop requested after the producer has sent `session_end`, while the stream job drains, still records
    `stopped`. The `session_end` published then is the real one, not a fake.
  - The pause cap counts the total pause of a run. Its default (1800 s) adds to the stream job's backstop, so an
    orphaned stream job (API process killed hard) could run up to about 2.5 h. With a control file the producer
    exits when orphaned.
  - `make stream-demo` has no controls; only API replays have them.
- Feature 6:
  - Lap 1 starts at the grid slot (TI distance about 5,224 m at 2024 R5), so comparing it with a flying lap at
    the same lap fraction offsets the corners; the view notes it. Its trace time is not the official lap time.
  - TI distance is integrated speed, not the racing line: normalising by lap fraction aligns the finish lines,
    but a corner can sit a few metres apart on two laps.
  - Pit laps include the pit lane, so their slowest corner is the pit-lane speed (flagged, not hidden).
  - The 5 m grid smooths short spikes (samples are about 5 m apart on average, up to 16 m at p95 at top speed).
  - `full_throttle_share` is a share of distance; `telemetry_lap_real.pct_full_throttle` is a share of samples.
  - The sample's telemetry is a SYNTHETIC fixture (only after `make telemetry-trace-sample`); without it, the
    sample shows "no telemetry traces for 2024 R5 in the lake".
  - The compare is computed per request from two cached traces (about 100 KB of JSON, no gzip).
- Feature 5:
  - The live banner is fetched when the leader starts a new lap. In the sample (estimated from lap times) only the
    cars that have crossed by then count, while the archive's `status[]` is computed at the end of lap N, so the two
    can differ on a lap, like Feature 4's snapshot moment. With race control (full mode) only the leader's lap-N
    codes and messages with lap <= N are used, so both agree.
  - Deleted laps (track limits) count for PB / OB, because the deletion is decided after the lap; the official
    timing removes them later.
  - The race-control message shown is the latest *key* message with lap <= N (SC, VSC, red flag, penalty), never
    a message of the lap the leader is on, so it can lag by up to one lap.
  - The sample has no TracingInsights: its sector and speed-trap columns are empty ("no sector data" note) and its
    banner is the estimate (SC and VSC cannot be told apart: "SC / VSC est.").
  - The pinned row is scrolled into view only while the tower is on screen, so a reader elsewhere on the page is
    never moved.
  - Post-race, the banner stays silent like the archive's alert feed.
  - A browser with the old dashboard open against the new api ignores the new fields; the new dashboard reads v1
    bundles with a note.
- Feature 4:
  - The lap-N snapshot is Redis at the end of lap N (your choice). The live SSE `snapshot-N` is taken earlier, at
    the leader's lap-N crossing, so the two moments differ by design.
  - In post-race mode each lap's snapshot follows its messages, so the reducer's diagnostic `unknownDrivers` counter
    counts the lap-1 cars. The end-of-lap state is the same, and the counter is not shown in post-race mode.
  - The controlled live check needs an idle topic: it refuses while an api replay runs, but it cannot see a separate
    `make stream-demo` on the same race.
  - Like any replay, it writes the race's Redis keys (the safety TTL, then 1 h after `session_end`). The sample check
    of 2024 R5 left sample keys that a full-mode dashboard shows for that race until they expire.
  - `data/lake/archive` holds the bundles of whichever builder ran last: `make archive-sample` uses the api's model,
    `make demo` the sample model. The bundle's meta names its model.
  - Markers are laid out in rows so they never overlap. In a lane with many events (alerts at 375 px) the lane
    grows by rows instead.
- Feature 2: the degradation slope is a lap-time proxy (fuel burn-off and track evolution are in it), stated in the
  UI; the sample's tyre data is synthetic (labelled).
- Feature 1: `drivers.permanent_number` in the clean zone is today's season-table number and wrong for history.
  The entrants dimension uses `car_number`. The clean table itself is unchanged.
- Step 17 follow-up: the replay's compound is the TracingInsights stint label. It is built from all of the stint's
  per-lap labels, so a later conflicting label nulls the whole stint. It is display only and not the strict
  laps <= L-1 rule of the model's `*_compound_ti` inputs. (The assumed-new tyre age next to it is resolved:
  the dashboard shows the real tyre life from the additive tyre hash.)
- Step 17 follow-up 2: the driver hash's `tyre_age_laps` and the event `tyre_age` remain the inferred
  (assumed-new) model age by design. Only the dashboard shows the real life. Sample mode has no real value, so
  it shows its synthetic age as `est.`.
- Fix C (2026-11-15): UI latency samples now default to `data/demo/ui_latency/ui_latency.csv`.
  - `make api-up` always passes its own value, so the default wins there.
  - A local `.env` (not read) that sets both `ENABLE_DEBUG=1` and `API_UI_LATENCY_CSV=results/...` would still
    apply to a plain `make up` / `up-full`. The api then refuses to start while that results file exists.
- Step 17: the sample deployment model is degenerate by design: 4 training attempts, 1 validation attempt, identity
  calibration. Its probabilities in the demo are plumbing, not findings.
- Step 17: the CI `e2e` job has not run on GitHub yet. The app image is about 7 GB, so the job frees runner disk
  first. Its time on a hosted runner is unmeasured.
- Step 17: the clean-clone time (357 s) had warm base images and warm uv, npm and Playwright caches on the host. A
  first run on a new machine adds the downloads.
- Step 17: `make up-full` after the clone check rebuilt `f1sa-app:dev` and `f1sa-web:dev` (`--build` after the
  no-cache build refreshed the layer cache). The previous image IDs are gone. Volumes and data are unaffected.
- Step 17: the app container logs `netlib-blas: dlopen(libblas.so.3) failed` during MLlib training (pure-JVM BLAS
  fallback; harmless).
- Step 16: the streaming runs show latency at replay rates of at most about 13 events/s. The pipeline's
  maximum throughput was not load-tested.
- Step 16: the UI segment comes from one headless Chromium on the same host. Its samples are a subset by
  design (at most 50 in flight; none were dropped at 60x). Alerts and `session_end` cannot be joined to the
  harness by `event_id`.
- Step 16: in `make experiments`, the what-if PNG always differs from the committed one, because without RECORD
  it has no 2025 row. The CSV is compared without the 2025 rows.
- Step 16: the window run (1x, 900 s) has no `session_end`, so its race keys keep only the safety TTL. The job
  is stopped with SIGINT, which logs a KeyboardInterrupt traceback.
- Step 10: the 20 recorded ok build cells (telemetry cells do not use the filter) were timed with the old
  OR-chain filter, the two re-run cells with the flat `IN` (about 10 s per run faster at 96 races), so the re-run
  points are comparable only with each other. A full re-run of the grid was not done (hours).
- Step 10: four local-mode cells at the largest sizes (`s1_x16_local4`, `s5_x4_local1/2/4`) have no timing
  (`aborted_memory_guard`, 5.44-5.56 GiB). The two completed cluster cells each lost an executor to a heartbeat
  timeout (Spark recovered), so their medians may include recovery time. `build_s1_x16_cluster` had only 0.2 GiB
  of margin in the app container and the lowest host `MemAvailable` was 1.51 GiB (guard 1.5 GiB).
- Step 15: the ordering check fails in the far tail (opening car, 5 s gap). One more simulated lap adds variance,
  so a small P can rise while the mean gap falls. The pre-registered rule compares P, not the mean gap, and was
  kept (user decision); the post-hoc expected-gap sign is reported alongside it.
- Step 15: the tyre target is relative to each driver's race median, so per-driver offsets stay in the residual
  SD. The noise prior (about 1 s) is larger than real lap-to-lap noise; live states shrink it with the driver's
  own laps (n0 = 3).
- Step 15: traffic is third cars only, projected without stops; A and D are not traffic for each other.
- Step 15: the lap log starts when a replay starts through the API, a dashboard connects or the first what-if
  arrives. Pub/Sub has no history, so a what-if after a mid-race connect has fewer laps (`history: none` and a
  warning when there are none).
- Step 15: the model P shown next to the simulator is the stream's latest evaluated decision for the attacker,
  which may be one lap behind lap C. The new compound after a stop follows a fixed rule (S->M, M->H, H->M).
- Step 10: the grid estimate is an affine fit through two points (x1, x4 at local[4]) applied to every
  master. Costs that grow faster than the rows (single-partition prior windows, many small partitions,
  spills) are not in it, and single-run smoke times vary by about 20 % (local[1] x1: 52.7, 40.1, 44.5 s).
- Step 10: the build at x1 is overhead-dominated (about 25 s fixed per run): local[4] is only 1.3x faster
  than local[1]. Per-core scaling shows only at larger factors.
- Step 10: `docker stats --no-stream` takes 1-2 s per call, so container peaks are 2 s samples and can
  miss short spikes. The in-container sampler (0.5 s) is the finer one.
- Step 10: `input_bytes` is what Spark reports: reads from a cached DataFrame count as input, and file://
  and hdfs:// readers report differently. Compare bytes within one file system and variant.
- Step 10: if the host script dies, `docker compose exec` may leave the grid running in the container.
  A `RESUME=` while it still runs is refused ("another grid is running", flock on the run folder);
  stop it (`docker compose exec app pkill -f f1sa.bench.grid`) or let it finish. Cells orphaned by a
  hard-killed grid are killed by the resume itself.
- Step 14: ESLint 9.39.5 is marked "no longer supported" by npm. ESLint 10 cannot be used until
  `eslint-plugin-react`, `-jsx-a11y` and `-import` (pulled in by `eslint-config-next` 16.4.5) accept it. It
  is a lint-time tool only.
- Step 14: the gap chart shows only laps received since the page connected (Pub/Sub has no history). After
  a reload in mid-race the chart starts at the current lap and fills from there.
- Step 14: `NEXT_PUBLIC_API_URL` is inlined at build time, so pointing the container at another API means
  rebuilding the `web` image. Other dashboard origins must be added to `API_CORS_ORIGINS`.
- Step 14 follow-up: the replay control still polls `GET /api/replays` (1 s while running, 5 s otherwise),
  because replay status (starting/failed) is not on the race channel. The race state itself is never
  polled.
- Step 14 follow-up (order changed by Fix D: the snapshot now precedes the lap's first frame): a snapshot is taken around the leader's lap event. Redis keeps changing during
  the lap (later cars' batches), so the UI is exact at each snapshot and event-driven in between (measured
  UI = Redis on 26/27 laps when read right after).
- 2026-11-12: Docker Desktop's host port forwards for Redis (6379) and Kafka (9092) broke after a failed
  re-expose of port 3000 ("/forwards/expose returned unexpected status: 500"). TCP connects but the
  protocol is reset; containers reach both over the compose network. Host-side integration tests need
  the forwards back: restart the redis and kafka containers or Docker Desktop.
- Step 14: three-letter codes come from the surname in the Jolpica id (`max_verstappen` gives VER), not
  from the official codes, so a few differ (`mick_schumacher` gives SCH, officially MSC).
- Step 14: the web image is about 400 MB (the Debian slim Node base); a distroless runtime could shrink it.
- Step 13 follow-up: a replay of 2025 needs `make api-up TEST_SEASON=1`. The demo script
  (`make stream-demo`) still has no `--allow-test-season` (unchanged `streaming/demo.py`).
- Step 13 follow-up: a replay peaks at about 1.5 GiB (two JVMs) of the api container's 2 GiB. An OOM kill
  would take the API process down with it.
- Step 13 follow-up: demo outputs and replay checkpoints build up until `make demo-clean CONFIRM=yes`, which
  must not be run during a demo or a replay.
- Step 13: Pub/Sub has no history. An SSE client sees only events published after it subscribed;
  `Last-Event-ID` is ignored, and a reconnecting dashboard must reload `/state`. A client that connects after
  `session_end` gets heartbeats until it disconnects.
- Step 13: with ASGI spec ≥ 2.4 (uvicorn), a client disconnect is noticed at the next write, so the
  subscription can outlive the client by up to one heartbeat (15 s).
- Step 13: a replay only feeds Kafka. The dashboard sees changes only while a stream job runs
  (`make stream-demo` starts its own producer, so it does not use the API replay).
- Step 13: the latency join and the duplicate check live in the memory of one API process (the last
  10,000 events). After a restart, earlier event ids give 404. Run a single uvicorn worker.
- Step 13: memory limits for the full profile now add up to about 10 GiB. Until WSL is raised to 14 GB they
  exceed the ~9 GiB VM (limits are ceilings, not reservations).
- Step 13: the shutdown path that terminates a running replay is tested in unit tests only. The container
  logs of the recreate that exercised it live were replaced by the new container.
- Step 12: `track_neutral`, `track_red_flag` and `race_laps` on the lap events are hindsight values (whole-race
  heuristic, winner's lap count); live they would come from race control and the scheduled distance.
- Step 12: `redis_written_at_ms` is the client time just before the batch's single pipeline is sent (a PUBLISH
  in the pipeline cannot carry its completion time); the write duration is in `results/stream_batches.jsonl`.
  The first batch of a race also loads its priors (Spark), so p99 latency includes ~2-3 s once per race.
- Step 12: a car awaited by a decision (lapped car, or a missing car ahead) counts as retired after 2 leader
  lap times; driver state survives restarts only through `driver_state/state.json` in the same checkpoint.
- Redis latency varies from run to run on this WSL2 / Docker Desktop host.
  - An earlier run in the same session met every schedule: 60.00/s with 0 late ticks; write p99 3.0 ms at 60/s,
    HGETALL p99 0.84 ms.
  - That run was discarded only because its redis-cli step covered 1 s instead of 30. Its redis-py numbers were
    valid.
  - The recorded run fell behind at 60/s: 51.09/s achieved, 2876 late ticks, write p99 19.8 ms. It also had
    p99 outliers at 10/s.
  - The full profile (HDFS and Spark) was running during both runs. Report the S16 number from a core-only
    run, with the variance stated.
- The benchmark is a single-client, sequential loop: write, then reads, in one thread. At 60/s each tick spends
  about 5.5 ms (first run) to 11.4 ms (recorded run) at the medians on its 22 round trips, out of a 16.7 ms
  period. Latency spikes therefore make ticks late, and the achieved rate measures the client loop as well as
  Redis.
- `redis-cli --latency` measures inside the container, so it is a floor with no host or Docker network hop.
  The redis-py numbers include the Docker Desktop port forward.
- The v2 selection rule says "calibrated LR", but the LOSO rows it was applied to are raw LR at the first grid
  point (no per-fold calibrator). PR-AUC is unchanged by a strictly increasing calibration map. Disclosed in
  `docs/model_spec_v2.md` §2.
- The v2 playbook (12 Nov 2026) that states the selection rule was removed from the tree on 2026-11-20. The spec
  cites it; it is kept, unchanged, at the git tag `model-spec-v2` (`git show model-spec-v2:docs/planning/playbook_v2.md`).
- GBT is sensitive to row order. Fixing the order of the TracingInsights sets moved `real_ti` GBT validation
  PR-AUC by 0.043 at G=3.5, which is larger than the gaps between some feature sets in the tables. `real` is
  reproducible run to run (its plan gives a stable order), but its GBT numbers also hold for one row order only.
  Worth noting before any model is chosen from GBT validation numbers.
- LOSO in the comparison tables uses raw scores at the fixed first grid point (as in Step 9b), not the calibrated
  models of the validation columns.
- `real_ti`: every TracingInsights input is present on every labelled attempt in 2021-2024, so its `_missing`
  columns are constant 0 in development. The fill path is exercised only by the unit tests. 2025 attempt-level
  missing rates are unknown until the spec v2 test run (`results/missing_rates_*_G*.csv`).
- The categorical missing indicator is named `__unknown`, not `_missing`. Renaming it would change `real`'s
  columns and the deployed `scorer.json`.
- TracingInsights (Step 4C):
  - Two races are below 95% compound coverage outside 2025: 2021 R12 (Belgium, 3 laps behind the SC, every
    compound UNKNOWN) and 2022 R11 (Austria, 77.4%). In 2025, 2 races are below 95%: R6 Miami (55.6%) and R13
    Belgium (93.5%).
  - 190 telemetry laps are `partial` and 1 is `none` (2021 R8) across all seasons.
  - Telemetry aggregation takes per-lap files on the session clock (lap start + time in lap). A sample outside every
    lap window is dropped and counted (`n_samples_outside_window` in the meta).
  - `telemetry_lap_real` has 221 more rows than Jolpica laps (2021-2025). Each is an uncompleted lap with a null TI lap
    time (see "Lap reconciliation" in `docs/data_dictionary.md`). Later feature steps must left-join TI onto Jolpica
    laps.
  - The data are MIT (2021-2024) or Apache-2.0 (2025) licensed as repos only. Neither covers the underlying F1/FOM
    data (see DATA_LICENSES.md).
- The 1,936 old under-replicated blocks remain until the user runs `setrep` (see Next).
- Wet running is excluded as `neutralised` in full mode (compounds are null, so `wet` cannot fire). Kept on
  purpose; the reporting split estimates the share. See `docs/label_definition.md` "Scope notes".
- At L=5 `gap_ahead_change_3l` uses the lap-1 gap (standing start). L=4 is now excluded as `early_lap`.
- The app container does not come back after a Docker Desktop/WSL restart (exit 128, not OOM; seen twice). The
  scratchpad in /tmp is wiped at the same time.
- Sample size is small: 108 labelled training attempts at G=3.5, k=2 (184 at G=5.0, k=3). Development
  validation numbers (49 attempts, 18 races) have wide race-cluster CIs, and 2024 is used for both selection and
  calibration. The ECE bootstrap interval can sit above the point value (resampling duplicates bins).
- LOSO uses raw class-weighted scores, so its Brier and ECE are not comparable with the calibrated validation
  numbers.
- `make test-int` still treats pytest exit 5 (no tests collected) as success. That can only happen now if the
  integration tests are deselected.
- The first `make up` builds the app image, which needs network access (PyPI and Maven Central). Later runs are offline.
- If the host UID is not 1000, set `APP_UID` in `.env` before building, so that files written to data/ and results/
  stay owned by the host user.
- Jolpica still throttles occasionally, even with the corrected limiter (strictly ≤ 4 in any second, ≤ 450 in any hour):
  22 HTTP 429s in 184 requests on the resumed 2021 run, against 63 in about 170 before the fix. All recovered after
  one 5–6 s backoff, and no item failed. Jolpica probably enforces an undocumented short window (its docs say limits
  "will decrease"). If 429s rise on the full run, lower the burst to 2/s or lower `JOLPICA_MAX_PER_HOUR`.
- The hourly request log only knows requests made since it was introduced (it was added in the middle of the
  2021 run).
- FastF1 request counts and load time per race in the estimate are approximations (12 calls, about 60 s). The
  credentialed FastF1 path has still not been run (it needs the user's login).
- Synthetic data is plausible in distribution, not per race (e.g. 2024 R5 VER has a 33-lap SOFT stint, a 5% draw).
  Regeneration is byte-identical with the locked NumPy/pyarrow versions; a different version may change the bytes,
  in which case `make sample-data REBUILD=1` rebuilds the bundle.
- A bulk-ingest process started with the Step 4A code reads the shared request log only at start-up, so it does not
  see requests made later by other processes. Processes started now share the budget fully.
- Without FastF1, `is_sc_lap` and `is_vsc_lap` are null and `is_neutralised_lap` comes from a lap-time heuristic.
  The heuristic misses lap-1 incidents and can flag laps run in heavy rain. It is exact once FastF1 data exists.
- Per-lap telemetry aggregates are averages over samples, not time-weighted (sample spacing is roughly even).
- The FastF1 path is tested only on hand-made Parquet that mimics what the Step 4A writer produces, because real
  FastF1 data needs the user's login.
- Sprint results are not yet a clean table (the raw zone has `sprint_results` on sprint weekends).
- mypy treats `fastf1` and `pandas` as untyped (`ignore_missing_imports`). `pandas-stubs` could be added later.
- DATA_LICENSES.md statements (Jolpica limits, FastF1 F1 TV login requirement since Oct 2026) were taken
  as provided by the team and not re-verified online.
- CI has not yet run on GitHub (validated locally against the GitHub workflow JSON schema only).

- The raw telemetry path is tested only on hand-built fixtures (real FastF1 data needs the F1 TV login).
- Step 6 `team_outlap_history` (SQL, median, green-lap reference) and Step 7 `outlap_features` (mean, clean-lap
  stint reference) are two different out-lap histories by design. S8 should use `outlap_features`.
- Lap timestamps are estimates (a fixed 180 s formation offset, error of about ±1 min). Lap-time distribution
  medians can still include isolated slow laps (2024 R5 max is now 115 s, down from 145 s after the Step 8 heuristic).
- The global prior window has no partition (single-partition sort). That is fine at about 100 races; check it in S10.
- Step 8: the sample undercut counts are tiny and use synthetic compounds. They are smoke-test output, not findings.
- Jolpica has no penalty data. A served 5/10 s penalty looks like a slow stop (flagged, kept), and a drive-through is
  only suspected (a stop more than 2 s below the median, or an incident lap). FastF1 race-control messages are not
  ingested yet.
- Jolpica records pit entries under a red flag (Step 8b), so inferred stints split there. The red-flag lap and the
  3-lap restart period are excluded as neutralised.
- `laps_remaining` uses the winner's lap count as the scheduled distance, which is wrong in shortened races.
- The track-status heuristic still uses the whole race's median. That is fine because it is used only for
  eligibility and exclusion, never as a feature, but it will flag laps in mixed wet/dry races.
- The out-lap residual assumes stationary-time deviations land 1:1 on the out-lap (the line comes before the boxes).
  This is not yet verified per circuit.
- Step 9: the sample run is plumbing only (4 training rows, 1 validation row). Every sample metric is a smoke test,
  and tuning and calibration fall back to defaults. Rehearsal numbers come from GENERATED data.
- The PySpark Python worker daemon prints harmless `BrokenPipeError` tracebacks to stderr when a job stops early
  (e.g. `isEmpty`/`limit` on Python-RDD-backed frames). Results are unaffected.
- `real` excludes compounds and tyre age, so the model cannot use compound effects until FastF1 stints replace the
  synthetic compounds (`with_synthetic` is then allowed in full mode).
- Uncommitted files in `results/` can be deleted by the editor's Source Control "Discard Changes" (it runs
  `git clean -f` on untracked files, irreversibly on WSL). That is how the first 9f `real` results were lost
  (see 9f approval). Commit run outputs right after a run, and never discard changes under `results/`.
  Optionally, in the editor's user settings, enable `git.discardUntrackedChangesToTrash` where a trash exists.
- `tests/conftest.py` fails any pytest session that deletes, overwrites or adds a file in the repo's `results/`
  (stat snapshot at start and end, contents never read). A make target writing `results/` at the same time as
  the tests also trips it: run the tests after the target finishes.

## Verify
`uv sync --all-extras && make lint && make typecheck && make test && make up-full && make test-int && make down`

HDFS sink: `DATA_LAKE_URI=hdfs://namenode:8020/f1 uv run f1sa-ingest season-range --seasons 2021 --sources jolpica --sink hdfs`,
then `docker compose exec namenode hdfs dfs -du -h /f1/raw`.

Features: `make etl-sample && uv run python -m f1sa.features.build --source sample`, then
`uv run pytest tests/unit/test_rdd_jobs.py tests/unit/test_df_jobs.py tests/unit/test_sql_jobs.py tests/unit/test_features_build.py -q`.

Step 7: `uv run pytest tests/unit/test_telemetry_agg.py tests/unit/test_outlap.py tests/unit/test_lineage.py -q`.

Step 8: `make etl-sample && uv run python -m f1sa.features.build --source sample` (twice: same checksums, same
`sha256sum results/undercut_counts_sample.csv`), then
`uv run pytest tests/unit/test_undercut.py tests/unit/test_detector.py tests/unit/test_outlap.py tests/unit/test_etl_helpers.py -q`.

Step 8b (needs `make up-full`): `make pipeline-full` (twice: same checksums, same `sha256sum results/*_full.*`), then
`uv run pytest tests/unit/test_full_report.py tests/unit/test_makefile_full.py tests/unit/test_features_build.py tests/unit/test_lineage.py tests/unit/test_etl_helpers.py tests/unit/test_undercut.py tests/unit/test_neutral_split.py -q`.

Step 9: `make etl-sample && make features-sample && make model-eval-sample`, then
`uv run pytest tests/unit/test_model_dataset.py tests/unit/test_model_pipeline.py tests/unit/test_calibrate.py tests/unit/test_metrics.py tests/unit/test_explain.py -q`.

Step 9c (needs `make up-full`; the app must have the `./models` mount): `make model-save-full` (add `FORCE=1` if
the folder exists), then
`uv run pytest tests/unit/test_model_deploy.py tests/unit/test_lr_scorer.py tests/unit/test_makefile_full.py -q`.

Step 4C Phase 2 (needs `make up-full`): `make ingest-ti-full` (resumable; `SKIP_RAW_TELEMETRY=1` skips the 2024 raw
samples), then `make etl-ti-full`, then `make test-ti` and
`docker compose exec namenode hdfs dfs -stat %r /f1/clean/stints_tracinginsights/season=2024/round=5/*` (expect 1).

Step 4C wrap-up (needs `make up-full`): `make reconcile-ti-full` (read-only, expect `result: PASS`), then `make test-ti`.

Step 4C → model (needs `make up-full`): `make model-dev-tyre-full model-dev-ti-full model-dev-permutation-ti-full`, then `uv run pytest tests/unit/test_permutation_dev.py -q` and
`uv run pytest tests/unit/test_model_ti_inputs.py tests/unit/test_model_pipeline.py tests/unit/test_makefile_full.py -q`.
Determinism: run those three make targets twice and compare `sha256sum` of the 42 files with
`data/dev_ti_tyre_reference.sha` (expect all OK); `make model-dev-full` then `sha256sum -c data/real_dev_committed.sha`.

Step 12 (needs `make up`; `make up-full` for FULL=1 and parity): `make stream-demo SEASON=2024 ROUND=5 SPEED=10`
(add `FULL=1` for HDFS), `make stream-parity-full` (expect `mismatching races: 0`), then
`uv run pytest tests/unit/test_stream_parity.py tests/unit/test_live_features.py tests/unit/test_stream_job.py -q`
and `uv run pytest tests/integration/test_streaming.py -q -m integration`.

Step 13: `make test-api` (API tests plus `test_demo_outputs.py`), then
with `make up`: `uv run pytest tests/integration/test_api.py -q -m integration`, `curl -s localhost:8000/api/health`,
`curl -s localhost:8000/api/races`, and `curl -N localhost:8000/api/races/2024/5/events` during
`make stream-demo SEASON=2024 ROUND=5 SPEED=60` (writes `data/demo/<run_id>/`; `results/` unchanged). Full lake:
`make api-up FULL=1 REPLAY=1`, POST a replay, then `curl -s localhost:8000/api/replays` until `finished`. On the host:
`make api` (port 8001) and the same curls.

Step 14 (needs `make up`): `make web-test`, then `make api-up REPLAY=1`, then either `docker compose stop web && make web-e2e`
or `cd web && E2E_NO_SERVER=1 npx playwright test` against the container, and finally `git status --short results/` (expect
empty). Python: `uv run pytest tests/unit/test_api_races.py tests/unit/test_api_health.py tests/unit/test_makefile_web.py -q`.


Step 15: `make sim-tyre-model-sample && make whatif-consistency-sample`, then
`uv run pytest tests/unit/test_sim_tyre_model.py tests/unit/test_race_sim.py tests/unit/test_whatif.py tests/unit/test_lap_log.py tests/unit/test_api_whatif.py tests/unit/test_sim_consistency.py tests/unit/test_makefile_sim.py -q`
and `make web-test`. Full lake (needs `make up-full`): `make sim-tyre-model-full && make whatif-consistency-full`.
Live: `ENABLE_REPLAY=1 make api`, then `curl -X POST localhost:8001/api/races/2024/5/whatif -H 'content-type: application/json' -d '{"attacker":"<P4>","defender":"<P3>"}'` during a replay.

Step 17: `uv run pytest tests/unit/test_demo_replay.py tests/unit/test_makefile_demo.py tests/unit/test_check_traceability.py tests/unit/test_ci_workflow.py tests/unit/test_repo_docs.py tests/unit/test_model_deploy.py tests/unit/test_api_replay.py -q`
(or `make test-demo`), `uv run python scripts/check_traceability.py` (expect MISSING 0), then with `make up`:
`make sample-data && make demo` (prints the dashboard URL) and `cd web && E2E_NO_SERVER=1 npx playwright test e2e/smoke.spec.ts`.
Clean clone: `docs/reproduce.md` §4.

Step 16: `uv run pytest tests/unit/test_ablation.py tests/unit/test_oracle_dev.py tests/unit/test_experiments_runner.py tests/unit/test_streaming_runs.py tests/unit/test_demo.py tests/unit/test_latency.py tests/unit/test_latency_bench.py tests/unit/test_model_test_summary.py tests/unit/test_makefile_api.py -q`;
`make experiments-sample` (expect exit 0); with `make up-full`: `make experiments` (expect 66 OK, the 2 what-if DIFFs).
Measurements (core profile only): `make stream-latency-suite`, `make redis-latency` (no RECORD: data/ only).

Feature 6: `uv run pytest tests/unit/test_telemetry_resample.py tests/unit/test_telemetry_trace.py tests/unit/test_synthetic_telemetry.py tests/unit/test_telemetry_compare.py tests/unit/test_api_telemetry.py tests/unit/test_keys.py -q`;
`cd web && npx vitest run tests/telemetry.test.ts`; sample: `make etl-sample analysis-sample telemetry-trace-sample`, then
`make api-up REPLAY=1` and `make web-e2e`; full (needs `make up-full`, `make analysis-full`): `make telemetry-trace-full`
(writes only /f1/clean/telemetry_trace; expect 26,604 laps, 2 without a trace, unmapped 0).

Feature 7: `uv run pytest tests/unit/test_producer.py tests/unit/test_api_replay.py tests/unit/test_api_replay_controls.py tests/unit/test_redis_store.py tests/unit/test_stream_job.py tests/unit/test_replay_guard.py tests/unit/test_demo_replay.py tests/unit/test_control_check.py tests/unit/test_api_app.py tests/unit/test_makefile_api.py -q`;
`cd web && npx vitest run tests/replays.test.ts`; with `make api-up REPLAY=1` (sample): `make replay-control-check SEASON=2024 ROUND=5
EXPECT_TRIGGERS=113,19,9 EXPECT_DECISIONS=409` (expect EQUIVALENT), `make archive-equivalence SEASON=2024 ROUND=5 LAPS=5,22,45`,
then `docker compose stop web && make web-e2e`.

F37 fix: `cd web && npm run lint && npm run typecheck && npx vitest run tests/reducer.test.ts tests/f37.test.ts tests/archive.test.ts`.

## 9f approval
- 2026-11-13: label-definition-v1, model-spec-v1 and model-spec-v2 approved for the single 2025 test run by Parinith D. on behalf of the team (Data Wranglers). No further sign-off required.
- 2026-11-12 21:02 UTC: first 9f attempt aborted. The app container went down overnight mid-run. No results files were written and no 2025 test numbers were seen. The partial model folder is kept as models/undercut/_aborted_20261112T2102Z_full_real_G3.5_k2 and its log as data/test_run_aborted_20261112.log (both gitignored). Rerun allowed under the rerun rule (crash with no test number seen).
- 2026-11-13: 9f bug in the test run, fixed before anyone viewed the `real` test results.
  - What happened: `make model-test-full CONFIRM=yes` completed the two `real` runs. Then the first
    ablation run (`--source full --allow-test-season --feature-set real_tyre`) stopped with "TracingInsights
    inputs need explicit races or seasons".
  - Where: inside `pipeline.load_frame`, **before any `real_tyre`/`real_ti` data was read, and before any
    training or evaluation**. No `real_tyre`/`real_ti` test files exist (checked by file name only).
  - Root cause: test mode sent the TracingInsights sets to `dataset.load_attempts(races=None, ti_root)`,
    which refuses TracingInsights inputs without races. The dev path (`--no-test`) calls
    `load_attempts_for_seasons` with explicit seasons, so it never hit this.
  - Fix (plumbing only, `src/f1sa/model/pipeline.py`):
    - test mode with a TracingInsights set now calls the dev path's loader (`load_attempts_for_seasons`,
      through the shared `_load_seasons`) for the seasons of the frozen split;
    - that split is `pipeline.TEST_SPLIT = SplitSpec()`: train 2021-2023, validation 2024, test 2025, the
      split `build_dataset(split=None)` already uses.
  - Unchanged: the `real` path (still `load_attempts(features, None, None)`), features, models, grids,
    calibration, threshold, metrics, `scorer.json` and every spec doc.
  - Tests (`tests/unit/test_model_pipeline.py`):
    - `test_test_mode_ti_sets_load_tracinginsights_for_the_frozen_split[real_tyre|real_ti]` checks that
      the TracingInsights loader receives seasons 2021-2025 and nothing raises. It fails on the old code
      at the same call.
    - `test_test_mode_real_path_is_unchanged` and `test_test_split_is_the_frozen_split`.
  - The existing tests confirm that `make model-test-full CONFIRM=yes FEATURE_SET=real_tyre` runs only
    `real_tyre` at both settings (`make -n`), that its own files block a rerun, and that the `real` files
    neither block it nor change.
  - Dev outputs are byte-identical: `make model-dev-tyre-full model-dev-ti-full` (2021-2024 only), then
    `sha256sum -c data/dev_ti_tyre_reference.sha` gave 42/42 OK.
  - No `--allow-test-season` command was run, and no protected test-run file was opened, read or hashed.
    The `real_tyre`/`real_ti` test runs are for the user to start.
- 2026-11-13: 9f `real` results files (results/*_G3.5_k2.*, *_G5.0_k3.*) from the 04:38 UTC run were deleted from the working tree before being committed (cause under investigation; not a user command). Nobody had viewed them. The saved models and metadata survived (kept as models/undercut/_lostresults_20261113T043[89]Z_full_real_*). The `real` runs were regenerated with the same frozen code; the new metadata.json files and the filtered console output are IDENTICAL to the first run (checked key by key and line by line without printing values). The regenerated files are therefore the first run's results; committed in b6aae52. Ablation results (real_tyre, real_ti) were not affected and were committed separately.
- 2026-11-13: cause of the lost 9f `real` results found; it was not repo code, a test or a make target.
  - Evidence: the editor's git log (`~/.vscode-server/data/logs/20261113T043245/exthost1/vscode.git/Git.log`, line 146)
    has `2026-11-13 04:51:21.551 [info] > git clean -f -q -- results/calibration_G3.5_k2.csv ... results/reliability_G5.0_k3.png`,
    exactly the 12 lost files. This is the command the Source Control view runs for "Discard Changes" on untracked
    files (after a confirmation dialog). `remoteagent.log` logs a watched path deleted at 04:51:21.655.
  - Why only those files: at 04:51:21 they were the only untracked files and no tracked file was modified;
    `models/` is gitignored, so `git clean` (without `-x`) left `models/undercut/full_real_*`; the `real_tyre`/`real_ti`
    files did not exist yet (written 05:23-05:28).
  - Ruled out: the bug-fix session ran no delete (its 04:51:15 `git status` still listed the 12 files); every writer
    in `src/`/`experiments/` uses `check_results_dir` and tmp+replace on its own names; the only deleter
    (`demo_runs.clean`) is pinned to `./data/demo` and `./data/checkpoints`; every test and module fixture works in a
    tmp dir; no Makefile recipe deletes, moves or cleans; `git fsck` shows no dropped stash from 11-13.
  - The earlier line "cause under investigation; not a user command" is corrected by this one: it was an editor action.
  - Safeguards added (tests only; no pipeline, label, Redis or layout change): the session-wide results guard in
    `tests/conftest.py` (`tests/_results_guard.py`), and `tests/unit/test_results_untouched.py`, which runs the six
    test-mode commands (refused, nothing touched) and the `real_tyre`/`real_ti` dev runs (only their own files
    change) against a placeholder copy of `results/`, and checks that no Makefile recipe or window target deletes or moves.
- 2026-11-13: 9f 2025 summary written: `results/model_test_summary.csv` and `docs/model_results.md`.
  - Copied from the committed test-run outputs (`model_eval*_G*_k*.csv`, `missing_rates_*`). Nothing was
    retrained, rerun or re-evaluated. Baselines were checked identical across the three feature-set files.
  - Primary (`real` calibrated LR, G=3.5 k=2): PR-AUC 0.670 [0.421, 0.898] vs rule 0.513 [0.246, 0.799];
    Brier 0.177 vs 0.273. The point estimates favour the primary model on every metric, all intervals overlap,
    and no significance claim is made.
  - Open (spec v2 §4): paired race-cluster bootstrap intervals for the feature-set differences are not in any
    committed output (no per-attempt test scores are saved). They need a separate, agreed step; until then no
    ablation difference is interpreted.
- 2026-11-13: the 9f summary is reproducible: `make model-test-summary` (`experiments/model_test_summary.py`,
  logic in `src/f1sa/model/test_summary.py`, tests in `tests/unit/test_model_test_summary.py`).
  - It reads only the six committed `results/model_eval*_G*_k*.csv` files (refuses with exit 2 if one is
    untracked or differs from HEAD). It writes `results/model_test_summary.csv` and the body of the `## Results`
    section of `docs/model_results.md`, and leaves the rest of the doc as it is.
  - Rerun on the committed inputs: both outputs were byte-identical to the hand-run versions (sha256 `57a8e546…`
    for the CSV, `39ecd4b8…` for the doc), and identical again on a second run.
  - Decision: the paired ablation intervals (`docs/model_spec_v2.md` §4) are deferred to Step 16. They will be
    computed from the saved frozen test-run models, after an exact-match check against the committed model_eval
    metrics (see Next). Until then no ablation difference is interpreted.
