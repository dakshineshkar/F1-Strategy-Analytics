# Documentation

Every document in the repository. Start with the [README](../README.md), then
[getting-started.md](getting-started.md) to run it and [reproduce.md](reproduce.md) for every experiment, or the
[report](report/report.md) for the full write-up.

## Using the project

| Document | What it covers |
|---|---|
| [README](../README.md) | Landing page: what the project is, its features, how it works, links to getting started and results |
| [getting-started.md](getting-started.md) | Installation, the sample demo, full-data mode and how to stop |
| [reproduce.md](reproduce.md) | Prerequisites, sample and full-data mode, every target that writes `results/`, clean-clone timing, tests and CI |
| [architecture.md](architecture.md) | Code map and how each layer is built: ingestion, lake, Spark ETL and features, model, streaming, Redis, API, dashboard, memory budget |
| [data_dictionary.md](data_dictionary.md) | Every table and column of the clean and feature zones, the sample bundle, the synthetic data and the model outputs |

## Design and results

| Document | What it covers |
|---|---|
| [results.md](results.md) | Results digest: model, ablation, what-if, streaming, Redis and Spark numbers |
| [model_results.md](model_results.md) | Model results on the 2025 test season, with intervals |
| [experiments.md](experiments.md) | Method, runtime and results of the Spark, streaming and Redis experiments |
| [data_source_audit.md](data_source_audit.md) | Audit of TracingInsights (primary source of tyres, race control and telemetry) and OpenF1 (cross-check) |
| [traceability.md](traceability.md) | Every requirement of the project proposal mapped to code, tests and proof (checked in CI) |
| [report/report.md](report/report.md) | The project report |
| [report/report.pdf](report/report.pdf) | The report as a PDF (`make report-pdf`) |
| [report/final_report.md](report/final_report.md) | The course submission report (8 pages; the full report above stays the technical reference) |
| [report/final_report.pdf](report/final_report.pdf) | The course submission report as a PDF (`make final-report-pdf`: A4, 2.5 cm margins, 10 pt) |
| [demo_script.md](demo_script.md) | The 10-minute and 5-minute live demo, a fallback plan and likely questions |
| [design/DESIGN.md](design/DESIGN.md) | The dashboard design system (Pit Wall) |
| [assets/architecture.mmd](assets/architecture.mmd) | Source of the README architecture image (`architecture-{dark,light}.{svg,png}`, redrawn by `make readme-assets`) |
| [design/product-brief.md](design/product-brief.md) | Product brief for the dashboard (users, purpose, constraints, principles) |
| [../DATA_LICENSES.md](../DATA_LICENSES.md) | Licences and usage terms of every data source |
| [../CITATION.cff](../CITATION.cff) | How to cite the project |
| [../LICENSE](../LICENSE) | MIT licence of the code |
| [../results/README.md](../results/README.md) | Environment fingerprints of every recorded experiment |
| [../data/sample/README.md](../data/sample/README.md) | The committed sample bundle (real Jolpica data, synthetic tyres and telemetry) |

## Pre-registered specifications (frozen)

| Document | What it covers |
|---|---|
| [label_definition.md](label_definition.md) | The undercut label and the decision-time feature definitions (frozen, `label-definition-v1`) |
| [model_spec.md](model_spec.md) | Pre-registered model specification for the single 2025 test run |
| [model_spec_v2.md](model_spec_v2.md) | Pre-registered specification of the 2025 tyre and telemetry ablation |
| [sim_spec.md](sim_spec.md) | Pre-registered specification of the what-if simulator and its checks |

## Contributing

| Document | What it covers |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, the development commands, commit conventions and the rules every change follows |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability, where secrets live and which ports are exposed |
| [../CHANGELOG.md](../CHANGELOG.md) | What each release contains |
| [../.github/pull_request_template.md](../.github/pull_request_template.md) | The checklist every pull request fills in |

## Development records

[dev/](dev/): the engineering log, the design critique and the UI inventory that preceded the redesign; the build plan is [planning/playbook_v2.md](planning/playbook_v2.md).
