# Documentation

Every document in the repository. Start with the [README](../README.md), then [reproduce.md](reproduce.md) to run
it, or the [report](report/report.md) for the full write-up.

| Document | What it covers |
|---|---|
| [README](../README.md) | Landing page: what the project is, quick start, headline results |
| [reproduce.md](reproduce.md) | Prerequisites, sample and full-data mode, every target that writes `results/`, clean-clone timing, tests and CI |
| [architecture.md](architecture.md) | Code map and how each layer is built: ingestion, lake, Spark ETL and features, model, streaming, Redis, API, dashboard, memory budget |
| [data_dictionary.md](data_dictionary.md) | Every table and column of the clean and feature zones, the sample bundle, the synthetic data and the model outputs |
| [data_source_audit.md](data_source_audit.md) | Audit of TracingInsights (primary source of tyres, race control and telemetry) and OpenF1 (cross-check) |
| [label_definition.md](label_definition.md) | The undercut label and the decision-time feature definitions (frozen, `label-definition-v1`) |
| [model_spec.md](model_spec.md) | Pre-registered model specification for the single 2025 test run |
| [model_spec_v2.md](model_spec_v2.md) | Pre-registered specification of the 2025 tyre and telemetry ablation |
| [model_results.md](model_results.md) | Model results on the 2025 test season, with intervals |
| [results.md](results.md) | Results digest: model, ablation, what-if, streaming, Redis and Spark numbers |
| [experiments.md](experiments.md) | Method, runtime and results of the Spark, streaming and Redis experiments |
| [sim_spec.md](sim_spec.md) | Pre-registered specification of the what-if simulator and its checks |
| [traceability.md](traceability.md) | Every proposal commitment mapped to code, tests and proof (checked in CI) |
| [report/report.md](report/report.md) | The project report |
| [report/report.pdf](report/report.pdf) | The report as a PDF (`make report-pdf`) |
| [demo_script.md](demo_script.md) | The 10-minute and 5-minute live demo, a fallback plan and likely questions |
| [design/DESIGN.md](design/DESIGN.md) | The dashboard design system (Pit Wall) |
| [design/inventory.md](design/inventory.md) | UI inventory of every screen and state before the redesign |
| [design/critique-2026-11-18.md](design/critique-2026-11-18.md) | Design critique of the live race view that preceded the redesign |
| [planning/playbook_v2.md](planning/playbook_v2.md) | Build plan and step table |
| [dev/engineering_log.md](dev/engineering_log.md) | Engineering log: every build step (done, next, open items, verification) |
| [../DATA_LICENSES.md](../DATA_LICENSES.md) | Licences and usage terms of every data source |
| [../PRODUCT.md](../PRODUCT.md) | Product brief for the dashboard (users, purpose, constraints, principles) |
| [../CITATION.cff](../CITATION.cff) | How to cite the project |
| [../LICENSE](../LICENSE) | MIT licence of the code |
| [../results/README.md](../results/README.md) | Environment fingerprints of every recorded experiment |
| [../data/sample/README.md](../data/sample/README.md) | The committed sample bundle (real Jolpica data, synthetic tyres and telemetry) |
