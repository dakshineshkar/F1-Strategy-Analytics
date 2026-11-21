# Getting started

Install the project, run the sample demo, switch to the full data, and stop everything again. Every experiment
target is in [reproduce.md](reproduce.md). All documents: [docs/README.md](README.md).

## Prerequisites

Needs Docker with 12 GB of memory, GNU `make`, `python3` and [`uv`](https://docs.astral.sh/uv/). Details for
Windows 11 + WSL 2, Linux and macOS: [Prerequisites](reproduce.md#prerequisites).

## Installation

```bash
git clone https://github.com/parinithd-27/F1-Strategy-Analytics.git
cd F1-Strategy-Analytics
make up            # core profile: kafka, redis, app, api, web (builds the images the first time)
```

## Run the demo

```bash
make sample-data   # validates data/sample offline
make demo          # sample pipeline + sample model + a 60x replay of 2024 R5
```

Open http://localhost:3000/race/2024/5 while the replay runs. The demo uses two real Jolpica races with synthetic
tyres and telemetry, so the dashboard shows a **SYNTHETIC DEMO DATA** banner. `make down` stops it.

## Full-data mode

**Full-data mode** (HDFS, 2021–2025): `make up-full`, then the steps in
[reproduce.md](reproduce.md#2-full-data-mode-hdfs-20212025). The last step serves the dashboard on the full lake:

```bash
make api-up FULL=1 REPLAY=1   # recreates only the api: HDFS lake, replays enabled, deployed model
```

## Stop

1. **Stop any replay first.** In the dashboard's status strip: **Stop**, then **Confirm stop** (Stop takes two
   presses). Without the page:
   `curl -s -X POST localhost:8000/api/races/2024/5/replay/stop` (with the race's season and round), then
   `curl -s localhost:8000/api/replays` to check that nothing is `starting`, `running` or `paused`.
2. **Then stop the stack:** `make down`. It removes the containers and keeps the volumes (Kafka log, HDFS data).
3. **Never `down -v`.** Volumes are deleted only by `make nuke CONFIRM=yes`, and only when that is really wanted
   (see [reproduce.md](reproduce.md#6-clean-up)).
