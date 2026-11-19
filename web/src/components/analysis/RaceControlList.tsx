"use client";

import { useId, useState } from "react";

import { RC_KIND_LABEL, raceControlRows, type RaceControlMsg } from "@/lib/analysis";

import { LapLink, type Names } from "./common";

/** "07:03:36" from an ISO UTC time (null stays a dash). */
export function clock(iso: string | null): string {
  const m = iso === null ? null : /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? "—";
}

/** The race-control timeline: key events (SC, VSC, red flags, penalties) by default, every
 * message on request; each with a lap link, a text kind label and the UTC time. */
export function RaceControlList({ rows, names, onLap }: { rows: readonly RaceControlMsg[]; names: Names; onLap: (lap: number) => void }) {
  const id = useId();
  const [all, setAll] = useState(false);
  const shown = raceControlRows(rows, all);
  const keyCount = rows.filter((r) => r.is_key).length;
  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <div className="panel-head">
        <h2 id={`${id}-h`}>Race control</h2>
        {rows.length > 0 ? (
          <label className="inline-field">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all {rows.length} messages
          </label>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="muted">No race-control messages in this lake for this race.</p>
      ) : (
        <>
          <p className="panel-note" aria-live="polite">
            {all ? `All ${rows.length} messages.` : `${keyCount} key events (SC, VSC, red flags, penalties) of ${rows.length} messages.`}
          </p>
          <ol className="rc-list">
            {shown.map((r) => (
              <li key={r.seq} className={r.is_key ? "is-key" : undefined}>
                <span className="rc-lap">{r.lap !== null ? <LapLink lap={r.lap} onLap={onLap} /> : "—"}</span>
                <span className={`rc-kind rc-${r.kind}`}>{RC_KIND_LABEL[r.kind]}</span>
                <span className="rc-time">{clock(r.time_utc)} UTC</span>
                <span className="rc-msg">
                  {r.message ?? ""}
                  {r.driver_id ? <span className="visually-hidden"> ({names.name(r.driver_id)})</span> : null}
                  {r.is_key ? <span className="tag rc-key-tag">Key</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
