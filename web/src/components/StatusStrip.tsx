"use client";

import type { ReactNode } from "react";

import { type Mode, type ModelIdentity, modelDetail } from "@/lib/call";
import { type RaceStatus, SOURCE_TEXT, STATUS_LABEL, STATUS_WORDS } from "@/lib/raceStatus";
import type { Connection } from "@/lib/reducer";
import type { LapProgress } from "@/lib/stale";

import { PhoneLabel } from "./PhoneLabel";

const CONN_TEXT: Record<Connection, string> = {
  connecting: "Connecting",
  connected: "Stream connected",
  reconnecting: "Reconnecting",
  closed: "Stream closed",
};
/** The connection's short form on a phone (``PhoneLabel``). */
const CONN_SHORT: Record<Connection, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  closed: "Closed",
};

/** The race page's persistent status band (critique F06, F10, F23, F28): what is playing (REPLAY 10×, PAUSED,
 * STOPPED, FINISHED, or LIVE), the SMOKE TEST stamp when the sample model scores, the lap, the track status,
 * the scoring model's id and the stream connection, each in its own cell (never a dot-joined string), and last the
 * replay transport (``children``, inline: nothing opens over the page). One band at any width, of the same height in
 * every replay state: on a wide screen one line; below about 1180 px the transport takes the strip's second line, and
 * on a phone the cells wrap (the race state first), some labels take a short form (``PhoneLabel``) and the transport
 * is its own full-width line, so nothing scrolls sideways or is cut. The mode cell is not a live region: the
 * transport's one hidden polite region announces each change once. */
export function StatusStrip({
  mode,
  model,
  lap,
  laps,
  progress = null,
  raceStatus,
  connection,
  sessionEnded,
  children,
}: {
  mode: Mode;
  model: ModelIdentity | null;
  lap: number | null;
  laps: number | null;
  /** how many running cars have crossed the line on the leader's lap */
  progress?: LapProgress | null;
  raceStatus: RaceStatus | null;
  connection: Connection;
  sessionEnded: boolean;
  /** the replay transport (ReplayTransport) */
  children: ReactNode;
}) {
  const kind = raceStatus?.status ?? "unknown";
  // no status after the replay ended, or for a stored state (the API records the status of laps it replays): a dash
  // and why, never "status not known yet"
  const over = raceStatus === null && (mode.tone === "ended" || mode.tone === "stored");
  const overText = mode.tone === "stored" ? "not replaying" : mode.label === "FINISHED" ? "race finished" : "replay ended";
  const ended = connection === "closed" && sessionEnded;
  const conn = ended ? "Session ended" : CONN_TEXT[connection];
  const connShort = ended ? "Ended" : CONN_SHORT[connection];
  return (
    <section className="status-strip" aria-label="Race status">
      {/* one group: laid out as cells of the strip; on a phone they wrap onto two lines */}
      <div className="ss-cells">
        <p className={`ss-mode tone-${mode.tone}`} title={mode.description}>
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
        <p className="ss-cell ss-progress" title="Running cars that have crossed the line on the leader's lap (cars with no timing for 2 or more laps are not counted)">
          {progress === null ? null : (
            <>
              <span className="num">{progress.crossed}</span>
              <span className="ss-k">of</span>
              <span className="num">{progress.running}</span>
              <span className="ss-k">crossed</span>
            </>
          )}
        </p>
        <p className={`ss-cell ss-track race-status race-status-${kind}`} title={raceStatus === null ? undefined : SOURCE_TEXT[raceStatus.source]}>
          <span className="ss-k">Track</span>{" "}
          <span className="ss-v race-status-code">
            {over ? "—" : STATUS_LABEL[kind]}
            {raceStatus?.source === "estimated" ? <span className="race-status-est"> est.</span> : null}
          </span>
          {over ? <span className="ss-detail">{overText}</span> : null}
          <span className="visually-hidden">{over ? `: no status, ${overText}` : `: ${STATUS_WORDS[kind]}`}</span>
        </p>
        <p className="ss-cell ss-model" title={model === null ? undefined : modelDetail(model)}>
          <span className="ss-k">Model</span>{" "}
          <span className="ss-v num">{model === null ? "unavailable" : model.version}</span>
          {model !== null && modelDetail(model) ? <span className="ss-detail">{modelDetail(model)}</span> : null}
        </p>
        <p className={`ss-cell ss-conn conn conn-${connection}`}>
          <span className={`ss-dot dot-${connection}`} aria-hidden="true" />
          <PhoneLabel full={conn} short={connShort} />
        </p>
      </div>
      <div className="ss-end">{children}</div>
    </section>
  );
}
