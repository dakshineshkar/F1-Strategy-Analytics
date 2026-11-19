---
version: 1
slug: "web-src-app-race-season-round-page-tsx"
primary_target: "web/src/app/race/[season]/[round]/page.tsx"
related_targets: ["web/src/components/RaceDashboard.tsx"]
---

# Live race view (/race/[season]/[round])

Scope: the live race view only (Step 2 of the UI redesign). Mode: Operate.
Audience: course graders watching a replay demo, and F1 strategy readers. Job: see the live undercut call, why it
is made, and compare pit strategies from the same state. Constraints: display-only; Redis contract, SSE contract,
reducer logic, API and Python unchanged; 1440x900 shows tower + call + alerts above the fold.

## Direction contract
THESIS: An undercut detector, not a timing screen with an extra column. The attacker→defender call is the one loud
object; the tower, alerts and what-if are its evidence. Refuses the broadcast graphic and the generic SaaS card grid.
OWN-WORLD: Graphite engineering-instrument chrome (dark primary, light supported), hairline rules, 2-6 px radii,
Barlow Semi Condensed labels and tower, Barlow body, IBM Plex Mono tabular numerals for every live number. One signal
amber reserved for the call, alerts and flagged rows; gain blue / loss orange with signs; team colours only as data.
STORY: The viewer sees which car can undercut which, how likely the model thinks it is (model id shown), why (gap
against the 3.5 s window and the pit loss, tyre ages, trend), and can simulate pit now / next lap / stay out.
FIRST VIEWPORT: Top bar; one status strip (REPLAY/LIVE/SMOKE TEST, race, lap, track status, model id, connection,
replay drawer). Left ~900 px: full 20-row tower, every column, no horizontal scroll. Right ~480 px: The Call (pair,
probability, gap-vs-pit-loss gauge, reasons, Simulate), alert feed below in reserved space, what-if skeleton.
FORM: Operate dashboard shell; signature move = the gap-vs-pit-loss gauge in The Call. seed: none (pinned) —
"Concept 'Pit wall': a precise, dense, calm engineering instrument; one loud element, the undercut call. Not
broadcast glitz, not a generic SaaS dashboard."
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
