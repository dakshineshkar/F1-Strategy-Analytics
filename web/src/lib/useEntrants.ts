"use client";

import { useEffect, useState } from "react";

import { api, ApiError } from "./api";
import type { Entrant } from "./entrants";

export interface EntrantsLoad {
  entrants: Entrant[] | null;
  /** null while loading or after success; a short reason otherwise (404: none in the lake). */
  error: string | null;
}

/** The race's entrants, loaded once per race (display only; the race stream never waits for it).
 * The stored result carries its race key, so after a race change the old result reads as loading. */
export function useEntrants(season: number, round: number): EntrantsLoad {
  const key = `${season}:${round}`;
  const [load, setLoad] = useState<EntrantsLoad & { key: string | null }>({ key: null, entrants: null, error: null });
  useEffect(() => {
    const ctl = new AbortController();
    api
      .entrants(season, round, ctl.signal)
      .then((r) => setLoad({ key: `${season}:${round}`, entrants: r.entrants, error: null }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const error = e instanceof ApiError ? e.message : "entrants unavailable";
        setLoad({ key: `${season}:${round}`, entrants: null, error });
      });
    return () => ctl.abort();
  }, [season, round]);
  return load.key === key ? { entrants: load.entrants, error: load.error } : { entrants: null, error: null };
}
