import { gaugeGeometry, RULE_GAP_S, trendOf } from "@/lib/call";

import { TrendMark } from "./Marks";

const s1 = (x: number) => `${x.toFixed(1)} s`;

/** The call's signature: the gap to the car ahead now, on an axis from 0 s to ``max(5 s, gap × 1.5)``. The
 * rule window (0 to the rule's gap threshold, 3.5 s) is shaded and labelled, the gap now is the marker, and
 * the gap trend is an arrow from the gap now to where it will be next lap if the trend holds, in gain blue
 * (closing) or loss orange (opening), with its value in text. The pit loss is a different quantity, so it is
 * stated in the caption, not drawn on this axis. One ``role="img"`` with a full sentence; every value is also
 * printed, so nothing is read from position or colour alone. Positions are transforms of full-width layers,
 * so a new lap repaints without moving any layout box.
 *
 * ``muted``: the closest pair when there is no call (neutral marker and window, no signal colour). */
export function CallGauge({
  gapS,
  pitLossS,
  pitLossText,
  trend,
  trendLaps,
  g = RULE_GAP_S,
  muted = false,
}: {
  gapS: number;
  pitLossS: number | null;
  /** where the pit loss comes from, in words */
  pitLossText: string | null;
  trend: number | null;
  trendLaps: number | null;
  g?: number;
  muted?: boolean;
}) {
  const geo = gaugeGeometry(gapS, trend, g);
  const t = trendOf(trend);
  const inside = gapS <= g;
  const next = t !== null && t.dir !== "steady" && geo.nextS !== null && geo.nextPct !== null ? { s: geo.nextS, pct: geo.nextPct } : null;
  const sentence =
    `Gap now ${s1(gapS)} to the car ahead, ${inside ? "inside" : "outside"} the ${g} s rule window` +
    (t !== null ? `; ${t.text}${trendLaps ? ` over ${trendLaps} laps` : ""}${next !== null ? `, about ${s1(next.s)} next lap` : ""}` : "") +
    (pitLossS !== null ? `; the race's pit loss is ${s1(pitLossS)}.` : "; pit loss unknown.");
  const lo = next === null ? geo.gapPct : Math.min(geo.gapPct, next.pct);
  const span = next === null ? 0 : Math.abs(next.pct - geo.gapPct);
  return (
    <figure className={`gauge${muted ? " is-muted" : ""}`} role="img" aria-label={sentence}>
      <div className="gauge-track" aria-hidden="true">
        <span className="gauge-layer gauge-window" style={{ transform: `scaleX(${geo.windowPct / 100})` }} />
        <span className="gauge-layer" style={{ transform: `translateX(${geo.windowPct}%)` }}>
          <span className="gauge-tick" />
        </span>
        {next !== null ? (
          <>
            <span className={`gauge-layer gauge-shaft is-${t?.dir}`} style={{ transform: `translateX(${lo}%) scaleX(${span / 100})` }} />
            <span className="gauge-layer" style={{ transform: `translateX(${Math.min(next.pct, 100)}%)` }}>
              <span className={`gauge-head is-${t?.dir}${geo.nextBeyond ? " is-beyond" : ""}`} />
            </span>
          </>
        ) : null}
        {/* the marker moves by its own transform (cqw = 1% of the track), so a new gap is never a layout shift */}
        <span className="gauge-marker" style={{ transform: `translateX(${geo.gapPct}cqw)` }} />
      </div>
      <div className="gauge-axis" aria-hidden="true">
        <span className="gauge-axis-0">0 s</span>
        <span className="gauge-layer" style={{ transform: `translateX(${geo.windowPct}%)` }}>
          {/* right-aligned to the tick, or after it when the window is short (a large gap) and would reach "0 s" */}
          <span className={`gauge-axis-window${geo.windowPct < 35 ? " is-after" : ""}`}>rule window {g} s</span>
        </span>
        <span className="gauge-axis-end">{s1(geo.maxS)}</span>
      </div>
      <figcaption className="gauge-read" aria-hidden="true">
        <span className="gauge-gap">
          <span className="gauge-label">gap now</span> <span className="num">{s1(gapS)}</span>
        </span>
        {t !== null ? (
          <span className={`gauge-trend is-${t.dir}`}>
            <TrendMark dir={t.dir} />
            <span className="num">{t.text}</span>
            {next !== null ? <span className="gauge-label">to {s1(next.s)} next lap</span> : null}
          </span>
        ) : (
          <span className="gauge-trend gauge-label">trend after 3 laps of history</span>
        )}
        <span className="gauge-src">
          pit loss {pitLossS !== null ? <span className="num">{s1(pitLossS)}</span> : "unknown"}
          {pitLossText !== null ? ` from ${pitLossText}` : ""}
        </span>
      </figcaption>
    </figure>
  );
}
