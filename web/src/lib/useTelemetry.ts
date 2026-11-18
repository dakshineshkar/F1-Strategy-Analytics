"use client";

import { useEffect, useState } from "react";

import { api, ApiError } from "./api";
import type { TelemetryCompare, TelemetryLaps } from "./telemetry";

export interface TelemetryLapsLoad {
  laps: TelemetryLaps | null;
  /** null while loading or after success; the API's reason otherwise (404: none in the lake). */
  error: string | null;
  status: number | null;
}

const message = (e: unknown): { error: string; status: number | null } =>
  e instanceof ApiError ? { error: e.message, status: e.status } : { error: "telemetry unavailable", status: null };

/** A driver's laps with a telemetry trace; nothing is requested while ``code`` is null (another
 * season, or no driver yet). The stored result carries its key, so a change reads as loading. */
export function useTelemetryLaps(season: number, round: number, code: string | null): TelemetryLapsLoad {
  const key = `${season}:${round}:${code}`;
  const [load, setLoad] = useState<TelemetryLapsLoad & { key: string | null }>({
    key: null,
    laps: null,
    error: null,
    status: null,
  });
  useEffect(() => {
    if (code === null) return;
    const ctl = new AbortController();
    const k = `${season}:${round}:${code}`;
    api
      .telemetryLaps(season, round, code, ctl.signal)
      .then((laps) => setLoad({ key: k, laps, error: null, status: null }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ key: k, laps: null, ...message(e) });
      });
    return () => ctl.abort();
  }, [season, round, code]);
  return load.key === key ? { laps: load.laps, error: load.error, status: load.status } : { laps: null, error: null, status: null };
}

export interface TelemetryCompareLoad {
  compare: TelemetryCompare | null;
  error: string | null;
}

export interface LapPick {
  code: string;
  lap: number;
}

/** Two laps overlaid; nothing is requested until both picks are set and differ. */
export function useTelemetryCompare(season: number, round: number, a: LapPick | null, b: LapPick | null): TelemetryCompareLoad {
  const aCode = a?.code ?? null;
  const aLap = a?.lap ?? null;
  const bCode = b?.code ?? null;
  const bLap = b?.lap ?? null;
  const key = `${season}:${round}:${aCode}:${aLap}:${bCode}:${bLap}`;
  const [load, setLoad] = useState<TelemetryCompareLoad & { key: string | null }>({ key: null, compare: null, error: null });
  useEffect(() => {
    if (aCode === null || aLap === null || bCode === null || bLap === null) return;
    if (aCode === bCode && aLap === bLap) return;
    const ctl = new AbortController();
    const k = `${season}:${round}:${aCode}:${aLap}:${bCode}:${bLap}`;
    api
      .telemetryCompare(season, round, { code: aCode, lap: aLap }, { code: bCode, lap: bLap }, ctl.signal)
      .then((compare) => setLoad({ key: k, compare, error: null }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ key: k, compare: null, error: message(e).error });
      });
    return () => ctl.abort();
  }, [season, round, aCode, aLap, bCode, bLap]);
  return load.key === key ? { compare: load.compare, error: load.error } : { compare: null, error: null };
}
