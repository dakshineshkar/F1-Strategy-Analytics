import { gaugeGeometry, RULE_GAP_S, trendOf } from "@/lib/call";

import { TrendMark } from "./Marks";

const s1 = (x: number) => `${x.toFixed(1)} s`;

/** The call's signature: the gap to the car ahead on a scale from 0 s to the race's pit loss. The rule's
 * window (0 to G) is shaded and ticked, the gap is the signal marker, and the trend is an arrow in gain
 * blue (closing) or loss orange (opening) with its value in text. One ``role="img"`` with a full sentence;
 * every value is also printed, so nothing is read from position or colour alone. Positions are static per
 * lap (no animated marker). */
export function CallGauge({
  gapS,
  pitLossS,
  pitLossText,
  trend,
  trendLaps,
  g = RULE_GAP_S,
}: {
  gapS: number;
  pitLossS: number | null;
  /** where the pit loss comes from, in words */
  pitLossText: string | null;
  trend: number | null;
  trendLaps: number | null;
  g?: number;
}) {
  const geo = gaugeGeometry(gapS, pitLossS, g);
  const t = trendOf(trend);
  const inside = gapS <= g;
  const sentence =
    `Gap ${s1(gapS)} to the car ahead, ${inside ? "inside" : "outside"} the ${g} s rule window` +
    (pitLossS !== null ? `; the race's pit loss is ${s1(pitLossS)}` : "; pit loss unknown") +
    (t !== null ? `; ${t.text}${trendLaps ? ` over ${trendLaps} laps` : ""}.` : ".");
  return (
    <figure className="gauge" role="img" aria-label={sentence}>
      {/* Positions are transforms of full-width layers (translateX % of the track), so a new lap's values
          repaint without moving any layout box. */}
      <div className="gauge-track" aria-hidden="true">
        <span className="gauge-layer gauge-window" style={{ transform: `scaleX(${geo.gPct / 100})` }} />
        <span className="gauge-layer" style={{ transform: `translateX(${geo.gPct}%)` }}>
          <span className="gauge-tick" />
        </span>
        {/* the marker moves by its own transform (cqw = 1% of the track), so a new gap is never a layout shift */}
        <span className={`gauge-marker${geo.gapBeyond ? " is-beyond" : ""}`} style={{ transform: `translateX(${geo.gapPct}cqw)` }} />
      </div>
      <div className="gauge-axis" aria-hidden="true">
        <span className="gauge-axis-0">0 s</span>
        <span className="gauge-layer" style={{ transform: `translateX(${geo.gPct}%)` }}>
          <span className="gauge-axis-g">G {g} s</span>
        </span>
        <span className="gauge-axis-end">{pitLossS !== null ? `pit loss ${s1(pitLossS)}` : `${s1(geo.maxS)}, pit loss unknown`}</span>
      </div>
      <figcaption className="gauge-read" aria-hidden="true">
        <span className="gauge-gap">
          <span className="gauge-label">Gap</span> <span className="num">{s1(gapS)}</span>
        </span>
        {t !== null ? (
          <span className={`gauge-trend is-${t.dir}`}>
            <TrendMark dir={t.dir} />
            <span className="num">{t.text}</span>
            {trendLaps ? <span className="gauge-label"> over {trendLaps} laps</span> : null}
          </span>
        ) : (
          <span className="gauge-trend gauge-label">trend after 3 laps of history</span>
        )}
        {pitLossText !== null ? <span className="gauge-src">pit loss from {pitLossText}</span> : null}
      </figcaption>
    </figure>
  );
}
