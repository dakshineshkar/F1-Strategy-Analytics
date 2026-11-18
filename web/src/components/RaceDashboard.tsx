"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";

import { tabKeyTarget } from "@/lib/analysis";
import { api, type Race } from "@/lib/api";
import { type RaceMode, raceSearch } from "@/lib/archive";
import { useLatencyReporter } from "@/lib/debugLatency";
import { indexEntrants } from "@/lib/entrants";
import { alertGroups, lapsDown, towerRows } from "@/lib/reducer";
import { useArchiveAvailable } from "@/lib/useArchive";
import { useEntrants } from "@/lib/useEntrants";
import { useRaceStatus } from "@/lib/useRaceStatus";
import { useRaceStream } from "@/lib/useRaceStream";
import { INITIAL_RUN, type RunTracker, trackRun } from "@/lib/replays";
import { useReplays } from "@/lib/useReplays";

import { AlertFeed } from "./AlertFeed";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { EngineerPanel } from "./EngineerPanel";
import { GapChart } from "./GapChart";
import { Legend } from "./Legend";
import { PostRaceView } from "./PostRaceView";
import { RaceStatusBanner } from "./RaceStatusBanner";
import { ReplayControl } from "./ReplayControl";
import { TowerPanel } from "./TowerPanel";
import { TyrePanel } from "./TyrePanel";
import { WhatIfPanel } from "./WhatIfPanel";

const PAGE_VIEWS = [
  { id: "race", label: "Race" },
  { id: "engineer", label: "Engineer" },
] as const;
type PageView = (typeof PAGE_VIEWS)[number]["id"];

const MODES = [
  { id: "live", label: "Live" },
  { id: "archive", label: "Post-race (archive)" },
] as const satisfies readonly { id: RaceMode; label: string }[];

/** The race page: "Live" (the SSE dashboard) or "Post-race (archive)" (the stored bundle scrubbed
 * lap by lap). Only the selected mode is mounted, so the post-race mode opens no event stream. The
 * mode and the archive lap live in the URL (``?mode=archive&lap=N``). */
export function RaceDashboard({
  season,
  round,
  initialMode = "live",
  initialLap = null,
}: {
  season: number;
  round: number;
  initialMode?: RaceMode;
  initialLap?: number | null;
}) {
  const [mode, setMode] = useState<RaceMode>(initialMode);
  const [lap, setLap] = useState<number | null>(initialLap);
  const available = useArchiveAvailable(season, round);
  const unavailable = available === false && mode !== "archive";
  useEffect(() => {
    const search = raceSearch({ mode, lap: mode === "archive" ? lap : null });
    if (window.location.search !== search) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
    }
  }, [mode, lap]);
  const onLap = useCallback((n: number) => setLap(n), []);
  const choose = (m: RaceMode) => {
    if (m === "archive" && unavailable) return;
    setMode(m);
  };
  const onModeKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const target = tabKeyTarget(e.key, i, MODES.length);
    if (target === null) return;
    e.preventDefault();
    const next = (MODES[target] as (typeof MODES)[number]).id;
    choose(next);
    document.getElementById(`mode-tab-${next}`)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label="Race mode" className="analysis-tabs mode-tabs">
        {MODES.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            id={`mode-tab-${m.id}`}
            aria-selected={mode === m.id}
            aria-controls={`mode-panel-${m.id}`}
            aria-disabled={m.id === "archive" && unavailable ? true : undefined}
            aria-describedby={m.id === "archive" && unavailable ? "mode-archive-note" : undefined}
            tabIndex={mode === m.id ? 0 : -1}
            onClick={() => choose(m.id)}
            onKeyDown={(e) => onModeKey(e, i)}
          >
            {m.label}
          </button>
        ))}
        {unavailable ? (
          <span id="mode-archive-note" className="mode-note muted">
            no archive for this race yet
          </span>
        ) : null}
      </div>
      <div role="tabpanel" id={`mode-panel-${mode}`} aria-labelledby={`mode-tab-${mode}`}>
        {mode === "live" ? (
          <LiveRaceView season={season} round={round} />
        ) : (
          <PostRaceView season={season} round={round} initialLap={lap} onLap={onLap} />
        )}
      </div>
    </>
  );
}

/** The live (SSE) dashboard, unchanged since Feature 3. */
function LiveRaceView({ season, round }: { season: number; round: number }) {
  const replays = useReplays(season, round);
  // a new replay of this race (Feature 7) starts the live view afresh (state during render)
  const [run, setRun] = useState<RunTracker>(INITIAL_RUN);
  const nextRun = trackRun(run, replays.status !== null, replays.current?.run_id ?? null);
  if (nextRun !== run) setRun(nextRun);
  const { state, snapshotError } = useRaceStream(season, round, nextRun.generation);
  const { entrants } = useEntrants(season, round);
  const [race, setRace] = useState<Race | null>(null);
  const [view, setView] = useState<PageView>("race");
  useLatencyReporter(state.seen);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const target = tabKeyTarget(e.key, i, PAGE_VIEWS.length);
    if (target === null) return;
    e.preventDefault();
    const next = (PAGE_VIEWS[target] as (typeof PAGE_VIEWS)[number]).id;
    setView(next);
    document.getElementById(`page-tab-${next}`)?.focus();
  };

  useEffect(() => {
    const ctl = new AbortController();
    api
      .races(ctl.signal)
      .then((list) => setRace(list.find((r) => r.season === season && r.round === round) ?? null))
      .catch(() => setRace(null));
    return () => ctl.abort();
  }, [season, round]);

  const rows = towerRows(state);
  const raceStatus = useRaceStatus(season, round, state.maxLap);
  const leaderLap = rows[0]?.lap ?? null;
  const groups = alertGroups(state);
  const announcement = state.announcements[state.announcements.length - 1] ?? null;
  const anyRunning = (replays.status?.running.length ?? 0) > 0;

  return (
    <>
      <div className="race-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link href="/">All races</Link>
        </nav>
        <nav aria-label="Race views" className="race-views">
          <Link href={`/race/${season}/${round}/drivers`}>Drivers</Link>{" "}
          <Link href={`/race/${season}/${round}/analysis`}>Race analysis</Link>
        </nav>
        <h1>
          <span className="race-season">{season}</span>{" "}
          {race?.name ?? `Round ${round}`}
          <span className="muted"> · R{round}</span>
        </h1>
        <p className="lap-counter" aria-label={`Lap ${leaderLap ?? 0} of ${race?.laps ?? "unknown"}`}>
          <span className="lc-label">LAP</span> <span className="lc-now">{leaderLap ?? "—"}</span>
          <span className="lc-total"> / {race?.laps ?? "—"}</span>
        </p>
        <ConnectionIndicator status={state.connection} sessionEnded={state.sessionEnded} />
      </div>
      {snapshotError ? (
        <p className="error" role="alert">
          Could not load the race state: {snapshotError}
        </p>
      ) : null}
      <div role="tablist" aria-label="Race page views" className="analysis-tabs">
        {PAGE_VIEWS.map((v, i) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`page-tab-${v.id}`}
            aria-selected={view === v.id}
            aria-controls={`page-panel-${v.id}`}
            tabIndex={view === v.id ? 0 : -1}
            onClick={() => setView(v.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "engineer" ? (
        <div role="tabpanel" id="page-panel-engineer" aria-labelledby="page-tab-engineer">
          <EngineerPanel season={season} round={round} order={state.order} maxLap={state.maxLap} entrants={indexEntrants(entrants ?? [])} />
        </div>
      ) : null}
      {/* The race view stays mounted (its local state and the alert live region survive a tab switch). */}
      <div role="tabpanel" id="page-panel-race" aria-labelledby="page-tab-race" hidden={view !== "race"}>
      <div className="dash">
        <div className="dash-main">
          <Legend />
          <RaceStatusBanner status={raceStatus} />
          <TowerPanel rows={rows} lapsDown={(id) => lapsDown(state, id)} entrants={indexEntrants(entrants ?? [])} />
          <GapChart state={state} />
          <WhatIfPanel season={season} round={round} order={state.order} />
        </div>
        <div className="dash-side">
          <ReplayControl
            current={replays.current}
            anyRunning={anyRunning}
            enabled={replays.status?.enabled ?? null}
            pending={replays.pending}
            error={replays.error}
            onStart={(speed) => void replays.start(speed)}
            onStop={() => void replays.stop()}
            onPause={() => void replays.pause()}
            onResume={() => void replays.resume()}
            onSpeed={(speed) => void replays.setSpeed(speed)}
          />
          <AlertFeed groups={groups} announcement={announcement} />
          <TyrePanel rows={rows} />
        </div>
      </div>
      </div>
      <p className="stream-stats muted">
        {state.seen.length} events applied · {state.malformed} malformed · {state.unknownDrivers} unknown drivers
      </p>
    </>
  );
}
