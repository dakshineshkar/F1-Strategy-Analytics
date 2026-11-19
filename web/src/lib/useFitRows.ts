"use client";

import { useEffect, useRef, useState } from "react";

/** How many whole rows of ``rowPx`` fit in ``availablePx`` after a footer of ``footerPx`` (at least 1). A
 * list that fits entirely needs no footer. Pure, unit-tested. */
export function fitRows(availablePx: number, rowPx: number, total: number, footerPx: number): number {
  if (!(rowPx > 0) || !(availablePx > 0)) return 1;
  if (total * rowPx <= availablePx) return Math.max(1, total);
  return Math.max(1, Math.floor((availablePx - footerPx) / rowPx));
}

/** Rows hidden below the visible window of a list scrolled by ``scrollPx``. */
export function rowsBelow(total: number, visible: number, scrollPx: number, rowPx: number): number {
  const first = rowPx > 0 ? Math.round(Math.max(0, scrollPx) / rowPx) : 0;
  return Math.max(0, total - visible - first);
}

/** A length in ``rem`` or ``px`` (a CSS custom property's value) in pixels; null when it is neither. */
export function cssLengthPx(value: string, rootPx: number): number | null {
  const v = value.trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  if (v.endsWith("rem")) return n * rootPx;
  if (v.endsWith("px")) return n;
  return null;
}

/** The element's content height and the pixel value of its ``--row`` custom property, kept up to date with a
 * ResizeObserver (0 and ``fallbackRowPx`` on the server and the first render). The alert feed uses them to show
 * whole rows only; the row height differs per breakpoint (globals.css), so it is read, never assumed. */
export function useRowBox<T extends HTMLElement>(fallbackRowPx: number) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ height: 0, rowPx: fallbackRowPx });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect.height ?? 0);
      let rowPx = fallbackRowPx;
      try {
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        rowPx = cssLengthPx(getComputedStyle(el).getPropertyValue("--row"), root) ?? fallbackRowPx;
      } catch {
        // no computed style (a test DOM): keep the fallback
      }
      setBox((b) => (Math.abs(b.height - h) < 1 && b.rowPx === rowPx ? b : { height: h, rowPx }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallbackRowPx]);
  return { ref, ...box };
}
