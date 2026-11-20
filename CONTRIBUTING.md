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

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/), as the git log does: `type(scope): summary`,
  for example `feat(web): …`, `fix(api): …`, `docs(report): …`, `test(e2e): …`, `ci: …`, `chore: …`.
- Keep each change small and focused on one thing. Add or update unit tests for every public function you touch.
- Update the documentation the change affects, and add an entry to [CHANGELOG.md](CHANGELOG.md) for anything a
  user would notice.
- Fill in the checklist in [the pull request template](.github/pull_request_template.md).

## Rules

- **Never commit `.env`** or any other secret. Copy `.env.example` to `.env` and keep it local (it is
  gitignored). Never commit `data/` (except `data/sample/`), caches or model files.
- **Never run `docker compose down -v`.** It deletes the HDFS, Kafka and Redis volumes. Stop the stack with
  `make down`, which keeps them.
- **`results/` is written only by the recording targets** (`RECORD=1`, listed in
  [docs/reproduce.md](docs/reproduce.md#3-every-target-that-writes-results)). Never edit or regenerate a file
  in it by hand.
- **The frozen specifications are never edited:** [docs/label_definition.md](docs/label_definition.md),
  [docs/model_spec.md](docs/model_spec.md), [docs/model_spec_v2.md](docs/model_spec_v2.md) and
  [docs/sim_spec.md](docs/sim_spec.md). They were fixed before the results they describe.
- The Redis keys and fields ([docs/architecture.md](docs/architecture.md#redis-serving-servingkeyspy-servingredis_storepy))
  and the pinned versions (Python 3.12, PySpark 4.2.1, Java 17, Kafka, Redis, Hadoop, FastF1) change only after
  the maintainers agree.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
