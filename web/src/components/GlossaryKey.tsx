"use client";

import { useEffect, useId, useRef, useState } from "react";

import { glossary, type GlossaryId, tipId } from "@/lib/legend";

/** One "Key" button per panel instead of a "?" per column header (critique F29, F30): a disclosure whose
 * popover lists the panel's glossary entries. The entries stay in the DOM while closed (``hidden``), each
 * ``<dd>`` carrying the tip id, so every row marker's ``aria-describedby`` still resolves. The popover
 * overlays the page (no layout shift), stays inside the viewport (it opens towards the panel's inside
 * edge), closes on Escape (focus returns to the button) and on a click outside. */
export function GlossaryKey({
  ids,
  label,
  align = "end",
}: {
  ids: readonly GlossaryId[];
  /** the accessible name's subject, e.g. "the timing tower" */
  label: string;
  /** which edge of the button the popover lines up with */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div
      className={`gkey gkey-${align}`}
      ref={root}
      onKeyDown={(e) => {
        if (open && (e.key === "Escape" || e.key === "Esc")) {
          setOpen(false);
          document.getElementById(`${id}-btn`)?.focus();
        }
      }}
    >
      <button
        type="button"
        id={`${id}-btn`}
        className="btn btn-quiet btn-small"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={`Key to ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        Key
      </button>
      <div id={`${id}-panel`} className="gkey-panel" hidden={!open}>
        <dl>
          {ids.map((g) => {
            const e = glossary(g);
            return (
              <div key={g} className="gkey-item">
                <dt>{e.term}</dt>
                <dd id={tipId(g)}>{e.text}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}
