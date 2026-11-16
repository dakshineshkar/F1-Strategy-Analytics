/** Generic geometry for the hand-written SVG charts of the race-analysis tab (pure, unit-tested).
 * The live gap chart keeps its own ``lib/chart.ts``. */

export interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type Scale = (v: number) => number;

/** Linear map of ``domain`` onto ``range`` (a zero-width domain maps to the middle). Values outside
 * the domain are clamped when ``clamp`` is set. */
export function linear(domain: [number, number], range: [number, number], clamp = false): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v: number) => {
    if (d1 === d0) return (r0 + r1) / 2;
    let t = (v - d0) / (d1 - d0);
    if (clamp) t = Math.min(1, Math.max(0, t));
    return r0 + t * (r1 - r0);
  };
}

/** The frame's inner x range ``[left, width - right]`` and y range ``[top, height - bottom]``. */
export const innerX = (f: Frame): [number, number] => [f.left, f.width - f.right];
export const innerY = (f: Frame): [number, number] => [f.top, f.height - f.bottom];

/** About ``count`` round tick values inside ``[lo, hi]`` (steps of 1, 2 or 5 × 10^n). */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag; // in [1, 10): pick the step nearest to raw (the d3 rule)
  const step = (err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1) * mag;
  const first = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out.map((v) => Number(v.toFixed(10)));
}

/** ``M x y L x y …`` through the points (2 decimals); a ``null`` y starts a new segment. */
export function pathOf<P>(points: readonly P[], x: (p: P) => number, y: (p: P) => number | null): string {
  let out = "";
  let pen = false;
  for (const p of points) {
    const yv = y(p);
    if (yv === null || !Number.isFinite(yv)) {
      pen = false;
      continue;
    }
    out += `${out ? " " : ""}${pen ? "L" : "M"}${x(p).toFixed(2)} ${yv.toFixed(2)}`;
    pen = true;
  }
  return out;
}

/** Median of the finite values (null when there are none). */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

/** Spread labels at least ``minGap`` px apart inside ``[top, bottom]``, keeping their order. */
export function spreadLabels(ys: { id: string; y: number }[], minGap: number, top: number, bottom: number) {
  const sorted = [...ys].sort((p, q) => p.y - q.y || p.id.localeCompare(q.id));
  const n = sorted.length;
  if (n === 0) return [];
  const gap = n > 1 ? Math.min(minGap, (bottom - top) / (n - 1)) : minGap;
  const placed = sorted.map((s) => ({ id: s.id, y: Math.min(Math.max(s.y, top), bottom) }));
  for (let i = 1; i < n; i++) {
    const prev = placed[i - 1] as { y: number };
    const cur = placed[i] as { y: number };
    cur.y = Math.max(cur.y, prev.y + gap);
  }
  const last = placed[n - 1] as { y: number };
  last.y = Math.min(last.y, bottom);
  for (let i = n - 2; i >= 0; i--) {
    const next = placed[i + 1] as { y: number };
    const cur = placed[i] as { y: number };
    cur.y = Math.min(cur.y, next.y - gap);
  }
  return placed;
}
