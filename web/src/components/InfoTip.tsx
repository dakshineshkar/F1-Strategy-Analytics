"use client";

import { useState } from "react";

import { dismissesTip, glossary, tipId, type GlossaryId } from "@/lib/legend";

/** A small "?" button that explains one marker. The text is always in the DOM and linked with
 * ``aria-describedby``, so screen readers read it on focus; sighted users see it on hover, on keyboard
 * focus, or after a click or tap (it stays open until clicked again, Escape or blur). Escape also
 * hides a tooltip shown by hover or focus. No colour carries meaning. */
export function InfoTip({
  id,
  scope,
  align = "start",
  label,
}: {
  id: GlossaryId;
  /** Keeps the tooltip id unique when one entry has a tip in two places (``tipId``). */
  scope?: string;
  align?: "start" | "end";
  /** Overrides the glossary label, so two tips on one page never share an accessible name. */
  label?: string;
}) {
  const entry = glossary(id);
  const tid = tipId(id, scope);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className={`info-tip info-tip-${align}`}
      data-open={open ? "true" : undefined}
      data-dismissed={dismissed ? "true" : undefined}
      onMouseLeave={() => setDismissed(false)}
    >
      <button
        type="button"
        className="info-tip-btn"
        aria-label={`About ${label ?? entry.label}`}
        aria-describedby={tid}
        aria-expanded={open}
        onClick={() => {
          setDismissed(false);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (dismissesTip(e.key)) {
            setOpen(false);
            setDismissed(true);
          }
        }}
        onFocus={() => setDismissed(false)}
        onBlur={() => setOpen(false)}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span role="tooltip" id={tid} className="info-tip-text">
        {entry.text}
      </span>
    </span>
  );
}
