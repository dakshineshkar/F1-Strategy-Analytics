"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer } from "react";

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
import { GapChart } from "./GapChart";
import { Legend } from "./Legend";
import { RaceStatusBanner } from "./RaceStatusBanner";
import { TowerPanel } from "./TowerPanel";
import { TyrePanel } from "./TyrePanel";

export const ARCHIVE_GROUPS: readonly GlossaryGroup[] = ["archive", "tower", "alerts"];
const RC_SHOWN = 12;
/** A Feature 4 bundle (schema v1) has no sector, speed-trap or race-status values (its pit counts
 * still come from the replayed pit messages). */
export const V1_NOTE =
  "This archive bundle (schema v1) was built before the race status, sector and speed-trap columns; " +
  "rebuild the archive to see them here (they are shown in live mode).";

function Head({
  season,
  round,
  name,
  lap,
  total,
}: {
  season: number;
  round: number;
  name: string | null;
  lap: number | null;
  total: number | null;
}) {
  const analysis = `/race/${season}/${round}/analysis${lap ? analysisSearch({ view: "laps", lap }) : ""}`;
  return (
    <div className="race-head">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">All races</Link>
      </nav>
      <nav aria-label="Race views" className="race-views">
        <Link href={`/race/${season}/${round}/drivers`}>Drivers</Link> <Link href={analysis}>Race analysis</Link>
      </nav>
      <h1>
        <span className="race-season">{season}</span> {name ?? `Round ${round}`}
        <span className="muted"> · R{round}</span>
      </h1>
      <p className="lap-counter" aria-label={`Lap ${lap ?? 0} of ${total ?? "unknown"}`}>
        <span className="lc-label">LAP</span> <span className="lc-now">{lap ?? "—"}</span>
        <span className="lc-total"> / {total ?? "—"}</span>
      </p>
      <p className="conn conn-archive">
        <span className="conn-icon" aria-hidden="true">
          ■
        </span>{" "}
        <span className="visually-hidden">Mode: </span>Post-race (archive)
      </p>
    </div>
  );
}

/** The post-race mode of the race page: the stored bundle scrubbed lap by lap through the live
 * dashboard's own reducer and components (no SSE connection, nothing polled). */
export function PostRaceView({
  season,
  round,
  initialLap,
  onLap,
}: {
  season: number;
  round: number;
  initialLap: number | null;
  onLap: (lap: number) => void;
}) {
  const load = useArchive(season, round);
  if (load.data === null) {
    return (
      <>
        <Head season={season} round={round} name={null} lap={null} total={null} />
        <section className="panel" aria-labelledby="archive-missing-h">
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
      </>
    );
  }
  return <PostRaceBody key={`${season}:${round}`} bundle={load.data} initialLap={initialLap} onLap={onLap} />;
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
  const { season, round } = bundle.meta;
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
  return (
    <>
      <Head season={season} round={round} name={bundle.meta.raceName} lap={pb.lap} total={bundle.meta.laps} />
      <ul className="analysis-notes archive-notes">
        <li>
          Replayed from the stored bundle: each lap shows what the live stream left in Redis at the end of that lap.
          Model <span className="num">{bundle.meta.modelVersion}</span> (scorer{" "}
          <span className="num">{bundle.meta.scorerSha256.slice(0, 12)}…</span>).
        </li>
        <li>Times follow the simulated race clock (scheduled start + 180 s + race time).</li>
        {bundle.meta.synthetic ? (
          <li className="is-synthetic">SYNTHETIC tyre data (sample mode): compounds and tyre ages are generated.</li>
        ) : null}
      </ul>
      <div className="dash">
        <div className="dash-main">
          <ArchiveControls laps={laps} total={bundle.meta.laps} state={pb} dispatch={dispatch} markers={marks} />
          <Legend groups={ARCHIVE_GROUPS} />
          <RaceStatusBanner
            status={statusAtLap(bundle, pb.lap)}
            unavailable={extras ? null : V1_NOTE}
            announce={false}
          />
          <TowerPanel
            rows={rows}
            lapsDown={(id) => lapsDown(view, id)}
            entrants={entrants}
            captionNote={`gaps at the timing line at the end of lap ${pb.lap}, from the post-race archive`}
            extrasNote={extras ? null : V1_NOTE}
          />
          <GapChart state={view} />
        </div>
        <div className="dash-side">
          <AlertFeed groups={alertGroups(view)} announcement={null} />
          <TyrePanel rows={rows} />
          <section className="panel arc-panel" aria-labelledby="rc-h">
            <h2 id="rc-h">Race control</h2>
            {bundle.raceControl.length === 0 ? (
              <p className="muted">No race-control messages in this lake (the sample has none).</p>
            ) : (
              <>
                <p className="panel-note">
                  Latest {shown.length} of {rc.length} messages up to lap {pb.lap}, newest first.
                </p>
                <div className="arc-feed" role="region" aria-label="Race-control messages" tabIndex={0}>
                  <ol className="arc-list">
                    {shown.map((m) => (
                      <li key={m.seq} className={m.is_key ? "arc-key" : undefined}>
                        <span className="arc-lap num">L{m.lap ?? "—"}</span> {m.is_key ? <strong>{m.message}</strong> : m.message}
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
