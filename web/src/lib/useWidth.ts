"use client";

import { useEffect, useRef, useState } from "react";

export const MIN_WIDTH = 280;

/** The element's content width, kept up to date with a ResizeObserver (the first render, and the
 * server render, use ``fallback``). Charts redraw their ``viewBox`` at this width, so text keeps its
 * size instead of being scaled. */
export function useWidth<T extends HTMLElement>(fallback: number, min = MIN_WIDTH) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) >= 1) setWidth(Math.max(min, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, min]);
  return { ref, width };
}
