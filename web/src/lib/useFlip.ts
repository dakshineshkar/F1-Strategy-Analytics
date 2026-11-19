"use client";

import { type RefObject, useLayoutEffect, useRef } from "react";

/** FLIP duration and easing (DESIGN.md, Motion): ≤ 200 ms, the on-screen-move curve. */
export const FLIP_MS = 200;
export const FLIP_EASING = "cubic-bezier(0.65, 0, 0.35, 1)";
/** A row that moved further than this (px) jumps instead: a long slide reads as noise, not a pass. */
export const FLIP_MAX_PX = 8 * 28;

/** The vertical offset to invert a row by: its old top minus its new top, or null when it should not
 * animate (new row, no move, or a move too long to read). */
export function flipDelta(before: number | undefined, after: number, maxPx: number = FLIP_MAX_PX): number | null {
  if (before === undefined) return null;
  const dy = before - after;
  if (dy === 0 || Math.abs(dy) > maxPx) return null;
  return dy;
}

/** FLIP moves for reordered rows. Every element under ``container`` with ``data-flip="<id>"`` is measured
 * after each change of ``signature`` (the order); a row whose layout top changed is inverted with a
 * ``transform`` before the browser paints, then played back to its place with the Web Animations API. Only
 * the painted image moves (transform), so nothing else on the page is displaced. Off under
 * ``prefers-reduced-motion: reduce`` and where ``Element.animate`` is missing. ``maxPx`` caps the slide (the
 * tower jumps a long way instead; a short list in its own scroll box slides any distance). */
export function useFlip(container: RefObject<HTMLElement | null>, signature: string, maxPx: number = FLIP_MAX_PX): void {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]"));
    const next = new Map<string, number>();
    for (const r of rows) next.set(r.dataset.flip ?? "", r.offsetTop);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    if (!reduce) {
      for (const r of rows) {
        const dy = flipDelta(tops.current.get(r.dataset.flip ?? ""), next.get(r.dataset.flip ?? "") ?? 0, maxPx);
        if (dy === null || typeof r.animate !== "function") continue;
        r.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
          duration: FLIP_MS,
          easing: FLIP_EASING,
        });
      }
    }
    tops.current = next;
  }, [container, signature, maxPx]);
}
