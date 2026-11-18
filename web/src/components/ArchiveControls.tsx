"use client";

import { type Dispatch, type KeyboardEvent, useState } from "react";

import { tabKeyTarget } from "@/lib/analysis";
import {
  lapPercent,
  lapValueText,
  MARKER_LANES,
  markerRows,
  type Marker,
  PLAY_SPEEDS,
  type Playback,
  type PlaybackAction,
} from "@/lib/archive";
import { useWidth } from "@/lib/useWidth";

const ROW_REM = 1.6;
const markerPx = (code: string) => (code.length <= 1 ? 24 : code.length * 9 + 12);

/** The post-race transport: a lap slider (native range input: arrows, Page Up/Down, Home, End),
 * step and play/pause buttons, the 1×/10×/60× speed, and the event markers laid out along the
 * slider in three labelled lanes. The markers are one toolbar (a single tab stop; arrows, Home and
 * End move between them) and each one is a button that jumps to its lap. Every marker shows a text
 * code and has a full accessible name, so nothing depends on colour. */
export function ArchiveControls({
  laps,
  total,
  state,
  dispatch,
  markers,
}: {
  laps: readonly number[];
  total: number;
  state: Playback;
  dispatch: Dispatch<PlaybackAction>;
  markers: readonly Marker[];
}) {
  const first = laps[0] ?? 1;
  const last = laps[laps.length - 1] ?? 1;
  const [active, setActive] = useState(0);
  const track = useWidth<HTMLDivElement>(640, 120);
  const onMarkerKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const target = tabKeyTarget(e.key, i, markers.length);
    if (target === null) return;
    e.preventDefault();
    setActive(target);
    document.getElementById(`ac-marker-${target}`)?.focus();
  };
  return (
    <section className="panel archive-controls" aria-labelledby="archive-h">
      <div className="panel-head">
        <h2 id="archive-h">Post-race replay</h2>
        <p className="ac-status" role="status">
          {state.playing ? `Playing at ${state.speed}×` : "Paused"}
        </p>
      </div>
      <div className="ac-buttons">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => dispatch({ type: "step", by: -1 })}
          disabled={state.lap <= first}
          aria-label="Previous lap"
        >
          −1 lap
        </button>
        <button type="button" className="btn ac-play" onClick={() => dispatch({ type: "toggle" })}>
          {state.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => dispatch({ type: "step", by: 1 })}
          disabled={state.lap >= last}
          aria-label="Next lap"
        >
          +1 lap
        </button>
        <fieldset className="speeds">
          <legend>Speed</legend>
          {PLAY_SPEEDS.map((s) => (
            <label key={s} className="speed">
              <input
                type="radio"
                name="archive-speed"
                value={s}
                checked={state.speed === s}
                onChange={() => dispatch({ type: "speed", speed: s })}
              />
              <span>{s}×</span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="ac-grid">
        <label htmlFor="archive-lap" className="ac-lane-name">
          Lap
        </label>
        <input
          id="archive-lap"
          className="ac-slider"
          type="range"
          min={first}
          max={last}
          step={1}
          value={state.lap}
          aria-valuetext={lapValueText(state.lap, total)}
          onChange={(e) => dispatch({ type: "seek", lap: Number(e.target.value) })}
        />
        <div className="ac-lanes" role="toolbar" aria-label="Race events: jump to a lap" aria-orientation="horizontal">
          {MARKER_LANES.map((lane) => {
            const items = markers.map((m, i) => ({ m, i })).filter(({ m }) => lane.kinds.includes(m.kind));
            const rows = markerRows(
              items.map(({ m }) => m.lap),
              first,
              last,
              track.width,
              Math.max(...items.map(({ m }) => markerPx(m.code)), 24),
            );
            const height = (Math.max(...rows, 0) + 1) * ROW_REM;
            return (
              <div key={lane.id} className="ac-lane">
                <span className="ac-lane-name" aria-hidden="true">
                  {lane.label}
                </span>
                <div className="ac-track" ref={lane.id === "flags" ? track.ref : undefined} style={{ height: `${height}rem` }}>
                  {items.length === 0 ? <span className="ac-none">none</span> : null}
                  {items.map(({ m, i }, k) => (
                    <button
                      key={`${m.kind}-${m.lap}`}
                      id={`ac-marker-${i}`}
                      type="button"
                      className={`ac-marker ac-${m.kind}`}
                      style={{ left: `${lapPercent(m.lap, first, last)}%`, top: `${(rows[k] ?? 0) * ROW_REM}rem` }}
                      tabIndex={i === Math.min(active, markers.length - 1) ? 0 : -1}
                      aria-label={m.label}
                      aria-current={m.lap === state.lap ? "true" : undefined}
                      title={m.label.replace(/\. Jump to lap \d+$/, "")}
                      onClick={() => {
                        setActive(i);
                        dispatch({ type: "seek", lap: m.lap });
                      }}
                      onKeyDown={(e) => onMarkerKey(e, i)}
                    >
                      {m.code}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
