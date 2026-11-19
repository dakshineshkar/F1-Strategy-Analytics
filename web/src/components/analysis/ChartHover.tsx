"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { hoverKey, nearestPoint } from "@/lib/plot";

/** Where a hovered mark is, in the chart's own px (the SVG's viewBox is drawn 1:1 at the measured width): a
 * vertical hairline across the plot (a lap on a line chart) or an outline box (a bar, a stint, a point). */
export type HoverMark =
  | { kind: "line"; x: number; top: number; bottom: number }
  | { kind: "box"; x: number; y: number; w: number; h: number };

export interface HoverRow {
  key: string;
  /** the value, which leads (Plex Mono, text ink) */
  value: string;
  /** the series name, which follows (muted) */
  label: string;
  /** the series' line key: its stroke colour and dash (none for a row without a series mark) */
  stroke?: { colour: string; dash?: string };
}

export interface HoverReadout {
  title: string;
  rows: HoverRow[];
}

/** One readout as a sentence, for the keyboard slider's ``aria-valuetext``. */
export function readoutSentence(r: HoverReadout): string {
  return [r.title, ...r.rows.map((x) => `${x.label} ${x.value}`)].join(", ");
}

/** The hover layer of a hand-written SVG chart (dataviz: interactive by default; tooltips enhance, never gate).
 *
 * A transparent layer over the chart: the pointer snaps to the nearest mark (``points``, in px), and the same
 * readout is reachable from the keyboard (the layer is a slider: arrows one mark, Page Up / Page Down ten, Home,
 * End). The readout lists every series at that mark, value first. Nothing animates; every value is also in the
 * chart's "Show table". The layer is a sibling of the SVG inside a ``.chart-box``. */
export function ChartHover({
  width,
  height,
  points,
  mark,
  readout,
  label,
}: {
  width: number;
  height: number;
  /** the marks in reading order (left to right, or row by row) */
  points: readonly { x: number; y?: number }[];
  mark: (i: number) => HoverMark;
  readout: (i: number) => HoverReadout;
  /** the slider's accessible name, e.g. "Lap times: read a lap" */
  label: string;
}) {
  const [index, setIndex] = useState(-1);
  const n = points.length;
  const at = index >= 0 && index < n ? index : -1;

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const px = ((e.clientX - r.left) * width) / r.width;
    const py = ((e.clientY - r.top) * height) / r.height;
    const i = nearestPoint(points, px, py);
    if (i >= 0) setIndex(i);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = hoverKey(e.key, at, n);
    if (next === null) return;
    e.preventDefault();
    setIndex(next);
  };

  if (n === 0) return null;
  const shown = at >= 0 ? readout(at) : null;
  const m = at >= 0 ? mark(at) : null;
  const mx = m === null ? 0 : m.kind === "line" ? m.x : m.x + m.w / 2;
  // the tooltip opens on the side with more room, so it never leaves the chart
  const flip = mx > width / 2;

  return (
    <div
      className="chart-hover"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={at >= 0 ? at + 1 : n}
      aria-valuetext={shown ? readoutSentence(shown) : "Use the arrow keys to read each mark"}
      aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End"
      onPointerMove={fromPointer}
      onPointerDown={fromPointer}
      onPointerLeave={(e) => {
        if (document.activeElement !== e.currentTarget) setIndex(-1);
      }}
      onFocus={() => setIndex((i) => (i >= 0 ? i : n - 1))}
      onBlur={() => setIndex(-1)}
      onKeyDown={onKey}
    >
      {m !== null ? (
        m.kind === "line" ? (
          <span className="chart-hover-line" aria-hidden="true" style={{ transform: `translateX(${m.x}px)`, top: m.top, height: m.bottom - m.top }} />
        ) : (
          <span
            className="chart-hover-box"
            aria-hidden="true"
            style={{ transform: `translate(${m.x - 2}px, ${m.y - 2}px)`, width: m.w + 4, height: m.h + 4 }}
          />
        )
      ) : null}
      {shown !== null && m !== null ? (
        <div
          className={`chart-tip${flip ? " is-flipped" : ""}`}
          aria-hidden="true"
          style={{ transform: flip ? `translateX(${mx - 12}px) translateX(-100%)` : `translateX(${mx + 12}px)` }}
        >
          <p className="chart-tip-title">{shown.title}</p>
          {shown.rows.length > 0 ? (
            <ul>
              {shown.rows.map((r) => (
                <li key={r.key}>
                  {r.stroke ? (
                    <svg width="14" height="8" className="chart-tip-key" aria-hidden="true">
                      <line x1="1" x2="13" y1="4" y2="4" stroke={r.stroke.colour} strokeWidth={2} strokeDasharray={r.stroke.dash || undefined} />
                    </svg>
                  ) : (
                    <span className="chart-tip-key" />
                  )}
                  <span className="chart-tip-value">{r.value}</span>
                  <span className="chart-tip-label">{r.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
