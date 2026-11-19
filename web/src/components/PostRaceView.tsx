"use client";

import Link from "next/link";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { analysisSearch } from "@/lib/analysis";
import {
  type ArchiveBundle,
  archiveStep,
  hasTowerExtras,
  type ArchiveView,
  initialArchiveView,
  lapDurationMs,
  markers,
  type PlaybackAction,
  raceControlUpTo,
  snapshotLaps,
  statusAtLap,
} from "@/lib/archive";
import { indexEntrants } from "@/lib/entrants";
import type { GlossaryGroup } from "@/lib/legend";
import { alertGroups, lapsDown, towerRows } from "@/lib/reducer";
import { useArchive } from "@/lib/useArchive";

import { AlertFeed } from "./AlertFeed";
import { ArchiveControls } from "./ArchiveControls";
import { ArchiveStrip } from "./ArchiveStrip";
import { GapChart } from "./GapChart";
import { Legend } from "./Legend";
import { PhoneLabel } from "./PhoneLabel";
import { TowerPanel } from "./TowerPanel";

export const ARCHIVE_GROUPS: readonly GlossaryGroup[] = ["archive", "tower", "alerts"];
const RC_SHOWN = 12;
/** A Feature 4 bundle (schema v1) has no sector, speed-trap or race-status values (its pit counts
 * still come from the replayed pit messages). */
export const V1_NOTE =
  "This archive bundle (schema v1) was built before the race status, sector and speed-trap columns; " +
  "rebuild the archive to see them here (they are shown in live mode).";

/** The archive's head, in the live head's order (critique F08): the breadcrumb, the race, the mode tabs, then the
 * race's other pages. */
function Head({
  season,
  round,
  name,
  lap,
  modeTabs,
}: {
  season: number;
  round: number;
  name: string | null;
  lap: number | null;
  modeTabs: ReactNode;
}) {
  const analysis = `/race/${season}/${round}/analysis${lap ? analysisSearch({ view: "laps", lap }) : ""}`;
  return (
    <>
      <a className="skip-link" href="#archive-controls">
        Skip to the lap controls
      </a>
      <div className="race-head race-head-arc">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link href="/">All races</Link>
        </nav>
        <h1>
          <span className="race-season">{season}</span> {name ?? `Round ${round}`}
          <span className="race-round"> R{round}</span>
        </h1>
        <div className="race-head-tabs">{modeTabs}</div>
        <nav aria-label="Race views" className="race-views">
          <Link href={analysis}>
            <PhoneLabel full="Race analysis" short="Analysis" />
          </Link>
          <Link href={`/race/${season}/${round}/drivers`}>Drivers</Link>
        </nav>
      </div>
    </>
  );
}

/** The post-race mode of the race page: the stored bundle scrubbed lap by lap through the live
 * dashboard's own reducer and components (no SSE connection, nothing polled). */
export function PostRaceView({
  season,
  round,
  initialLap,
  onLap,
  modeTabs = null,
}: {
  season: number;
  round: number;
  initialLap: number | null;
  onLap: (lap: number) => void;
  /** the Live | Post-race tabs (owned by the race page), placed in the head as on the live view */
  modeTabs?: ReactNode;
}) {
  const load = useArchive(season, round);
  // the head (with the mode tabs) is rendered once, above both the loading state and the loaded body, so a keyboard
  // switch to this mode keeps focus on its tab when the bundle arrives
  const [lap, setLap] = useState<number | null>(initialLap);
  const onBodyLap = useCallback(
    (n: number) => {
      setLap(n);
      onLap(n);
    },
    [onLap],
  );
  return (
    <>
      <Head season={season} round={round} name={load.data?.meta.raceName ?? null} lap={load.data === null ? null : lap} modeTabs={modeTabs} />
      <div role="tabpanel" id="mode-panel-archive" aria-labelledby="mode-tab-archive">
        {load.data === null ? (
          <section className="panel" aria-labelledby="archive-missing-h" id="archive-controls">
            <h2 id="archive-missing-h">Post-race replay</h2>
            {load.error === null ? (
              <p className="muted" role="status">
                Loading the post-race archive…
              </p>
            ) : load.status === 404 ? (
              <p role="status">
                No post-race archive for this race yet. Build it with <code>make archive-sample</code> (sample lake) or{" "}
                <code>make archive-full</code>.
              </p>
            ) : (
              <p className="error" role="alert">
                Could not load the post-race archive: {load.error}
              </p>
            )}
          </section>
        ) : (
          <PostRaceBody key={`${season}:${round}`} bundle={load.data} initialLap={initialLap} onLap={onBodyLap} />
        )}
      </div>
    </>
  );
}

function PostRaceBody({
  bundle,
  initialLap,
  onLap,
}: {
  bundle: ArchiveBundle;
  initialLap: number | null;
  onLap: (lap: number) => void;
}) {
  const laps = useMemo(() => snapshotLaps(bundle), [bundle]);
  const [{ pb, view: at }, dispatch] = useReducer(
    (s: ArchiveView, a: PlaybackAction) => archiveStep(s, a, bundle),
    null,
    () => initialArchiveView(bundle, initialLap),
  );
  const view = at.state;
  useEffect(() => onLap(pb.lap), [pb.lap, onLap]);
  useEffect(() => {
    if (!pb.playing) return;
    const t = setTimeout(() => dispatch({ type: "tick" }), lapDurationMs(bundle, pb.lap, pb.speed));
    return () => clearTimeout(t);
  }, [bundle, pb.playing, pb.lap, pb.speed]);
  const entrants = useMemo(() => indexEntrants(bundle.entrants), [bundle]);
  const marks = useMemo(() => markers(bundle, (id) => entrants[id]?.code ?? id), [bundle, entrants]);
  const rows = towerRows(view);
  const rc = raceControlUpTo(bundle, pb.lap);
  const extras = hasTowerExtras(bundle);
  const shown = rc.slice(-RC_SHOWN).reverse();
  const rowsReserved = Math.max(20, bundle.entrants.length, rows.length);
  // the feed marks alerts from the scrubbed lap or the one before, as the live page did at that lap; none after the
  // finish (the archive's one loud element; the tower has no call band here)
  const finished = pb.lap >= bundle.meta.laps;
  return (
    <>
      <ArchiveStrip
        status={statusAtLap(bundle, pb.lap)}
        lap={pb.lap}
        laps={bundle.meta.laps}
        modelVersion={bundle.meta.modelVersion}
        scorerSha256={bundle.meta.scorerSha256}
        unavailable={extras ? null : V1_NOTE}
      />
      <div className="arc-dash" style={{ "--tower-rows": rowsReserved } as CSSProperties}>
        <div className="arc-controls">
          <ArchiveControls laps={laps} total={bundle.meta.laps} state={pb} dispatch={dispatch} markers={marks}>
            <p className="panel-note arc-note">
              Replayed from the stored bundle: each lap shows what the live stream left in Redis at the end of that lap;
              times follow the simulated race clock (scheduled start + 180 s + race time).
              {bundle.meta.synthetic ? (
                <>
                  {" "}
                  <strong className="arc-synthetic">SYNTHETIC tyre data</strong> (sample mode): compounds and tyre ages are
                  generated.
                </>
              ) : null}
            </p>
          </ArchiveControls>
        </div>
        <div className="arc-tower">
          <TowerPanel
            rows={rows}
            lapsDown={(id) => lapsDown(view, id)}
            entrants={entrants}
            captionNote={`gaps at the timing line at the end of lap ${pb.lap}, from the post-race archive`}
            extrasNote={extras ? null : V1_NOTE}
          />
        </div>
        <div className="arc-side">
          <AlertFeed groups={alertGroups(view)} announcement={null} rows={view.drivers} entrants={entrants} maxLap={pb.lap} ended={finished} />
          <section className="panel arc-panel" aria-labelledby="rc-h">
            <h2 id="rc-h">Race control</h2>
            {bundle.raceControl.length === 0 ? (
              <p className="muted arc-rc-none">No race-control messages in this lake (the sample has none).</p>
            ) : (
              <>
                <p className="panel-note">
                  Latest {shown.length} of {rc.length} messages up to lap {pb.lap}, newest first.
                </p>
                <div className="arc-feed" role="region" aria-label="Race-control messages" tabIndex={0}>
                  <ol className="arc-list">
                    {shown.map((m) => (
                      <li key={m.seq} className={m.is_key ? "arc-rc is-key" : "arc-rc"}>
                        <span className="arc-lap num">L{m.lap ?? "—"}</span>
                        <span className="arc-msg">{m.message}</span>
                        {m.is_key ? <span className="tag arc-key-tag">Key</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </section>
        </div>
        <div className="arc-more">
          <GapChart state={view} />
          <Legend groups={ARCHIVE_GROUPS} />
        </div>
      </div>
    </>
  );
}
