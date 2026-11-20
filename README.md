# F1 Strategy Analytics at Scale

Lap by lap, will a Formula 1 car that pits to undercut the car ahead come out in front? An end-to-end big-data
pipeline, from an HDFS lake to a live pit-wall dashboard, that answers it.

[![CI](https://github.com/parinithd-27/F1-Strategy-Analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/parinithd-27/F1-Strategy-Analytics/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Python 3.12](https://img.shields.io/badge/python-3.12-blue.svg)](pyproject.toml)
[![Node 26](https://img.shields.io/badge/node-26-green.svg)](web/.nvmrc)

[![Live race view: a 10x replay of the 2024 Chinese Grand Prix on the full lake, with the timing tower, the current undercut call and the alert feed](docs/design/after/d-dark-mid.png)](docs/design/after/d-dark-mid.png)

---

## Overview

Five seasons of race timing (2021–2025, 114 races) from Jolpica-F1 and the FastF1-derived TracingInsights data
land in a partitioned HDFS lake. Spark turns them into features that use only what was known at the end of the
previous lap, and MLlib trains a calibrated undercut model: trained on 2021–2023, tuned and calibrated on 2024, and
tested once on a sealed 2025 season. A Kafka replay feeds Spark Structured Streaming, which scores every lap with
the same rule and model, writes Redis and pushes the result through FastAPI to a Next.js pit-wall dashboard.

---

## Features

### The call and the live timing tower

The race view puts the strongest undercut opportunity first: the attacker and the car ahead, the calibrated
probability, the gap, the closing rate and the pit loss behind it. A 20-car timing tower with sectors, speed trap,
tyres and stops sits beside it, and new alerts arrive lap by lap over Server-Sent Events (the screenshot at the
top).

### Engineer view

One car with the cars directly ahead and behind it: tyre and stint against the typical stint at earlier circuits,
recent pace, the undercut probability both ways, the gap trends, and where the car would rejoin if it pitted now.

[![Engineer view focused on RIC at lap 20: HAM ahead, TSU behind, the gap trends and the pit-now rejoin strip](docs/design/after/d-dark-engineer.png)](docs/design/after/d-dark-engineer.png)

### Post-race archive

Any finished race replays from a stored bundle that the live stream code produced. A lap slider with the flag, pit
and alert markers shows the tower and the alerts exactly as they stood at that lap.

[![Post-race archive of the 2024 Chinese Grand Prix at lap 30 under the safety car, with the lap slider, the flag, pit and alert markers, the tower and the alerts](docs/design/after/d-dark-archive.png)](docs/design/after/d-dark-archive.png)

### Race analysis

Eight views of a finished race: tyre strategy, lap times, tyre degradation, positions, a two-driver comparison, pit
stops, race control and telemetry. Every chart has a written summary and a table.

[![Tyre strategy of the 2024 Chinese Grand Prix: every driver's stints by compound, with the pit stops marked](docs/design/after/d-dark-analysis-strategy.png)](docs/design/after/d-dark-analysis-strategy.png)

[![Position chart of the 2024 Chinese Grand Prix from the grid to lap 56, highlighting VER, HAM and STR](docs/design/after/d-dark-analysis-positions.png)](docs/design/after/d-dark-analysis-positions.png)

### Telemetry

Two laps overlaid on one distance axis (speed, throttle, brake, gear), with where one driver gains and loses time
against the other. Available for the 2024 season.

[![Telemetry overlay of VER lap 33 against NOR lap 33 at the 2024 Chinese Grand Prix: speed, throttle, brake and gear](docs/design/after/d-dark-analysis-telemetry.png)](docs/design/after/d-dark-analysis-telemetry.png)

### Light theme and mobile

The same system re-derived for a light theme, and a single-column layout for phones.

<table>
  <tr>
    <td width="70%" valign="top">
      <a href="docs/design/after/d-light-mid.png"><img src="docs/design/after/d-light-mid.png" alt="The live race view in the light theme" width="100%"></a>
    </td>
    <td width="30%" valign="top">
      <a href="docs/design/after/m-dark-mid.png"><img src="docs/design/after/m-dark-mid.png" alt="The live race view on a phone: the call (RIC on HAM, 88%) and the undercut alerts" width="100%"></a>
    </td>
  </tr>
</table>

---

## How it works

<a href="docs/assets/architecture-dark.svg">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture-light.svg">
    <img src="docs/assets/architecture-dark.png" width="100%" alt="Architecture in three stages. Data in: Jolpica-F1, TracingInsights and optional FastF1 are ingested through HttpFS into an HDFS lake (raw, clean, features, archive). Batch: Spark, MLlib, the deployed scorer and the what-if simulator. Live: Kafka, Spark Structured Streaming, Redis, FastAPI and the Next.js dashboard.">
  </picture>
</a>

- **Ingestion and lake.** Rate-limited, cached and resumable clients for Jolpica-F1 and TracingInsights (pinned
  commits; FastF1 as an optional path) write through HttpFS into an HDFS lake: raw, clean Parquet and feature
  tables, partitioned by `season=` / `round=`.
- **Spark batch.** RDD, DataFrame and SQL jobs build the clean zone and the decision-time features: gaps, tyre
  age, out-lap pace, pit loss and earlier-race priors, each from information available at the end of the previous
  lap.
- **Model.** MLlib logistic regression and gradient-boosted trees with Platt calibration. The calibrated LR is
  deployed as a small pure-Python scorer.
- **Streaming.** A replay producer sends one race to Kafka (`f1.race.events`) at 1x, 10x or 60x. Spark Structured
  Streaming (500 ms trigger) computes the live features and applies the same rule and scorer as the batch path.
- **Serving.** Each micro-batch is written to Redis in one pipeline: a hash per driver, the order as a sorted set
  and the events on Pub/Sub, all expiring after the session ends. FastAPI serves the state, the SSE stream, the
  replay controls, the archive and the what-if simulator.
- **What-if simulator and dashboard.** A seeded Monte Carlo compares *pit now*, *pit next lap* and *stay out*
  from the same race state. The Next.js dashboard shows all of it.

More detail: [docs/architecture.md](docs/architecture.md). The diagram's source is
[docs/assets/architecture.mmd](docs/assets/architecture.mmd) (`make readme-assets` redraws it).

---

## Quick start

Needs Docker with 12 GB of memory, GNU `make`, `python3` and [`uv`](https://docs.astral.sh/uv/). Details for
Windows 11 + WSL 2, Linux and macOS: [Prerequisites](docs/reproduce.md#prerequisites).

```bash
git clone https://github.com/parinithd-27/F1-Strategy-Analytics.git
cd F1-Strategy-Analytics
make up            # core profile: kafka, redis, app, api, web (builds the images the first time)
make sample-data   # validates data/sample offline
make demo          # sample pipeline + sample model + a 60x replay of 2024 R5
```

Open http://localhost:3000/race/2024/5 while the replay runs. The demo uses two real Jolpica races with synthetic
tyres and telemetry, so the dashboard shows a **SYNTHETIC DEMO DATA** banner. `make down` stops it.

**Full-data mode** (HDFS, 2021–2025): `make up-full`, then the steps in
[docs/reproduce.md](docs/reproduce.md#2-full-data-mode-hdfs-20212025).

---

## Key results

2025 is the held-out test season, evaluated once. All numbers, with their intervals and sources, are in
[docs/results.md](docs/results.md).

| Result | Value |
|---|---|
| Undercut model, 49 labelled 2025 attempts (calibrated LR) | PR-AUC **0.670 [0.421, 0.898]**, Brier **0.177 [0.106, 0.232]**; better than the rule baseline on every metric, with overlapping intervals |
| Streaming, produced → Pub/Sub at 60x (p50 / p95 / p99) | **798 / 1461.5 / 1757 ms** on a single host, one replayed race |
| Partitioning by `season`, `round` | one-race queries **1.74x** faster on file:// and **1.20x** on HDFS |
| What-if simulator | ordering **17 of 18** checks pass; 2025 simulator ECE **0.207** |

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/README.md](docs/README.md) | Index of every document |
| [docs/reproduce.md](docs/reproduce.md) | Prerequisites, sample and full-data mode, every experiment target, tests and CI |
| [docs/architecture.md](docs/architecture.md) | Code map and the design of each layer |
| [docs/results.md](docs/results.md) | All results: model, ablation, what-if, streaming, Redis, Spark |
| [docs/model_results.md](docs/model_results.md) | The 2025 model evaluation |
| [docs/experiments.md](docs/experiments.md) | Spark, streaming and Redis experiments: method and runtime |
| [docs/report/report.md](docs/report/report.md) ([PDF](docs/report/report.pdf)) | The project report |
| [docs/demo_script.md](docs/demo_script.md) | The live demo script, with a fallback plan |
| [docs/traceability.md](docs/traceability.md) | Every proposal commitment mapped to code, tests and proof |

---

## Team

IISc MTech DA231o course project by team **Data Wranglers**: Parinith D., Dakshinesh K., Rohan Deore and
Kaushal V. (Indian Institute of Science, Bengaluru).

## Licence and citation

- **Code:** MIT ([LICENSE](LICENSE)).
- **Data** keeps its own terms ([DATA_LICENSES.md](DATA_LICENSES.md)). Jolpica-F1 is CC BY-NC-SA 4.0, and only the
  small sample in `data/sample/` is committed. Formula 1 timing data (through FastF1 or TracingInsights) is owned by
  Formula 1 / FOM, used for private academic study only and never committed.
- **Cite:** [CITATION.cff](CITATION.cff) (GitHub shows "Cite this repository").
- Unofficial project; not associated with the Formula 1 companies.
