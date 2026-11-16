import type { ReactNode } from "react";

import { TyreGlyph } from "@/components/TyreGlyph";
import { analysisSearch, compoundKey, compoundName, type KnownCompound } from "@/lib/analysis";
import { fullName, type EntrantIndex } from "@/lib/entrants";
import { driverName } from "@/lib/format";

/** How a view names a driver: the code, the full name, the team (for colours), from the entrants
 * when the lake has them, else the analysis rows' code and a name built from the driver id. */
export interface Names {
  code: (id: string) => string;
  name: (id: string) => string;
  team: (id: string) => { team: string; colour: string } | null;
}

export function makeNames(entrants: EntrantIndex | null, codes: Map<string, string>): Names {
  return {
    code: (id) => entrants?.[id]?.code ?? codes.get(id) ?? id.slice(0, 3).toUpperCase(),
    name: (id) => {
      const e = entrants?.[id];
      return e ? fullName(e) : driverName(id);
    },
    team: (id) => {
      const e = entrants?.[id];
      return e ? { team: e.constructor_id, colour: e.team_colour_hex } : null;
    },
  };
}

/** A compound as glyph (shape) + name (text); the colour is the third cue, never the only one. */
export function CompoundTag({ compound }: { compound: KnownCompound | null }) {
  return (
    <span className={`compound-tag compound-${compoundKey(compound)}`}>
      <TyreGlyph compound={compound ?? "UNKNOWN"} size={13} /> {compoundName(compound)}
    </span>
  );
}

/** An SVG point marker whose shape follows the compound (the same shapes as ``TyreGlyph``). */
export function CompoundMark({ compound, x, y, r = 4 }: { compound: KnownCompound | null; x: number; y: number; r?: number }) {
  const k = compoundKey(compound);
  const style = { color: `var(--compound-${k})` };
  switch (compound) {
    case "SOFT":
      return <circle cx={x} cy={y} r={r} fill="currentColor" stroke="var(--surface)" strokeWidth={0.75} style={style} />;
    case "MEDIUM":
      return (
        <g style={style}>
          <circle cx={x} cy={y} r={r} fill="var(--surface)" stroke="currentColor" strokeWidth={1.5} />
          <path d={`M${x} ${y - r}a${r} ${r} 0 0 1 0 ${2 * r}z`} fill="currentColor" />
        </g>
      );
    case "HARD":
      return <circle cx={x} cy={y} r={r - 0.5} fill="var(--surface)" stroke="currentColor" strokeWidth={2.25} style={style} />;
    case "INTERMEDIATE":
      return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} fill="var(--surface)" stroke="currentColor" strokeWidth={1.75} style={style} />;
    case "WET":
      return <path d={`M${x} ${y - r - 1}L${x + r} ${y + r}H${x - r}z`} fill="var(--surface)" stroke="currentColor" strokeWidth={1.75} style={style} />;
    default:
      return <circle cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="2 2" style={style} />;
  }
}

/** A link to the lap-times view with lap ``lap`` marked (a real link: it also works without script). */
export function LapLink({ lap, onLap, children }: { lap: number; onLap: (lap: number) => void; children?: ReactNode }) {
  return (
    <a
      href={analysisSearch({ view: "laps", lap })}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onLap(lap);
      }}
    >
      {children ?? `Lap ${lap}`}
    </a>
  );
}

/** The numbers behind a chart, in a real table behind a "Show table" disclosure (native
 * ``<details>``, keyboard-operable), scrolling inside its own region on narrow screens. */
export function ChartTable({ caption, head, children }: { caption: string; head: ReactNode; children: ReactNode }) {
  return (
    <details className="chart-table">
      <summary>Show table</summary>
      <div className="tower-wrap" role="region" aria-label={caption} tabIndex={0}>
        <table className="tower analysis-table">
          <caption>{caption}</caption>
          <thead>{head}</thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </details>
  );
}

export function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="analysis-notes">
      {notes.map((n) => (
        <li key={n} className={n.startsWith("SYNTHETIC") ? "is-synthetic" : undefined}>
          {n}
        </li>
      ))}
    </ul>
  );
}
