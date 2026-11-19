"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

import { type Mode, type ModelIdentity, modelDetail } from "@/lib/call";
import { type RaceStatus, SOURCE_TEXT, STATUS_LABEL, STATUS_WORDS } from "@/lib/raceStatus";
import type { Connection } from "@/lib/reducer";

const CONN_TEXT: Record<Connection, string> = {
  connecting: "Connecting",
  connected: "Stream connected",
  reconnecting: "Reconnecting",
  closed: "Stream closed",
};

/** The race page's persistent status band (critique F06, F10, F23, F28): what is playing (REPLAY 10×, PAUSED,
 * STOPPED, FINISHED, or LIVE), the SMOKE TEST stamp when the sample model scores, the lap, the track status,
 * the scoring model's id and the stream connection, each in its own cell (never a dot-joined string), plus the
 * replay drawer. One band at any width; the cells wrap inside it on a phone. The mode cell is a polite status
 * region, so a pause, stop or finish is announced once. */
export function StatusStrip({
  mode,
  model,
  lap,
  laps,
  raceStatus,
  connection,
  sessionEnded,
  onArchive,
  children,
}: {
  mode: Mode;
  model: ModelIdentity | null;
  lap: number | null;
  laps: number | null;
  raceStatus: RaceStatus | null;
  connection: Connection;
  sessionEnded: boolean;
  /** switch to the post-race archive (shown once the replay or session has ended) */
  onArchive: (() => void) | null;
  /** the replay drawer */
  children: ReactNode;
}) {
  const kind = raceStatus?.status ?? "unknown";
  const conn = connection === "closed" && sessionEnded ? "Session ended" : CONN_TEXT[connection];
  return (
    <section className="status-strip" aria-label="Race status">
      <p className={`ss-mode tone-${mode.tone}`} role="status" aria-live="polite" title={mode.description}>
        <span className="ss-mode-label">{mode.label}</span>
        <span className="visually-hidden">{`: ${mode.description}`}</span>
      </p>
      {model?.smoke ? (
        <p className="stamp stamp-smoke" title="The sample deployment model, trained on the two sample races: a smoke test of the pipeline, not a result.">
          SMOKE TEST
          <span className="visually-hidden">: the sample model is scoring; its probabilities are not results.</span>
        </p>
      ) : null}
      <p className="ss-cell ss-lap">
        <span className="ss-k">Lap</span>{" "}
        <span className="num ss-v" aria-label={`Lap ${lap ?? 0} of ${laps ?? "unknown"}`}>
          <span className="lc-now">{lap ?? "—"}</span>
          <span className="ss-of">/{laps ?? "—"}</span>
        </span>
      </p>
      <p className={`ss-cell ss-track race-status race-status-${kind}`} title={raceStatus === null ? undefined : SOURCE_TEXT[raceStatus.source]}>
        <span className="ss-k">Track</span>{" "}
        <span className="ss-v race-status-code">
          {STATUS_LABEL[kind]}
          {raceStatus?.source === "estimated" ? <span className="race-status-est"> est.</span> : null}
        </span>
        <span className="visually-hidden">{`: ${STATUS_WORDS[kind]}`}</span>
      </p>
      <p className="ss-cell ss-model" title={model === null ? undefined : modelDetail(model)}>
        <span className="ss-k">Model</span>{" "}
        <span className="ss-v num">{model === null ? "unavailable" : model.version}</span>
        {model !== null && modelDetail(model) ? <span className="ss-detail">{modelDetail(model)}</span> : null}
      </p>
      <p className={`ss-cell ss-conn conn conn-${connection}`}>
        <span className={`ss-dot dot-${connection}`} aria-hidden="true" />
        {conn}
      </p>
      {onArchive !== null ? (
        <button type="button" className="btn btn-quiet btn-small ss-archive" onClick={onArchive}>
          Open the post-race archive
        </button>
      ) : null}
      <div className="ss-end">{children}</div>
    </section>
  );
}

/** The replay controls as a drawer under the status strip (they are demo controls, not race state: critique
 * F06). The drawer overlays the page, so opening it moves nothing; Escape or a click outside closes it and
 * focus returns to its button. ``open`` is controlled, so the call's empty state can open it. */
export function ReplayDrawer({
  open,
  onOpenChange,
  summary = "",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** a short extra state for the button; the status strip's mode cell already names the replay state */
  summary?: string;
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) root.current?.querySelector<HTMLElement>(".replay-drawer-panel button:not([disabled]), .replay-drawer-panel input")?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);
  return (
    <div
      className="replay-drawer"
      ref={root}
      onKeyDown={(e) => {
        if (open && (e.key === "Escape" || e.key === "Esc")) {
          onOpenChange(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="btn btn-small"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => onOpenChange(!open)}
      >
        Replay controls
        {summary ? <span className="replay-drawer-summary">{summary}</span> : null}
      </button>
      <div id={`${id}-panel`} className="replay-drawer-panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
