/** Authored marks of the race view (one stroke and size family). The self-hosted Latin font subset has no
 * arrow or triangle glyphs, so these are drawn, never typed. All are decorative: the meaning is always in
 * the text next to them. */

const base = { "aria-hidden": true, focusable: false } as const;

/** attacker → defender */
export function PairArrow({ size = 14 }: { size?: number }) {
  return (
    <svg {...base} className="mark mark-pair" width={size} height={size} viewBox="0 0 14 14">
      <path d="M1.5 7h10M8 3.5 11.5 7 8 10.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The undercut flag on a tower row: a pennant (shape, not only colour). */
export function FlagMark({ size = 12 }: { size?: number }) {
  return (
    <svg {...base} className="mark mark-flag" width={size} height={size} viewBox="0 0 12 12">
      <path d="M2.5 1.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.25 2h6.5L7.75 4.5l2 2.5h-6.5z" fill="currentColor" />
    </svg>
  );
}

/** Gap trend along the gauge: closing points left (the gap shrinks), opening points right, steady is a bar. */
export function TrendMark({ dir, size = 14 }: { dir: "closing" | "opening" | "steady"; size?: number }) {
  if (dir === "steady") {
    return (
      <svg {...base} className="mark mark-trend is-steady" width={size} height={size} viewBox="0 0 14 14">
        <path d="M3 7h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  const d = dir === "closing" ? "M12 7H2.5M6 3.5 2.5 7 6 10.5" : "M2 7h9.5M8 3.5 11.5 7 8 10.5";
  return (
    <svg {...base} className={`mark mark-trend is-${dir}`} width={size} height={size} viewBox="0 0 14 14">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The pin toggle (outline when off, filled when on). */
export function PinMark({ on, size = 12 }: { on: boolean; size?: number }) {
  return (
    <svg {...base} className="mark mark-pin" width={size} height={size} viewBox="0 0 12 12">
      <path
        d="M4 1.5h4l-.5 3.5 2 2H2.5l2-2zM6 7v3.5"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
