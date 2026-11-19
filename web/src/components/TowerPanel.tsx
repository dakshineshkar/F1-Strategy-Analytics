"use client";

import { useId, useState, useSyncExternalStore } from "react";

import type { EntrantIndex } from "@/lib/entrants";
import type { DriverRow } from "@/lib/reducer";
import {
  COLUMNS,
  type ColumnId,
  DEFAULT_COLUMNS,
  loadColumns,
  loadPin,
  PRESET_LABEL,
  PRESETS,
  type PresetId,
  presetOf,
  saveColumns,
  savePin,
  toggleColumn,
  togglePin,
} from "@/lib/tower";

import { TimingTower } from "./TimingTower";

/** Re-read the saved choices when another tab of this browser changes them. */
function subscribeStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

// ``loadColumns`` returns a new array each call; useSyncExternalStore needs a stable snapshot.
let columnsCache: { key: string; value: ColumnId[] } | null = null;
function columnsSnapshot(): ColumnId[] {
  const value = loadColumns();
  const key = value.join();
  if (columnsCache === null || columnsCache.key !== key) columnsCache = { key, value };
  return columnsCache.value;
}
const serverColumns = (): readonly ColumnId[] => DEFAULT_COLUMNS;

/** The tower's visible columns and pinned car, kept per browser (guarded ``localStorage``; a
 * blocked storage keeps the choice for this page only). */
export function useTowerPrefs() {
  const storedColumns = useSyncExternalStore(subscribeStorage, columnsSnapshot, serverColumns);
  const storedPin = useSyncExternalStore(subscribeStorage, () => loadPin(), () => null);
  const [columns, setColumnsState] = useState<readonly ColumnId[] | null>(null);
  const [pin, setPinState] = useState<{ value: string | null } | null>(null);
  const visible = columns ?? storedColumns;
  const pinned = pin === null ? storedPin : pin.value;
  return {
    visible,
    pinned,
    setVisible: (next: readonly ColumnId[]) => {
      setColumnsState(next);
      saveColumns(next);
    },
    pinToggle: (driverId: string) => {
      const next = togglePin(pinned, driverId);
      setPinState({ value: next });
      savePin(next);
    },
  };
}

/** The "Columns" control: a disclosure with the Minimal / Full presets (a radio group; "Custom" when
 * the columns match neither) and one checkbox per column. Native controls only, so Tab, Space and
 * the arrow keys work as usual; Escape closes it and returns focus to the button. */
export function TowerColumns({
  visible,
  onChange,
}: {
  visible: readonly ColumnId[];
  onChange: (next: readonly ColumnId[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preset = presetOf(visible);
  const shown = new Set(visible);
  return (
    <div
      className="tower-columns"
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
        onClick={() => setOpen((o) => !o)}
      >
        Columns: {preset === null ? "Custom" : PRESET_LABEL[preset]}
      </button>
      <div id={`${id}-panel`} className="tower-columns-panel" hidden={!open}>
        <fieldset>
          <legend>Preset</legend>
          {(Object.keys(PRESETS) as PresetId[]).map((p) => (
            <label key={p} className="inline-field">
              <input
                type="radio"
                name={`${id}-preset`}
                checked={preset === p}
                onChange={() => onChange(PRESETS[p])}
              />
              {PRESET_LABEL[p]}
            </label>
          ))}
          {preset === null ? <span className="muted"> (custom)</span> : null}
        </fieldset>
        <fieldset>
          <legend>Show columns (Pos, Pin and Driver are always shown; kept in this browser)</legend>
          {COLUMNS.map((c) => (
            <label key={c.id} className="inline-field">
              <input
                type="checkbox"
                checked={shown.has(c.id)}
                onChange={(e) => onChange(toggleColumn(visible, c.id, e.target.checked))}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

/** The tower with its column control, its key and the per-browser pin (live and post-race). */
export function TowerPanel({
  rows,
  lapsDown,
  entrants,
  captionNote,
  extrasNote = null,
  callPair = null,
  staleLap,
}: {
  rows: DriverRow[];
  lapsDown: (driverId: string) => number;
  entrants: EntrantIndex;
  captionNote?: string;
  extrasNote?: string | null;
  /** live only: the call's pair (the only banded rows) */
  callPair?: { attackerId: string; defenderId: string } | null;
  /** live only: a stale car's last lap (``stale.ts``) */
  staleLap?: (driverId: string) => number | null;
}) {
  const prefs = useTowerPrefs();
  return (
    <>
      <TimingTower
        tools={<TowerColumns visible={prefs.visible} onChange={prefs.setVisible} />}
        rows={rows}
        lapsDown={lapsDown}
        entrants={entrants}
        visible={prefs.visible}
        pinned={prefs.pinned}
        onPin={prefs.pinToggle}
        extrasNote={extrasNote}
        callPair={callPair}
        {...(staleLap !== undefined ? { staleLap } : {})}
        {...(captionNote !== undefined ? { captionNote } : {})}
      />
    </>
  );
}
