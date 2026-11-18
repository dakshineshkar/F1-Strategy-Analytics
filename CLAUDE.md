# F1 Strategy Analytics at Scale — project memory
IISc MTech big-data project (team Data Wranglers). Event-driven undercut detection + what-if strategy sim.
The proposal is the contract: every item in docs/traceability.md must be implemented. Never drop one silently.

## Commands (run from repo root in WSL bash)
- Setup: `uv sync --all-extras` ; web: `cd web && npm ci`
- Infra: `make up` (core) | `make up-full` (core+hdfs+spark) | `make down` (never `down -v` unless asked)
- Unit tests: `uv run pytest tests/unit -q` ; one file: `uv run pytest tests/unit/test_x.py -q`
- Integration (needs `make up`): `uv run pytest tests/integration -q -m integration`
- Lint/type: `uv run ruff check src tests && uv run ruff format --check src tests && uv run mypy src`
- Web: `cd web && npm run lint && npm run typecheck && npm test`
- Sample pipeline: `make sample-data && make demo`

## Architecture (see docs/architecture.md)
ingest(Jolpica, FastF1) -> raw zone (HDFS or file://) -> clean Parquet partitioned season=/round=
-> Spark RDD/DataFrame/SQL features -> MLlib (GBT + calibration) -> Kafka replay -> Structured Streaming
-> Redis (hash/zset/pubsub, TTL) -> FastAPI SSE -> Next.js dashboard; sim/ = what-if engine.
Storage root is ONLY via `f1sa.config.Settings.data_lake_uri`; never hardcode paths.

## Pinned versions (do not change without asking)
Python 3.12, PySpark 4.2.1, Java 17, spark-sql-kafka-0-10_2.13:4.2.1, Kafka 4.3.x (KRaft), Redis 8.10,
Hadoop 3.4.3, FastF1 3.9.2, Next.js + TypeScript strict.

## Redis contract (exact, tested in tests/unit/test_keys.py)
- HASH race:{season}:{round}:driver:{driverId} fields: position, gap_ahead_s, gap_leader_s, tyre_compound,
  tyre_age_laps, last_lap_time_s, undercut_flag, undercut_prob, updated_at
- ZSET race:{season}:{round}:order member=driverId score=position
- PUBSUB race:{season}:{round}:events (types: lap, pit_in, pit_out, undercut_alert, session_end)
- All race keys get EXPIRE on session_end (REDIS_TTL_AFTER_SESSION_S) + safety TTL on every write.
- ADDITIVE, display only (approved 2026-11-15; the hash, zset and channel above are unchanged):
  HASH race:{season}:{round}:tyre:{driverId} fields: tyre_life_laps, tyre_life_at_start_laps, lap, updated_at
  (real TracingInsights tyre life; same TTL rules; written in the batch's one pipeline; never read by
  the model, the rule, the live features or the what-if). Tested in test_keys.py / test_redis_store.py.
- ADDITIVE API cache, display only (Feature 1, 2026-11-15): STRING meta:entrants:{season}:{round} = JSON of
  GET /api/races/{s}/{r}/entrants tagged with a lake fingerprint, SET EX API_ENTRANTS_CACHE_S; outside race:* (never SCANned by /state or
  expire_race), never touches the driver hash. Tested in test_keys.py / test_api_entrants.py.
- ADDITIVE API cache, display only (Feature 2, 2026-11-16): STRING meta:analysis:{season}:{round}:{view}
  (view = laps|stints|pitstops|race_control|positions) = JSON of GET /api/races/{s}/{r}/analysis/{view} tagged with
  the lake fingerprint, SET EX API_ANALYSIS_CACHE_S; outside race:*, never touches the driver hash; compare has no key.
  Tested in test_keys.py / test_api_analysis.py.
- ADDITIVE, display only (Feature 5, approved 2026-11-18; the hash, zset and channel above are unchanged):
  HASH race:{season}:{round}:timing:{driverId} fields: lap, sector1_s, sector2_s, sector3_s, speed_trap_kph,
  pb_sector1_s, pb_sector2_s, pb_sector3_s, pb_speed_trap_kph, pit_stops, updated_at (the car's latest lap:
  TracingInsights sectors/speed trap, its best so far over laps <= that lap, its stop count); same TTL rules;
  written in the batch's one pipeline; never read by the model, the rule, the live features or the what-if.
  Tested in test_keys.py / test_redis_store.py / test_redis_sink.py / test_stream_parity.py.

## Data rules
- Undercut label = docs/label_definition.md. Features must use info available at end of lap L-1 only.
- Chronological split: train 2021-2023, val 2024, test 2025. Calibrate on 2024 only. Never touch 2025 for tuning.
- Jolpica: <=4 req/s, <=450 req/h, cached, resumable. FastF1: Cache.configure(), auth via env, fail loudly on empty sessions.
- Sample mode (data/sample) is Jolpica CC BY-NC-SA + SYNTHETIC tyre/telemetry (is_synthetic=true). Never commit other data.

## Rules
- Write complete, runnable, typed code (mypy-clean); no placeholders, no TODO stubs, no fake results.
- Every public function gets a unit test; handle errors and edge cases explicitly (empty sessions, DNFs, SC laps, lapped cars).
- Never read or print .env; never commit secrets, data/, caches, model binaries > 5 MB.
- Small, scoped changes; show the test command output as evidence before saying "done".
- STOP and ask before: changing pinned versions, the label definition, the Redis contract, or the repo layout.
- Update docs/PROGRESS.md (Done / Next / Known issues) at the end of each step.

## Gotchas
- Repo lives in WSL filesystem; Docker via Docker Desktop WSL integration.
- Spark in tests uses local[2] with spark.sql.shuffle.partitions=4 (see tests/conftest.py).
- FastF1 3.9 returns empty sessions without F1 TV auth instead of raising.

## graphify (knowledge graph; the /graphify skill is in .claude/skills/graphify/)
- Build or update it with `/graphify . --update` after larger changes.
- Query it before broad searches: `graphify query "<question>"`, `graphify path "<A>" "<B>"`,
  `graphify explain "<concept>"`.
- `graphify-out/` is generated and gitignored; never commit it. The hooks are personal: `.claude/settings.local.json`.
