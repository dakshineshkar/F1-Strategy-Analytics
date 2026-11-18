"use client";

import { useState } from "react";

import type { Replay } from "@/lib/api";
import { isActive, replayControls, replayLapText, replayStatusText, SPEEDS, type Speed } from "@/lib/replays";

/**
 * Start a replay of this race, and while it is active (Feature 7) pause / resume it, change its
 * speed or stop it. Before a start the speed radios choose the start speed; during a replay they
 * show the API's speed and changing one changes the replay's speed. The status line (state and
 * speed) is a polite live region, so each state change is announced once; the lap reached is
 * shown next to it without being announced every lap.
 */
export function ReplayControl(props: {
  current: Replay | null;
  anyRunning: boolean;
  enabled: boolean | null;
  pending: boolean;
  error: string | null;
  onStart: (speed: Speed) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onSpeed: (speed: Speed) => void;
}) {
  const [chosen, setChosen] = useState<Speed>(60);
  // A speed change in flight: the radios show it until the request (and its status refresh) is
  // done, then follow the API again (so a refused change reverts). Cleared during render.
  const [requested, setRequested] = useState<Speed | null>(null);
  if (requested !== null && !props.pending) setRequested(null);
  const c = replayControls(props.current, props.anyRunning, props.enabled, props.pending, chosen);
  const active = isActive(props.current);
  const shownSpeed = active && requested !== null ? requested : c.shownSpeed;
  const status = replayStatusText(props.current, props.anyRunning, props.enabled);
  const pickSpeed = (s: Speed) => {
    setChosen(s);
    if (active && s !== shownSpeed) {
      setRequested(s);
      props.onSpeed(s);
    }
  };
  return (
    <section className="panel replay-panel" aria-labelledby="replay-h">
      <h2 id="replay-h">Replay</h2>
      <form
        className="replay-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (c.canStart) props.onStart(chosen);
        }}
      >
        <fieldset className="speeds" disabled={!c.canChangeSpeed}>
          <legend>Speed</legend>
          {SPEEDS.map((s) => (
            <label key={s} className="speed">
              <input type="radio" name="speed" value={s} checked={shownSpeed === s} onChange={() => pickSpeed(s)} />
              <span>{s}×</span>
            </label>
          ))}
        </fieldset>
        <div className="replay-actions">
          <button type="submit" className="btn" disabled={!c.canStart} aria-describedby="replay-status">
            {props.pending && !active ? "Starting…" : "Start replay"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!c.canPause}
            aria-describedby="replay-status"
            onClick={() => (c.pauseLabel === "Resume" ? props.onResume() : props.onPause())}
          >
            {c.pauseLabel}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!c.canStop}
            aria-describedby="replay-status"
            onClick={() => props.onStop()}
          >
            Stop
          </button>
        </div>
      </form>
      <p
        id="replay-status"
        className={`replay-status state-${props.current?.state ?? "idle"}`}
        role="status"
        aria-live="polite"
      >
        {status}
      </p>
      <p className="replay-lap">{replayLapText(props.current)}</p>
      <p className="replay-error" role="alert">
        {props.error ?? ""}
      </p>
    </section>
  );
}
