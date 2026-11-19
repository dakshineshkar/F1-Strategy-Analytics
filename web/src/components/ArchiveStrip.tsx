import { type RaceStatus, SOURCE_TEXT, STATUS_LABEL, STATUS_WORDS } from "@/lib/raceStatus";

/** The post-race archive's status band (redesign step 4A): the live strip's cells for a stored race, so every race
 * page reads the same way (critique F08). The mode chip (POST-RACE), the scrubbed lap, the track status as a text
 * code whose chip carries the border style (solid SC, dashed VSC, dotted neutralised, double red flag: the same
 * shapes as the live strip, never a side bar), the scoring model, and on its own line the latest key race-control
 * message with its lap and where the status comes from, as visible text. It has no live region: the archive never
 * speaks while the viewer scrubs. */
export function ArchiveStrip({
  status,
  lap,
  laps,
  modelVersion,
  scorerSha256,
  unavailable = null,
}: {
  /** the bundle's race status at the end of ``lap`` (null in a v1 bundle) */
  status: RaceStatus | null;
  lap: number;
  laps: number;
  modelVersion: string;
  scorerSha256: string;
  /** shown in place of the status when the bundle has none (a v1 bundle) */
  unavailable?: string | null;
}) {
  const kind = status?.status ?? "unknown";
  const scorer = scorerSha256 ? `scorer ${scorerSha256.slice(0, 12)}…` : "";
  return (
    <section className="status-strip arc-strip" aria-label="Race status">
      <div className="ss-cells">
        <p className="ss-mode tone-archive" title="Replayed from the stored post-race bundle">
          <span className="ss-mode-label">POST-RACE</span>
          <span className="visually-hidden">: replayed from the stored post-race bundle</span>
        </p>
        <p className="ss-cell ss-lap">
          <span className="ss-k">Lap</span>{" "}
          <span className="num ss-v" aria-label={`Lap ${lap} of ${laps}`}>
            <span className="lc-now">{lap}</span>
            <span className="ss-of">/{laps}</span>
          </span>
        </p>
        <p className={`ss-cell ss-track race-status race-status-${kind}`}>
          <span className="ss-k">Track</span>{" "}
          <span className="ss-v race-status-code">
            {status === null ? "n/a" : STATUS_LABEL[kind]}
            {status?.source === "estimated" ? <span className="race-status-est"> est.</span> : null}
          </span>
          <span className="visually-hidden">{status === null ? ": not in this bundle" : `: ${STATUS_WORDS[kind]}`}</span>
        </p>
        <p className="ss-cell ss-model" title={scorer ? `Model ${modelVersion}, ${scorer}` : undefined}>
          <span className="ss-k">Model</span> <span className="ss-v num">{modelVersion}</span>
          {scorer ? <span className="ss-detail">{scorer}</span> : null}
        </p>
        <p className="ss-rc">
          {status === null ? (
            <span className="ss-rc-src">{unavailable ?? "Waiting for the first lap."}</span>
          ) : (
            <>
              {status.message !== null ? (
                <span className="ss-rc-msg">
                  <span className="ss-k">{status.messageLap !== null ? `Race control, lap ${status.messageLap}:` : "Race control:"}</span>{" "}
                  <span className="ss-rc-text">{status.message}</span>
                  <span className="visually-hidden">. </span>
                </span>
              ) : (
                <span className="ss-rc-msg ss-k">No key race-control message up to this lap.</span>
              )}{" "}
              <span className="ss-rc-src">Track status {SOURCE_TEXT[status.source]}.</span>
            </>
          )}
        </p>
      </div>
    </section>
  );
}
