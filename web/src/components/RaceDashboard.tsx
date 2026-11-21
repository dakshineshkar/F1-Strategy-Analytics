"use client";

import Link from "next/link";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { tabKeyTarget } from "@/lib/analysis";
import { api, type Race } from "@/lib/api";
import { type RaceMode, raceSearch } from "@/lib/archive";
import { type CallPair, callLayout, closestPair, flaggedPairs, modelIdentity, modeOf, raceEnded, storedLap } from "@/lib/call";
import { useLatencyReporter } from "@/lib/debugLatency";
import { indexEntrants } from "@/lib/entrants";
import { unlistedCars } from "@/lib/pipeline";
import { alertGroups } from "@/lib/reducer";
import { isActive, INITIAL_RUN, liveText, type RunTracker, trackRun } from "@/lib/replays";
import { displayRows, lapProgress, lapsBehind, leaderLap as leaderLapOf, staleIds, staleSince } from "@/lib/stale";
import { useArchiveAvailable } from "@/lib/useArchive";
import { useCallContext } from "@/lib/useCallContext";
import { useEntrants } from "@/lib/useEntrants";
import { useHealth } from "@/lib/useHealth";
import { useRaceStatus } from "@/lib/useRaceStatus";
import { useRaceStream } from "@/lib/useRaceStream";
import { useReplays } from "@/lib/useReplays";

import { AlertFeed } from "./AlertFeed";
import { EngineerPanel } from "./EngineerPanel";
import { GapChart } from "./GapChart";
import { InfoTip } from "./InfoTip";
import { Legend } from "./Legend";
import { PhoneLabel } from "./PhoneLabel";
import { PostRaceView } from "./PostRaceView";
import { ReplayTransport } from "./ReplayTransport";
import { StatusStrip } from "./StatusStrip";
import { TheCall } from "./TheCall";
import { TowerPanel } from "./TowerPanel";
import { WhatIfPanel, type WhatIfRequestFromCall } from "./WhatIfPanel";

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
  // The mode tabs sit in the live header or above the archive, so a switch remounts them: a keyboard
  // switch puts focus back on the selected tab once the new tree is in place.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.getElementById(`mode-tab-${mode}`)?.focus();
  }, [mode]);
  const choose = (m: RaceMode) => {
    if (m === "archive" && unavailable) return;
    setMode(m);
  };
  const onModeKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const target = tabKeyTarget(e.key, i, MODES.length);
    if (target === null) return;
    e.preventDefault();
    const next = (MODES[target] as (typeof MODES)[number]).id;
    refocus.current = true;
    choose(next);
    document.getElementById(`mode-tab-${next}`)?.focus();
  };
  const modeTabs = (
    <div role="tablist" aria-label="Race mode" className="seg-tabs mode-tabs">
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
  );
  if (mode === "live") {
    return <LiveRaceView season={season} round={round} modeTabs={modeTabs} onArchive={unavailable ? null : () => setMode("archive")} />;
  }
  // the archive places the mode tabs in its own head (the live head's order) and renders its tabpanel
  return <PostRaceView season={season} round={round} initialLap={lap} onLap={onLap} modeTabs={modeTabs} />;
}

/** The leader lap when this page first had one (per replay run): the alert feed's "since you opened this
 * page" (critique F09). Kept in the view, not in the reducer. */
function useSinceLap(maxLap: number, generation: number): number | null {
  const [since, setSince] = useState<{ generation: number; lap: number } | null>(null);
  if (maxLap > 0 && (since === null || since.generation !== generation)) setSince({ generation, lap: maxLap });
  return since !== null && since.generation === generation ? since.lap : null;
}

/** The live race view (redesign Step 2): the call leads, the tower and the alerts are its evidence, the
 * what-if is its consequence, and the strip's inline replay transport and the pipeline counters support. Display only: the
 * reducer, the stream and the API are unchanged. */
function LiveRaceView({
  season,
  round,
  modeTabs,
  onArchive,
}: {
  season: number;
  round: number;
  modeTabs: ReactNode;
  onArchive: (() => void) | null;
}) {
  const replays = useReplays(season, round);
  // a new replay of this race (Feature 7) starts the live view afresh (state during render)
  const [run, setRun] = useState<RunTracker>(INITIAL_RUN);
  const nextRun = trackRun(run, replays.status !== null, replays.current?.run_id ?? null);
  if (nextRun !== run) setRun(nextRun);
  const { state, snapshotError } = useRaceStream(season, round, nextRun.generation);
  const { entrants } = useEntrants(season, round);
  const index = indexEntrants(entrants ?? []);
  const health = useHealth();
  const model = modelIdentity(health);
  const [race, setRace] = useState<Race | null>(null);
  const [view, setView] = useState<PageView>("race");
  const [request, setRequest] = useState<WhatIfRequestFromCall | null>(null);
  const whatif = useRef<HTMLElement>(null);
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

  // cars with no timing for 2 or more leader laps: kept, at the bottom, never in the call (stale.ts)
  const stale = staleIds(state);
  const rows = displayRows(state, stale);
  // keyed on the leader's lap the page holds (also a snapshot-only page: a late join, or a page opened after the
  // finish, which never gets a lap frame and so showed "UNKNOWN": Step 5, finding 16)
  const raceStatus = useRaceStatus(season, round, leaderLapOf(state));
  const leaderLap = rows[0]?.lap ?? null;
  const groups = alertGroups(state);
  const announcement = state.announcements[state.announcements.length - 1] ?? null;
  const anyRunning = (replays.status?.running.length ?? 0) > 0;
  // an earlier run's state with nothing streaming (after an API restart): never "LIVE", never a call (storedLap)
  const stored = storedLap(replays.status !== null, replays.current, state);
  const mode = modeOf(replays.current, state.sessionEnded, state.connection, stored);
  const ended = mode.tone === "ended";
  const finished = raceEnded(replays.current, state.sessionEnded, leaderLap, race?.laps ?? null);
  const flagged = finished || stored !== null ? [] : flaggedPairs(state, stale);
  const call = flagged[0] ?? null;
  const closest = call === null && !finished && stored === null ? closestPair(state, index, stale) : null;
  const streaming = isActive(replays.current) || mode.tone === "live";
  // the leader's lap also for a page that holds only the snapshot so far (late join, before the next crossing)
  const lapNow = leaderLapOf(state);
  // until /api/replays has answered, the call keeps its full height: a page opened during a replay would otherwise
  // start compact and grow under the feed on the first poll (load CLS; Step 5, finding 15)
  const layout = replays.status === null && !finished ? "full" : callLayout(call !== null, streaming, lapNow, finished);
  // the engineer view (trend, tyres) of the pair the call shows: the call, else the closest pair; the race's pit
  // loss from any response. Keyed on the leader's lap, so a late joiner with only the snapshot fetches at once.
  const { context, pitLoss } = useCallContext(season, round, (call ?? closest)?.attackerId ?? null, lapNow);
  const sinceLap = useSinceLap(state.maxLap, nextRun.generation);
  const towerRowsReserved = Math.max(20, entrants?.length ?? 0, rows.length);

  const simulate = (attackerId: string) => {
    setView("race");
    setRequest((r) => ({ attacker: attackerId, nonce: (r?.nonce ?? 0) + 1 }));
  };
  // bring the what-if into view once it has the pair (no smooth scroll under reduced motion)
  useEffect(() => {
    if (request === null || whatif.current === null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    whatif.current.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    whatif.current.focus({ preventScroll: true });
  }, [request]);

  return (
    <>
      <a className="skip-link" href="#the-call">
        Skip to the undercut call
      </a>
      <div className="race-head race-head-live">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link href="/">All races</Link>
        </nav>
        <h1>
          <span className="race-season">{season}</span> {race?.name ?? `Round ${round}`}
          <span className="race-round"> R{round}</span>
        </h1>
        <div className="race-head-tabs">
          {modeTabs}
          <div role="tablist" aria-label="Race page views" className="seg-tabs">
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
        </div>
        <nav aria-label="Race views" className="race-views">
          <Link href={`/race/${season}/${round}/analysis`}>
            <PhoneLabel full="Race analysis" short="Analysis" />
          </Link>
          <Link href={`/race/${season}/${round}/drivers`}>Drivers</Link>
        </nav>
      </div>
      <div role="tabpanel" id="mode-panel-live" aria-labelledby="mode-tab-live">
        <StatusStrip
          mode={mode}
          model={model}
          lap={leaderLap}
          laps={race?.laps ?? null}
          progress={lapProgress(state, stale)}
          raceStatus={raceStatus}
          connection={state.connection}
          sessionEnded={state.sessionEnded}
        >
          <ReplayTransport
            current={replays.current}
            anyRunning={anyRunning}
            enabled={replays.status?.enabled ?? null}
            pending={replays.pending}
            ended={ended}
            liveText={liveText(mode, replays.current, anyRunning, replays.status?.enabled ?? null)}
            onArchive={ended ? onArchive : null}
            onStart={(speed) => void replays.start(speed)}
            onStop={() => void replays.stop()}
            onPause={() => void replays.pause()}
            onResume={() => void replays.resume()}
            onSpeed={(speed) => void replays.setSpeed(speed)}
          />
        </StatusStrip>
        {/* a refused or failed replay action, and a failed replay's reason: under the strip, so the strip keeps its height */}
        <p className="transport-error" role="alert">
          {replays.error ?? (replays.current?.state === "failed" ? `Replay failed: ${replays.current.error ?? "unknown error"}` : "")}
        </p>
        {snapshotError ? (
          <p className="error" role="alert">
            The race state could not be reloaded after a reconnect ({snapshotError}). The view keeps the last state it
            had and tries again on the next reconnect; reload the page if it stays stale.
          </p>
        ) : null}
        {view === "engineer" ? (
          <div role="tabpanel" id="page-panel-engineer" aria-labelledby="page-tab-engineer">
            <EngineerPanel season={season} round={round} order={state.order} maxLap={state.maxLap} entrants={index} suggested={call?.attackerId ?? null} />
          </div>
        ) : null}
        {/* The race view stays mounted (its local state and the alert live region survive a tab switch). */}
        <div role="tabpanel" id="page-panel-race" aria-labelledby="page-tab-race" hidden={view !== "race"}>
          <div className="dash" style={{ "--tower-rows": towerRowsReserved } as CSSProperties}>
            <div className="dash-call">
              <TheCall
                state={state}
                entrants={index}
                model={model}
                context={context}
                pitLoss={pitLoss}
                onSimulate={(p: CallPair) => simulate(p.attackerId)}
                replayIdle={!isActive(replays.current)}
                stored={stored}
                layout={layout}
                ended={finished}
              />
              <AlertFeed
                groups={groups}
                announcement={announcement}
                rows={state.drivers}
                entrants={index}
                flaggedNow={flagged}
                sinceLap={sinceLap}
                maxLap={lapNow}
                ended={finished}
                onSimulate={(a) => simulate(a)}
              />
            </div>
            <div className="dash-tower">
              <TowerPanel
                rows={rows}
                lapsDown={(id) => lapsBehind(state, id)}
                entrants={index}
                callPair={call}
                extrasNote={
                  stored === null
                    ? null
                    : `Stored state from an earlier run (lap ${stored}): no replay is running, and the flags and probabilities were scored by that run's model.`
                }
                staleLap={(id) => (stale.has(id) ? staleSince(state, id) : null)}
              />
            </div>
            <div className="dash-more">
              <WhatIfPanel ref={whatif} season={season} round={round} order={state.order} entrants={index} request={request} suggested={call?.attackerId ?? null} />
              <GapChart state={state} pair={call} live />
              <PipelinePanel
                events={state.seen.length}
                snapshots={state.snapshots}
                malformed={state.malformed}
                duplicates={state.duplicates}
                unlisted={unlistedCars(state)}
              />
              <Legend />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** The pipeline as a supporting layer (critique F06): the client's own counters and a short "How it works". */
function PipelinePanel(props: { events: number; snapshots: number; malformed: number; duplicates: number; unlisted: number }) {
  return (
    <section className="panel pipeline-panel" aria-labelledby="pipeline-h">
      <h2 id="pipeline-h">Pipeline</h2>
      <dl className="pipeline-stats stream-stats">
        <div>
          <dt>Events applied</dt>
          <dd className="num">{props.events}</dd>
        </div>
        <div>
          <dt>Snapshots</dt>
          <dd className="num">{props.snapshots}</dd>
        </div>
        <div>
          <dt>Malformed</dt>
          <dd className="num">{props.malformed}</dd>
        </div>
        <div>
          <dt>Duplicates</dt>
          <dd className="num">{props.duplicates}</dd>
        </div>
        <div>
          <dt>
            Cars not yet in a snapshot <InfoTip id="unlisted" />
          </dt>
          <dd className="num">{props.unlisted}</dd>
        </div>
      </dl>
      <details className="pipeline-how">
        <summary>How it works</summary>
        <p>
          A stored race is replayed lap by lap into Kafka. Spark Structured Streaming builds each car&apos;s features from
          laps up to the previous one, applies the undercut rule and the calibrated model, and writes the race state to
          Redis. The API pushes it to this page over server-sent events. What you see at lap L is what a strategist
          could have known then.
        </p>
      </details>
    </section>
  );
}
