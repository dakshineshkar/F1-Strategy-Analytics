"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { Replay } from "@/lib/api";
import {
  blockedReason,
  CONFIRM_MS,
  type ConfirmState,
  confirmStep,
  isActive,
  replayAgainSpeed,
  replayControls,
  SPEEDS,
  type Speed,
  transportPhase,
} from "@/lib/replays";

import { PauseMark, PlayMark, ReplayMark, StopMark } from "./Marks";

/**
 * The replay transport: inline at the right end of the status strip, always visible, never over the page (it
 * replaced the replay popover, which covered the call). Shared by the Race and Engineer tabs, because the strip is.
 *   - idle: "Start replay" (neutral, never the signal amber) and the 1×/10×/60× speed choice;
 *   - blocked: the same Start, disabled, with why as visible text (another race replays, or replay is off);
 *   - active (starting, running, paused): Pause or Resume, Stop and the speed (a change sets the replay's speed);
 *   - over (finished, stopped, failed, or the session ended): "Replay again" (the last run's speed) and the
 *     post-race archive when there is one.
 * Stop is irreversible: the first press turns it into "Confirm stop" for about 4 s; Escape, the timeout or the
 * replay ending on its own cancels it; the second press stops. Each phase keeps the same reserved box, so the strip
 * never changes height. The replay's state is announced once per change by one visually hidden polite region
 * (``liveText``); the strip's mode chip and lap counter show it.
 */
export function ReplayTransport(props: {
  current: Replay | null;
  anyRunning: boolean;
  enabled: boolean | null;
  pending: boolean;
  /** the replay or the session ended (the strip's mode is STOPPED, FAILED or FINISHED) */
  ended: boolean;
  /** the page's one polite announcement of the race mode */
  liveText: string;
  /** switch to the post-race archive (null: there is none) */
  onArchive: (() => void) | null;
  onStart: (speed: Speed) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onSpeed: (speed: Speed) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<Speed>(60);
  // A speed change in flight: the radios show it until the request (and its status refresh) is done, then follow
  // the API again (so a refused change reverts). Cleared during render.
  const [requested, setRequested] = useState<Speed | null>(null);
  if (requested !== null && !props.pending) setRequested(null);
  const c = replayControls(props.current, props.anyRunning, props.enabled, props.pending, chosen);
  const active = isActive(props.current);
  const phase = transportPhase(props.current, props.anyRunning, props.enabled, props.ended);
  const shownSpeed = active && requested !== null ? requested : c.shownSpeed;

  // Stop's two-press confirmation; the replay leaving the active phase (it finished or failed on its own) disarms it
  const [confirm, setConfirm] = useState<ConfirmState>("idle");
  if (confirm === "armed" && !(active && c.canStop)) setConfirm("idle");
  useEffect(() => {
    if (confirm !== "armed") return;
    const timer = setTimeout(() => setConfirm((s) => confirmStep(s, "timeout", true).state), CONFIRM_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Esc") setConfirm((s) => confirmStep(s, "escape", true).state);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirm]);
  const pressStop = () => {
    const r = confirmStep(confirm, "press", active && c.canStop);
    setConfirm(r.state);
    if (r.fire) props.onStop();
  };

  // A phase change removes the focused button (Start, Stop, Replay again), and a request in flight disables it: once
  // the new controls are usable, focus moves to the first of them instead of falling back to the page. Only when the
  // focus was in the transport (a blur to elsewhere on the page clears that).
  const focusWithin = useRef(false);
  useEffect(() => {
    if (!focusWithin.current || props.pending) return;
    const el = document.activeElement;
    if (el !== null && el !== document.body) return;
    root.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus();
  }, [phase, props.pending]);

  const pickSpeed = (s: Speed) => {
    setChosen(s);
    if (active && s !== shownSpeed) {
      setRequested(s);
      props.onSpeed(s);
    }
  };
  const againSpeed = replayAgainSpeed(props.current, chosen);
  const starting = props.pending && !active;

  const speeds = (
    <fieldset className="tp-speeds" disabled={!c.canChangeSpeed}>
      <legend className="visually-hidden">Replay speed</legend>
      {SPEEDS.map((s) => (
        <label key={s} className="tp-speed">
          <input type="radio" name={`${id}-speed`} value={s} checked={shownSpeed === s} onChange={() => pickSpeed(s)} />
          <span>{s}×</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <div
      ref={root}
      className={`transport phase-${phase}`}
      role="group"
      aria-label="Replay"
      onFocus={() => (focusWithin.current = true)}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && root.current?.contains(e.relatedTarget)) return;
        // a button disabled while its request is in flight loses focus to nothing: the focus is still "here"
        if (e.relatedTarget === null && e.target instanceof HTMLButtonElement && e.target.disabled) return;
        focusWithin.current = false;
      }}
    >
      {phase === "idle" || phase === "blocked" ? (
        <>
          <button type="button" className="btn btn-small btn-strong tp-start" disabled={!c.canStart} onClick={() => c.canStart && props.onStart(chosen)}>
            <PlayMark />
            {starting ? "Starting…" : "Start replay"}
          </button>
          {phase === "blocked" ? <span className="tp-reason">{blockedReason(props.anyRunning, props.enabled)}</span> : speeds}
        </>
      ) : null}
      {phase === "active" ? (
        <>
          <button
            type="button"
            className="btn btn-small tp-pause"
            disabled={!c.canPause}
            onClick={() => (c.pauseLabel === "Resume" ? props.onResume() : props.onPause())}
          >
            {c.pauseLabel === "Resume" ? <PlayMark /> : <PauseMark />}
            {c.pauseLabel}
          </button>
          <button
            type="button"
            className={`btn btn-small tp-stop${confirm === "armed" ? " btn-confirm" : ""}`}
            disabled={!c.canStop}
            aria-describedby={confirm === "armed" ? `${id}-stop-hint` : undefined}
            onClick={pressStop}
          >
            <StopMark />
            {confirm === "armed" ? "Confirm stop" : "Stop"}
          </button>
          <span id={`${id}-stop-hint`} className="visually-hidden">
            Stops the replay; it cannot be resumed. Press again to confirm, Escape to cancel.
          </span>
          {speeds}
        </>
      ) : null}
      {phase === "over" ? (
        <>
          <button
            type="button"
            className="btn btn-small btn-strong tp-again"
            disabled={!c.canStart}
            title={`Starts a new replay at ${againSpeed}×, the last run's speed`}
            aria-describedby={`${id}-again-hint`}
            onClick={() => c.canStart && props.onStart(againSpeed)}
          >
            <ReplayMark />
            {starting ? "Starting…" : "Replay again"}
          </button>
          <span id={`${id}-again-hint`} className="visually-hidden">{`at ${againSpeed}×, the last run's speed`}</span>
          {props.onArchive !== null ? (
            <button type="button" className="btn btn-small btn-quiet tp-archive" onClick={props.onArchive}>
              Open the post-race archive
            </button>
          ) : null}
        </>
      ) : null}
      <p id="replay-status" className="visually-hidden" role="status" aria-live="polite">
        {props.liveText}
      </p>
    </div>
  );
}
