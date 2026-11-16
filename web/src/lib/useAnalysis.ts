"use client";

import { useEffect, useState } from "react";

import type { AnalysisDoc, AnalysisLap, Compare, PitStop, PositionSeries, RaceControlMsg, Stint } from "./analysis";
import { api, ApiError } from "./api";

export interface AnalysisData {
  laps: AnalysisDoc<AnalysisLap>;
  stints: AnalysisDoc<Stint>;
  pitstops: AnalysisDoc<PitStop>;
  raceControl: AnalysisDoc<RaceControlMsg>;
  positions: AnalysisDoc<PositionSeries>;
}

export interface AnalysisLoad {
  data: AnalysisData | null;
  /** null while loading or after success; a short reason otherwise (404: none in the lake). */
  error: string | null;
  status: number | null;
}

const message = (e: unknown): { error: string; status: number | null } =>
  e instanceof ApiError ? { error: e.message, status: e.status } : { error: "analysis unavailable", status: null };

/** The race's five analysis views, loaded once per race in parallel (display only). The stored
 * result carries its race key, so after a race change the old result reads as loading. */
export function useAnalysis(season: number, round: number): AnalysisLoad {
  const key = `${season}:${round}`;
  const [load, setLoad] = useState<AnalysisLoad & { key: string | null }>({ key: null, data: null, error: null, status: null });
  useEffect(() => {
    const ctl = new AbortController();
    const k = `${season}:${round}`;
    Promise.all([
      api.analysisLaps(season, round, ctl.signal),
      api.analysisStints(season, round, ctl.signal),
      api.analysisPitStops(season, round, ctl.signal),
      api.analysisRaceControl(season, round, ctl.signal),
      api.analysisPositions(season, round, ctl.signal),
    ])
      .then(([laps, stints, pitstops, raceControl, positions]) =>
        setLoad({ key: k, data: { laps, stints, pitstops, raceControl, positions }, error: null, status: null }),
      )
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ key: k, data: null, ...message(e) });
      });
    return () => ctl.abort();
  }, [season, round]);
  return load.key === key ? { data: load.data, error: load.error, status: load.status } : { data: null, error: null, status: null };
}

export interface CompareLoad {
  compare: Compare | null;
  error: string | null;
}

/** Two drivers lap by lap (``a`` and ``b`` are codes); nothing is requested until both are set. */
export function useCompare(season: number, round: number, a: string | null, b: string | null): CompareLoad {
  const key = `${season}:${round}:${a}:${b}`;
  const [load, setLoad] = useState<CompareLoad & { key: string | null }>({ key: null, compare: null, error: null });
  useEffect(() => {
    if (a === null || b === null || a === b) return;
    const ctl = new AbortController();
    const k = `${season}:${round}:${a}:${b}`;
    api
      .compare(season, round, a, b, ctl.signal)
      .then((compare) => setLoad({ key: k, compare, error: null }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ key: k, compare: null, error: message(e).error });
      });
    return () => ctl.abort();
  }, [season, round, a, b]);
  return load.key === key ? { compare: load.compare, error: load.error } : { compare: null, error: null };
}
