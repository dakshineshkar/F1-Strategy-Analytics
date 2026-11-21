# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-11-21

### Changed

- Replay controls are now inline in the status strip, so nothing covers The Call; two-press Stop with Escape to
  cancel; fixed strip height at every width; the finished state offers the post-race archive once, in the strip.

## [1.0.0] - 2026-11-20

The first complete release.

### Added

- **Data lake.** Race data from Jolpica-F1, FastF1 and TracingInsights is stored as raw files, then cleaned into
  Parquet tables partitioned by season and round. The same code runs on HDFS or on the local disk.
- **Spark processing.** The features that describe each car before every lap (gaps, closing rate, tyre age,
  pit loss and more) are built with Spark RDDs, DataFrames and SQL, using only information known at that time.
- **Machine-learning model.** A Spark MLlib gradient-boosted tree model with probability calibration predicts
  whether an undercut will work. It is trained on 2021 to 2023, calibrated on 2024 and tested once on 2025.
- **Streaming.** A replay sends a race lap by lap through Kafka. Spark Structured Streaming updates every car and
  raises undercut alerts as the race runs.
- **Redis serving.** The live state of each car, the running order and the race events are kept in Redis, with
  expiry times so finished races clean themselves up.
- **API.** A FastAPI service serves the race state, pushes live updates to the browser with Server-Sent Events
  and starts, pauses, speeds up and stops replays.
- **Dashboard views.**
  - The race view: the strongest undercut call next to a 20-car timing tower.
  - The engineer view, focused on one car and the cars around it.
  - A post-race archive with a lap slider.
  - Race analysis: strategy, lap times, degradation, positions, comparison, pit stops and race control.
  - 2024 telemetry overlays.
  - A light theme and a phone layout.
- **What-if simulator.** For a car directly behind another, compares pitting now, pitting a lap later and
  staying out: the chance of being ahead once both have stopped, the expected gap and its 80% interval.
- **Experiments.** Recorded measurements of Spark scalability, data layout and caching, streaming latency and
  throughput, Redis latency, a feature ablation and the what-if checks, all in `results/`.
- **Documentation.** The project report (Markdown and PDF), a getting-started guide, a reproduction guide, the
  architecture, a data dictionary, a demo script, and a traceability matrix that maps every requirement to its
  code and tests.
