"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { Legend } from "@/components/Legend";
import {
  analysisSearch,
  codeIndex,
  coverageNotes,
  degradation,
  finishOrder,
  neutralRanges,
  strategyRows,
  tabKeyTarget,
  VIEWS,
  type AnalysisQuery,
  type ViewId,
} from "@/lib/analysis";
import { api, type Race } from "@/lib/api";
import { indexEntrants } from "@/lib/entrants";
import { useAnalysis, useCompare } from "@/lib/useAnalysis";
import { useEntrants } from "@/lib/useEntrants";

import { makeNames, Notes } from "./common";
import { CompareView } from "./CompareView";
import { DegradationChart } from "./DegradationChart";
import { LapTimesChart } from "./LapTimesChart";
import { PitStopsTable } from "./PitStopsTable";
import { PositionsChart } from "./PositionsChart";
import { RaceControlList } from "./RaceControlList";
import { StrategyChart } from "./StrategyChart";
import { TelemetryView } from "./TelemetryView";

const tabId = (v: ViewId) => `analysis-tab-${v}`;
const panelId = (v: ViewId) => `analysis-panel-${v}`;

/** The "Race analysis" tab of a finished race (display only): seven views of the lake's
 * ``clean/analysis_*`` tables plus the Telemetry overlay (``clean/telemetry_trace``, 2024 only)
 * behind WAI-ARIA tabs (arrow keys, Home, End). The view, the marked lap and the chosen drivers
 * and laps live in the URL, so a lap link is a real link. */
export function AnalysisPage({ season, round, initial }: { season: number; round: number; initial: AnalysisQuery }) {
  const { data, error, status } = useAnalysis(season, round);
  const { entrants } = useEntrants(season, round);
  const [race, setRace] = useState<Race | null>(null);
  const [query, setQuery] = useState<AnalysisQuery>(initial);
  const [picked, setPicked] = useState<string[] | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .races(ctl.signal)
      .then((list) => setRace(list.find((r) => r.season === season && r.round === round) ?? null))
      .catch(() => setRace(null));
    return () => ctl.abort();
  }, [season, round]);

  const update = useCallback((next: Partial<AnalysisQuery>) => {
    setQuery((q) => {
      const merged = { ...q, ...next };
      if (typeof window !== "undefined") window.history.replaceState(null, "", analysisSearch(merged));
      return merged;
    });
  }, []);

  const index = useMemo(() => (entrants ? indexEntrants(entrants) : null), [entrants]);
  const names = useMemo(() => makeNames(index, codeIndex(data?.laps.rows ?? [])), [index, data]);
  const order = useMemo(() => (data ? finishOrder(data.positions.rows) : []), [data]);
  const byCode = useMemo(() => new Map(order.map((id) => [names.code(id), id])), [order, names]);
  const lapDrivers = picked ?? order.slice(0, 3);
  const degDriver = (query.driver && byCode.get(query.driver)) || order[0] || "";
  const a = query.a ?? (order[0] ? names.code(order[0]) : null);
  const b = query.b ?? (order[1] ? names.code(order[1]) : null);
  const compare = useCompare(season, round, query.view === "compare" ? a : null, query.view === "compare" ? b : null);

  const onLap = useCallback((lap: number) => update({ view: "laps", lap }), [update]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const target = tabKeyTarget(e.key, i, VIEWS.length);
    if (target === null) return;
    e.preventDefault();
    const v = (VIEWS[target] as (typeof VIEWS)[number]).id;
    update({ view: v });
    document.getElementById(tabId(v))?.focus();
  };

  const head = (
    <div className="race-head">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">All races</Link> / <Link href={`/race/${season}/${round}`}>Race</Link>
      </nav>
      <nav aria-label="Race views" className="race-views">
        <Link href={`/race/${season}/${round}/drivers`}>Drivers</Link>{" "}
        <Link href={`/race/${season}/${round}/analysis`} aria-current="page">
          Race analysis
        </Link>
      </nav>
      <h1>
        <span className="race-season">{season}</span> {race?.name ?? `Round ${round}`}
        <span className="muted"> · R{round} · Race analysis</span>
      </h1>
    </div>
  );

  if (error !== null) {
    return (
      <>
        {head}
        <p className="error" role="alert">
          {status === 404
            ? "No race analysis for this race in the lake yet (run make analysis-sample or make analysis-full)."
            : `Could not load the race analysis: ${error}`}
        </p>
      </>
    );
  }
  if (data === null) {
    return (
      <>
        {head}
        <p className="muted" aria-live="polite">
          Loading the race analysis…
        </p>
      </>
    );
  }

  const coverage = data.laps.coverage;
  const totalLaps = coverage.n_laps;
  const view = query.view;
  let panel;
  switch (view) {
    case "strategy":
      panel = (
        <StrategyChart rows={strategyRows(data.stints.rows, data.pitstops.rows, order)} laps={totalLaps} coverage={coverage} names={names} />
      );
      break;
    case "laps":
      panel = (
        <LapTimesChart
          laps={data.laps.rows}
          drivers={lapDrivers}
          order={order}
          onToggle={(d) => setPicked(lapDrivers.includes(d) ? lapDrivers.filter((x) => x !== d) : [...lapDrivers, d])}
          neutral={neutralRanges(data.laps.rows)}
          markLap={query.lap}
          totalLaps={totalLaps}
          names={names}
        />
      );
      break;
    case "deg":
      panel = (
        <DegradationChart
          deg={degradation(data.laps.rows, data.stints.rows, degDriver)}
          driver={degDriver}
          order={order}
          onDriver={(d) => update({ driver: names.code(d) })}
          coverage={coverage}
          names={names}
        />
      );
      break;
    case "positions":
      panel = <PositionsChart series={data.positions.rows} totalLaps={totalLaps} names={names} />;
      break;
    case "compare":
      panel = (
        <CompareView
          compare={compare.compare}
          error={compare.error}
          a={a}
          b={b}
          order={order}
          onPick={(na, nb) => update({ a: na, b: nb })}
          totalLaps={totalLaps}
          hasSectors={coverage.has_sectors}
          names={names}
        />
      );
      break;
    case "pits":
      panel = <PitStopsTable stops={data.pitstops.rows} names={names} onLap={onLap} />;
      break;
    case "control":
      panel = <RaceControlList rows={data.raceControl.rows} names={names} onLap={onLap} />;
      break;
    case "telemetry":
      panel = (
        <TelemetryView
          season={season}
          round={round}
          order={order}
          names={names}
          pick={{ ta: query.ta, talap: query.talap, tb: query.tb, tblap: query.tblap }}
          onPick={(next) => update(next)}
        />
      );
      break;
  }

  return (
    <>
      {head}
      <Notes notes={coverageNotes(coverage)} />
      <div role="tablist" aria-label="Race analysis views" className="analysis-tabs">
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={tabId(v.id)}
            aria-selected={view === v.id}
            aria-controls={panelId(v.id)}
            tabIndex={view === v.id ? 0 : -1}
            onClick={() => update({ view: v.id })}
            onKeyDown={(e) => onKey(e, i)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId(view)} aria-labelledby={tabId(view)} tabIndex={0} className="panel analysis-panel">
        {panel}
      </div>
      <Legend groups={view === "telemetry" ? ["analysis", "telemetry"] : ["analysis"]} />
    </>
  );
}
