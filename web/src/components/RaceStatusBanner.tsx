"use client";

import { useEffect, useRef, useState } from "react";

import { tipId } from "@/lib/legend";
import {
  type RaceStatus,
  SOURCE_TEXT,
  STATUS_LABEL,
  STATUS_WORDS,
  statusAnnouncement,
} from "@/lib/raceStatus";

import { InfoTip } from "./InfoTip";

/** The race-status banner (Feature 5, display only): a text code (GREEN / SC / VSC / RED FLAG /
 * SC / VSC estimated / UNKNOWN) with a border style per status, the latest key race-control message
 * and its lap, and where the status comes from. Screen readers hear it politely, and only when the
 * status changes (a new lap or message with the same status stays silent). */
export function RaceStatusBanner({
  status,
  unavailable = null,
  announce = true,
}: {
  status: RaceStatus | null;
  /** Shown instead of the status when there is none (e.g. a v1 archive bundle). */
  unavailable?: string | null;
  /** False in the post-race mode: like its alert feed, the archive never speaks while scrubbing. */
  announce?: boolean;
}) {
  const previous = useRef<RaceStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const text = statusAnnouncement(previous.current, status);
    if (status !== null) previous.current = status;
    if (text !== null && announce) setAnnouncement(text);
  }, [status, announce]);

  const kind = status?.status ?? "unknown";
  return (
    <section className={`race-status race-status-${kind}`} aria-labelledby="race-status-h">
      <h2 id="race-status-h" className="visually-hidden">
        Race status
      </h2>
      <span className="race-status-code" title={STATUS_WORDS[kind]} aria-describedby={tipId("racestatus")}>
        {STATUS_LABEL[kind]}
        {status?.source === "estimated" ? <span className="race-status-est"> est.</span> : null}
        <span className="visually-hidden">{`: ${STATUS_WORDS[kind]}`}</span>
      </span>
      <span className="race-status-text">
        {status === null ? (
          (unavailable ?? "Waiting for the first lap.")
        ) : (
          <>
            <span className="race-status-lap">Lap {status.lap}</span>
            <span className="visually-hidden">. </span>
            {status.message !== null ? (
              <span className="race-status-msg">
                {status.message}
                {status.messageLap !== null ? ` (lap ${status.messageLap})` : ""}
                <span className="visually-hidden">. </span>
              </span>
            ) : null}
            <span className="race-status-src muted">{SOURCE_TEXT[status.source]}</span>
          </>
        )}
      </span>
      <InfoTip id="racestatus" align="end" />
      {announce ? (
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      ) : null}
    </section>
  );
}
