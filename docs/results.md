# Key results

The full results digest; the [README](../README.md) links here. The method, runtime and
caveats of each experiment are in [experiments.md](experiments.md) and [model_results.md](model_results.md),
and the full write-up is the [report](report/report.md). All documents: [docs/README.md](README.md).

All numbers are copied from the committed results and their write-ups. The first two sections are on the
held-out **2025** season, which was evaluated once:
- 49 labelled undercut attempts in 19 races at the primary setting (G = 3.5 s, k = 2);
- base rate 0.347;
- 95% race-cluster bootstrap intervals, 1000 resamples.

**No significance claim is made**, and the per-model intervals overlap. Details: [docs/model_results.md](model_results.md).

## Undercut model vs baselines (2025, primary setting)

| Model | PR-AUC [95% CI] | Brier [95% CI] | ROC-AUC [95% CI] | F1 positive class [95% CI] | ECE, 10 bins [95% CI] |
|---|---|---|---|---|---|
| **Calibrated LR, feature set `real` (primary)** | **0.670 [0.421, 0.898]** | **0.177 [0.106, 0.232]** | 0.792 [0.667, 0.929] | 0.571 [0.323, 0.778] | 0.107 [0.076, 0.234] |
| Rule baseline | 0.513 [0.246, 0.799] | 0.273 [0.168, 0.353] | 0.702 [0.516, 0.860] | 0.357 [0.000, 0.542] | 0.258 [0.162, 0.360] |
| Majority-class baseline | 0.347 [0.162, 0.517] | 0.229 | 0.500 | 0.000 | 0.051 |

- The primary model scores better than the rule baseline on every metric, but every interval overlaps.
- Against the majority baseline (#17): F1 0.571 against 0.000, and PR-AUC 0.670 against 0.347.

## Ablation: tyre and telemetry inputs (paired 2025 intervals)
- **Method:** the frozen models scored again, with one shared set of race resamples for all feature sets
  (`results/ablation_paired.csv`).
- **Most differences are not distinguishable from zero.** 46 of the 48 paired intervals contain 0. The two
  exceptions are both calibrated LR at the primary setting:
  - `real_ti − real` ROC-AUC: −0.062 [−0.126, −0.015];
  - `real_ti − real_tyre` Brier: +0.014 [+0.002, +0.026].

  With 48 intervals, one or two that exclude 0 are expected by chance, so neither is read as a finding.
- **PR-AUC, calibrated LR:**
  - `real_tyre − real`: +0.021 [−0.136, +0.128];
  - `real_ti − real`: −0.040 [−0.205, +0.072].

  Adding per-lap telemetry points the same way as in development: lower PR-AUC and ROC-AUC, higher Brier.
- **Conclusion:** on this 2025 sample the tyre and telemetry inputs do not improve the model. The primary feature
  set and the deployed model are unchanged, as pre-registered.

## What-if simulator: consistency and its 2025 calibration weakness
Source: `results/whatif_consistency.csv`. The checks are pre-registered in [docs/sim_spec.md](sim_spec.md).

**Pre-registered checks:**
- **Monotonicity:** passes. A larger pit loss for the attacker never raises P(`pit_now`): 0 of 155 states have an
  increase.
- **Determinism:** passes. The same seed gives byte-identical results in 157 of 157 states, and seed + 1 moves P
  by at most 0.06.
- **Ordering:** 17 of 18 pass/fail rows pass.
  - The failing cell is in the far tail: opening at −0.5 s/lap with a 5 s gap, P(`pit_next_lap`) − P(`pit_now`)
    = +0.022.
  - The extra simulated lap widens the spread, which lifts a small tail probability even though the mean gap
    worsens.
  - The rule was kept unchanged, and the failure is part of the result.

**Backtest of P(`pit_now`) against the real outcomes:**

| Subset | Attempts | Simulator Brier | Simulator ECE, 10 bins | Simulator mean P | Observed rate | Model Brier | Model ECE, 10 bins |
|---|---|---|---|---|---|---|---|
| 2021–2024 (development) | 155 | 0.185 | 0.090 | 0.295 | 0.303 | 0.152 (157; its own training and calibration rows) | 0.058 |
| **2025 (held out)** | 49 | **0.245** | **0.207** | **0.395** | 0.347 | 0.177 | 0.107 |

**The weakness.** On 2025 the simulator is clearly worse calibrated than in development:
- it over-predicts success (mean P 0.395 against an observed 0.347);
- its ECE is more than twice the development value;
- the sensitivity response is worse still (Brier 0.242, ECE 0.242, mean P 0.458).

The calibrated model stays better calibrated than the simulator on 2025. Read the simulator's probabilities as
a comparison between strategies from the same state, not as calibrated odds.

## Streaming, UI and Redis latency (quiet stack, 2024 R5 replay)
From [docs/experiments.md](experiments.md). Steady state, without the first batch:

| Segment | 1x (15 min) p50 / p95 / p99 | 10x p50 / p95 / p99 | 60x p50 / p95 / p99 |
|---|---|---|---|
| Produced → Pub/Sub (end to end) | 729 / 1039 / 1115.4 ms | 786.5 / 1227.0 / 1586.5 ms | 798 / 1461.5 / 1757 ms |
| Redis write → SSE client | p50 2 / p99 5.4 ms | p50 2 / p99 8 ms | p50 2 / p99 5 ms |

- **Where the time goes.** The 500 ms trigger and the Kafka hop take about 0.73–0.80 s of the median. Every
  serving hop is a few milliseconds.
- **The first race batch costs about 1.3–1.4 s more.** It loads the priors once per race.
- **UI, 60x:** API SSE send → browser paint is p50 / p95 / p99 28 / 37 / 40 ms, and produced → paint is
  855 / 1519.5 / 3443.5 ms.
- **Throughput** equals the produced rate: 12.71 messages/s at 60x, with no backlog. The pipeline's maximum was not
  load-tested.
- **Redis**, serving contract at 60 batches/s on a quiet stack:
  - write p50 / p95 / p99 1.21 / 1.59 / 1.78 ms, HGETALL 0.18 / 0.32 / 0.41 ms;
  - 0 late ticks, and every p99 below 3.1 ms.

## Spark scalability, partitioning and caching (single host)
From [docs/experiments.md](experiments.md). All medians are on one 12-CPU WSL 2 VM, so read them as trends.

**Telemetry aggregation** over the real 2024 samples (1.94 GB):
- the cost grows about linearly with the data;
- all 24 rounds take 18.01 s on `local[1]`, 7.49 s on `local[4]` (2.40x) and 8.24 s on the 2-worker cluster
  (2.19x).

**Feature build:**
- **Fixed overhead dominates at small sizes.** Going from 1 to 5 real seasons multiplies the lap rows by 4.7, but
  the `local[4]` time only by 1.37 (48.0 → 65.8 s).
- **At 3 seasons x4 (synthetic replication):**
  - `local[1]` 257.8 s, `local[4]` 200.5 s;
  - the cluster was fastest at 161.9 s [160.9, 164.8], 1.59x over `local[1]`.
- **The largest cells:** at 1 season x16 and 5 seasons x4, every `local[N]` cell was stopped by the memory guard.
  The cluster finished them (175.6 s and 213.6 s), with an executor lost and recovered in each run.

**Partitioning** with `partitionBy(season, round)`, laps x16:
- One-race queries are 1.74x faster on file:// and 1.20x on HDFS (against unpartitioned on the same file system).
- Full scans and joins get slower because of the many small files: 0.30x and 0.32x on file://, 0.14x and 0.12x on
  HDFS against the simplest baseline.

**Caching:**
- `cache()` helps only the small lap queries: 1.41x on one race. Materialising the cache takes 1.13 s, so it pays
  back only after roughly 25–40 such queries.
- It does not help telemetry.
- `persist(DISK_ONLY)` is mostly slower than no caching.
