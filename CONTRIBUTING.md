# Contributing

Thanks for working on F1 Strategy Analytics at Scale. This page covers setup, the checks every change must pass,
how to write commits, and the few rules that protect the recorded results.

## Prerequisites

Install Docker, GNU `make`, `python3`, [`uv`](https://docs.astral.sh/uv/) and Node.js 26 (`web/.nvmrc`). Follow
[docs/getting-started.md](docs/getting-started.md) to run the sample demo once. Host-specific details for
Windows 11 + WSL 2, Linux and macOS are in [docs/reproduce.md](docs/reproduce.md#prerequisites).

```bash
make setup                 # Python 3.12 dependencies, with the dev extras, into .venv
cd web && npm ci && cd ..  # dashboard dependencies
```

## Development commands

| Command | What it checks |
|---|---|
| `make lint` | Ruff lint and format check on `src`, `tests`, `experiments` and `scripts` |
| `make typecheck` | mypy (strict) on `src` and `scripts/check_traceability.py` |
| `make test` | Python unit tests (Java 17 is needed on the host for the Spark tests) |
| `make web-test` | Dashboard ESLint, TypeScript and Vitest |
| `make web-e2e` | Playwright smoke test of the dashboard (start the API first with `make api-up REPLAY=1`) |
| `uv run python scripts/check_traceability.py` | Every file named in [docs/traceability.md](docs/traceability.md) exists |

The integration tests need the full profile (`make up-full`, then `make test-int`). CI does not run them, so run
them by hand when you change the lake, Kafka, Redis or Spark code. CI (`.github/workflows/ci.yml`) runs the
other checks on every push and pull request.

### Stack commands

Run them from the repository root (on Windows, in the WSL bash shell).

| Command | What it does |
|---|---|
| `uv sync --all-extras` and `cd web && npm ci` | Install the Python and dashboard dependencies |
| `make up` | Start the core stack (Kafka, Redis, app, API, web) and wait until it is healthy |
| `make up-full` | Start the core stack plus HDFS and Spark |
| `make down` | Stop and remove the containers, keeping every volume |
| `uv run pytest tests/unit -q` | All unit tests; one file: `uv run pytest tests/unit/test_keys.py -q` |
| `uv run pytest tests/integration -q -m integration` | Integration tests (the stack must be running) |
| `uv run ruff check src tests && uv run ruff format --check src tests && uv run mypy src` | Lint, format check and types without make |
| `cd web && npm run lint && npm run typecheck && npm test` | Dashboard checks without make |
| `make sample-data && make demo` | The offline sample pipeline end to end |

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/), as the git log does: `type(scope): summary`,
  for example `feat(web): …`, `fix(api): …`, `docs(report): …`, `test(e2e): …`, `ci: …`, `chore: …`.
- Keep each change small and focused on one thing. Add or update unit tests for every public function you touch.
- Update the documentation the change affects, and add an entry to [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice.
- Fill in the checklist in [the pull request template](.github/pull_request_template.md).

## Rules

### Safety

- **Never commit `.env`** or any other secret. Copy `.env.example` to `.env` and keep it local (it is
  gitignored). Never read or print `.env`, `.env.local` or the FastF1 token folders (`~/.fastf1/`,
  `~/.local/share/fastf1/`). Never commit `data/` (except `data/sample/`), caches or model files; no model binary
  over 5 MB is ever committed.
- **Never run `docker compose down -v`.** It deletes the HDFS, Kafka and Redis volumes. Stop the stack with
  `make down`, which keeps them. Do not run `docker volume rm` or `docker system prune` on the project either; the
  only command that deletes the volumes is `make nuke CONFIRM=yes`, and only when that is the intent.
- **Never touch the raw zone or the ingest manifest by hand.** `/f1/raw` (or `raw/` under a `file://` lake) and
  `data/manifest.json` are written only by the ingest targets; never edit, move or delete them. Every other job
  reads the raw zone and never writes it.
- **`results/` is written only by the recording targets** (`RECORD=1`, listed in
  [docs/reproduce.md](docs/reproduce.md#3-every-target-that-writes-results)). Never edit or regenerate a file
  in it by hand.
- **The frozen specifications are never edited:** [docs/label_definition.md](docs/label_definition.md),
  [docs/model_spec.md](docs/model_spec.md), [docs/model_spec_v2.md](docs/model_spec_v2.md) and
  [docs/sim_spec.md](docs/sim_spec.md). They were fixed before the results they describe.
- Never force-push, `git reset --hard` or `git clean -fd` a shared branch.

### Changes that need an issue first

Open an issue before changing the pinned versions, the label definition, the Redis contract or the
repository layout:

- The Redis keys and fields: the exact contract is in
  [docs/architecture.md](docs/architecture.md#redis-serving-servingkeyspy-servingredis_storepy) (Key contract).
- The pinned versions: Python 3.12, PySpark 4.2.1, Java 17, `spark-sql-kafka-0-10_2.13:4.2.1`, Kafka 4.3.x
  (KRaft), Redis 8.10, Hadoop 3.4.3, FastF1 3.9.2, Next.js with TypeScript strict.
- The undercut label ([docs/label_definition.md](docs/label_definition.md)).
- The repository layout.

### Code

- The project proposal is the contract: every requirement in [docs/traceability.md](docs/traceability.md) is
  implemented, and none is dropped silently.
- Write complete, runnable, typed code (mypy-clean): no placeholders, no TODO stubs, no fake results.
- Every public function gets a unit test. Handle errors and edge cases explicitly: races with no lap data, DNFs,
  safety-car laps, lapped cars.
- The storage root comes only from `f1sa.config.Settings.data_lake_uri`; never hardcode a path.
- Keep changes small and scoped, and include the test output in the pull request.
- Record notable changes in [docs/dev/engineering_log.md](docs/dev/engineering_log.md) (Done / Next / Known
  issues).

### Data

- The undercut label is [docs/label_definition.md](docs/label_definition.md). Features use only information
  available at the end of lap L-1.
- The split is chronological: train 2021-2023, validation 2024, test 2025. Calibrate on 2024 only. Never use 2025
  for tuning.
- Jolpica: at most 4 requests/s and 450/h, cached and resumable. FastF1: `Cache.configure()`, authentication
  through the environment, and fail loudly when FastF1 returns no data.
- Sample mode (`data/sample`) is Jolpica data (CC BY-NC-SA) plus SYNTHETIC tyre and telemetry tables
  (`is_synthetic=true`). No other data is committed.

### Environment notes

- On Windows the repository lives in the WSL file system and Docker runs through Docker Desktop's WSL
  integration.
- Spark in the tests runs `local[2]` with `spark.sql.shuffle.partitions=4` (see `tests/conftest.py`).
- FastF1 3.9 returns empty data instead of raising when there is no F1 TV login.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
