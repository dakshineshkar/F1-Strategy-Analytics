/** What every dashboard marker means: the one source of the legend ("How to read this") and of the
 * tooltips, so the two can never disagree. The wording follows the stream's definitions
 * (``streaming/events.py`` ALERT_TRIGGERS, the shared undercut rule, ``lib/tyre.ts``). */

export type GlossaryGroup = "tower" | "alerts" | "whatif" | "analysis" | "engineer";

export interface GlossaryEntry {
  id: string;
  group: GlossaryGroup;
  /** The marker as it appears on screen. */
  term: string;
  /** Accessible name of its tooltip button: "About <label>". */
  label: string;
  /** One or two sentences, shown in the tooltip and the legend. */
  text: string;
}

/** The deployed model's decision threshold (``decision_threshold``, fixed at 0.5 since Step 9). */
export const THRESHOLD_PCT = 50;

export const GLOSSARY = [
  {
    id: "flag",
    group: "tower",
    term: "▲ and yellow left bar",
    label: "the undercut flag",
    text:
      "Live undercut opportunity: at its latest evaluated lap this car passes the undercut rule against the car " +
      "directly ahead (within 3.5 s, not teammates, no car between them, neither lapped or in the pits, green lap).",
  },
  {
    id: "undercut",
    group: "tower",
    term: "Undercut %",
    label: "Undercut",
    text:
      "Calibrated model probability that an undercut on the car directly ahead succeeds (pitting next lap and " +
      "coming out ahead). — means the car is not a candidate.",
  },
  {
    id: "age",
    group: "tower",
    term: "Age, used, est.",
    label: "Age",
    text:
      "Tyre life in laps. “used”: the set already had laps on it before this stint (for example from " +
      "qualifying). “est.”: no real value, so the inferred stint age, which assumes a new set.",
  },
  {
    id: "int",
    group: "tower",
    term: "Int",
    label: "Int",
    text: "Interval: time behind the car directly ahead, measured at the timing line.",
  },
  {
    id: "gap",
    group: "tower",
    term: "Gap",
    label: "Gap",
    text: "Time behind the leader, measured at the timing line.",
  },
  {
    id: "team",
    group: "tower",
    term: "Team badge (FER, MCL, …)",
    label: "the team badge",
    text:
      "The team's short code on a swatch in its colour; hover for the team name and teammate, whose row is " +
      "outlined too. Colours come from the race timing data or a project palette; these are not official logos.",
  },
  {
    id: "lapsDown",
    group: "tower",
    term: "+1 L, IN PIT",
    label: "the driver tags",
    text: "“+n L”: the car is n laps behind the leader. “IN PIT”: the car is in the pit lane now.",
  },
  {
    id: "opportunity",
    group: "alerts",
    term: "Opportunity",
    label: "Opportunity",
    text:
      `The pair has just become an undercut candidate, or its probability rose to ${THRESHOLD_PCT}% or more ` +
      "while it stayed a candidate.",
  },
  {
    id: "attempt",
    group: "alerts",
    term: "Attempt",
    label: "Attempt",
    text: "The attacker of a candidate pair has pitted: the undercut is being tried now.",
  },
  {
    id: "alertProb",
    group: "alerts",
    term: "Alert %",
    label: "the alert percentage",
    text: "The calibrated probability that the undercut succeeds, as estimated at the decision lap.",
  },
  {
    id: "whatif",
    group: "whatif",
    term: "What-if rows",
    label: "the what-if",
    text:
      "The rows compare three pit strategies with a race simulator; the model probability below them is the " +
      "stream's calibrated outcome estimate.",
  },
  {
    id: "quicklap",
    group: "analysis",
    term: "Quick laps",
    label: "quick laps",
    text:
      "The laps the degradation fit uses: every timed lap except lap 1, pit-in and pit-out laps, SC, VSC and " +
      "red-flag laps, deleted laps, and laps slower than 107% of the fastest such lap of the same stint.",
  },
  {
    id: "degslope",
    group: "analysis",
    term: "s/lap slope",
    label: "the degradation slope",
    text:
      "A lap-time proxy, not tyre wear: the straight-line fit of lap time against tyre life over a stint's quick " +
      "laps. Fuel burn-off (cars get faster) and track evolution are in it too.",
  },
  {
    id: "cumgap",
    group: "analysis",
    term: "Gap (a − b)",
    label: "the cumulative gap",
    text:
      "Driver a's race time minus driver b's at the end of the same lap: positive means a is behind. The lap " +
      "delta is a's lap time minus b's; negative means a was faster on that lap.",
  },
  {
    id: "neutral",
    group: "analysis",
    term: "SC / VSC bands",
    label: "neutralised laps",
    text:
      "Laps the race leader ran under the safety car, the virtual safety car or a red flag, from the race-control " +
      "track status. Without race-control data they are estimated from lap times and shown as neutralised.",
  },
  {
    id: "engcalls",
    group: "engineer",
    term: "Strategy calls",
    label: "strategy calls",
    text:
      "Short display rules built only from the values on this tab (probability at least 50%, closing at 0.2 s/lap or " +
      "more, tyre offset of 8 laps or more, stint past the typical length). They are not model output.",
  },
  {
    id: "gaptrend",
    group: "engineer",
    term: "Gap trend",
    label: "the gap trend",
    text:
      "The straight-line slope of a pair's gap over the last 5 laps both cars completed (after either car's latest " +
      "pit stop), in seconds per lap: closing means the car behind is gaining. It needs at least 3 laps.",
  },
  {
    id: "rejoin",
    group: "engineer",
    term: "Pit-rejoin estimate",
    label: "the pit-rejoin estimate",
    text:
      "Where the focus car would rejoin if it pitted now: its race time plus the race's pit-loss prior (from earlier " +
      "races), placed among the other cars' current times. It is marked unreliable under SC, VSC or a red flag. The " +
      "what-if panel additionally adjusts for the driver's expected stop and out-lap, so the two estimates can differ " +
      "slightly.",
  },
  {
    id: "engprob",
    group: "engineer",
    term: "Undercut and threat",
    label: "the undercut and threat probabilities",
    text:
      "The stream's own probability for the car behind in each pair, as published at that lap: the focus on the car " +
      "ahead, and the car behind on the focus (the threat). It refers to the car directly ahead at the stream's latest " +
      "decision lap, which can lag by a lap.",
  },
] as const satisfies readonly GlossaryEntry[];

export type GlossaryId = (typeof GLOSSARY)[number]["id"];

export const GROUP_TITLE: Record<GlossaryGroup, string> = {
  tower: "Timing tower",
  alerts: "Undercut alerts",
  whatif: "What-if",
  analysis: "Race analysis",
  engineer: "Engineer",
};

export function glossary(id: GlossaryId): GlossaryEntry {
  const e = GLOSSARY.find((g) => g.id === id);
  if (e === undefined) throw new Error(`unknown glossary id ${id}`);
  return e;
}

/** The element id of a marker's tooltip text. ``scope`` keeps ids unique when one entry has a tip in
 * two places on a page (the tower's Age header and the tyre panel). */
export const tipId = (id: GlossaryId, scope?: string): string => `tip-${id}${scope ? `-${scope}` : ""}`;

/** Whether a key press dismisses an open or focused tooltip (WCAG 1.4.13): Escape only. Enter and
 * Space reach the button's click, which toggles the tooltip for touch and keyboard users. */
export const dismissesTip = (key: string): boolean => key === "Escape" || key === "Esc";
