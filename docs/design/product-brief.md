# Product brief: Pit Wall dashboard

## Platform

web

## Users

- **Primary: course graders and evaluators** (IISc MTech DA231o instructors and TAs). They watch a demo or run
  `make demo` themselves and judge whether every requirement of the project proposal (docs/traceability.md) works end to end.
  The dashboard is where the pipeline's output becomes visible, so it carries the demo.
- **Secondary: people who know F1 strategy.** The dashboard must read as credible to someone who understands
  undercuts, tyre age, gaps, pit-lane loss and traffic. Wrong terms or naive framing cost credibility with both
  audiences.

## Product Purpose

Pit Wall is the dashboard of F1 Strategy Analytics at Scale, a big-data pipeline built around one question:
**when a car pits to undercut the car ahead, does it come out in front?** Races from a 2021–2025 data lake are
replayed through Kafka and Spark Structured Streaming, scored lap by lap by a rule and a calibrated MLlib model,
and served through Redis and FastAPI (SSE) to the Next.js dashboard.

Success, in priority order:
1. **The live call is credible.** Undercut alerts and calibrated probabilities appear in real time, lap by lap,
  honestly labelled.
2. **Strategy is explorable.** The viewer can compare *pit now / pit next lap / stay out* from the same race
  state, and dig into stints, degradation, positions, telemetry, the engineer view and the post-race archive to
  see why a call works or fails.
3. **The big-data stack is visible as a supporting layer**: a compact pipeline/latency status and a "how it
  works" explanation, never the centrepiece over the race.

## Positioning

Not a fan timing app and not a broadcast graphic: a decision-time undercut detector whose every number is
traceable to a pre-registered, chronologically evaluated pipeline (train 2021–23, calibrate 2024, sealed 2025
test). Features use only information available at the end of the previous lap, so what the dashboard shows at
lap L is what a strategist could have known then. The archive view is proven equal to the live replay path.

## Operating Context

- Run locally via Docker Compose (`make up`, `make demo`); dashboard at `http://localhost:3000/race/{season}/{round}`.
  The sample demo replays 2024 R5 at 60x (about 2 minutes); full mode serves 90 races from HDFS.
- Typical scene: a live demo or recorded walkthrough for graders, or an evaluator clicking through on their own
  machine after a clean clone.
- Surfaces: race picker (`/`), live race page (timing tower, gap chart, tyres, alert feed, replay controls with
  stop/pause/resume/speed, what-if panel, engineer tab, race-status banner), drivers page, race analysis
  (`/analysis`: lap times, strategy/stints, degradation, positions, pit stops, race control, compare, 2024
  two-lap telemetry overlay), post-race archive viewer with lap scrubber.

## Capabilities and Constraints

- Stack: Next.js + React + TypeScript strict, no UI library; colour tokens in `web/src/lib/theme.ts` (single
  source for CSS variables and contrast tests); Vitest unit tests and Playwright e2e.
- Race data is push-only: SSE events plus server-pushed per-lap snapshots; `/state` is reloaded only on
  reconnect, and only replay control status (`/api/replays`) is polled. The UI is a pure event reducer over the
  Redis key contract in
  [docs/architecture.md](../architecture.md#redis-serving-servingkeyspy-servingredis_storepy). Display-only additions (tyre, timing, entrants, analysis, telemetry) must never feed the model, the
  rule, the live features or the what-if.
- **Stable live layout:** tabular figures, fixed row heights and reserved panel sizes so streaming updates never
  shift the layout.
- **Honesty labels are product truth:** the SYNTHETIC DEMO DATA banner on sample data, the SMOKE TEST stamp on
  the sample model, no fabricated results, and what-if probabilities framed as a comparison between strategies
  from the same state, not calibrated odds (the simulator is worse calibrated than the model on 2025).
- Terminology: undercut, attacker/defender, gap ahead/to leader, tyre compound and tyre age (laps), stint,
  pit-in/pit-out, SC/VSC, lapped car, DNF, G (gap threshold, primary 3.5 s) and k (laps, primary 2).

## Brand Commitments

- Name: **Pit Wall** (product), "F1 Strategy Analytics" (project), team **Data Wranglers**.
- **No F1 branding:** unofficial project, not associated with the Formula 1 companies (footer disclaimer stays).
  No Formula 1 marks, logos or team trademarks beyond factual names and data.
- Voice: plain, precise, unhyped; states limits and uncertainty explicitly (as the README does).

## Evidence on Hand

- Committed results in `results/` and write-ups in `docs/model_results.md`, `docs/experiments.md`: 2025 held-out
  model metrics with 95% race-cluster bootstrap CIs, ablation, what-if consistency/backtest, streaming, UI and
  Redis latency.
- Sample data `data/sample/` (two races: real Jolpica laps/pit stops, synthetic tyres and telemetry).
- Absences future work must not fabricate: no significance claim between models, no load-tested maximum
  throughput, no users, testimonials or adoption figures, no official F1 data redistribution.

## Product Principles

1. **Honest before impressive.** Every probability, label and data source shows its provenance and caveats;
  never imply more certainty than the results support.
2. **The race leads, the pipeline supports.** Race state and the undercut call get the attention; infrastructure
  appears as compact status and explanation.
3. **Decision-time truth.** Show what was knowable at that lap; never leak future laps into a live view.
4. **Calm under streaming.** Live updates change values, never layout; nothing moves that the viewer did not ask
  to move.
5. **Speak strategist.** Use correct F1 strategy terms so a knowledgeable viewer trusts it, with short
  explanations (InfoTips) for graders who are not fans.

## Accessibility & Inclusion

WCAG 2.2 AA is the floor. Theme tokens are contrast-tested (`web/tests/theme.test.ts`); meaning is never carried
by colour alone (tyre compounds always shown as text or glyph shape); alerts use a filtered `aria-live` region;
keyboard access throughout (skip link, visible focus, keyboard crosshair on charts); light and dark themes.
