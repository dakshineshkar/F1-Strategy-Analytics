"use client";

import { useEffect, useState } from "react";

import { ApiError, request } from "./api";
import { type ArchiveBundle, toArchiveBundle, toArchiveList } from "./archive";

/** Post-race archive requests (Feature 4, display only). HTTP-cached: the browser revalidates with
 * the ETag (``no-cache``), so an unchanged bundle costs a 304. 404 when the race has no bundle. */
export const archiveApi = {
  list: (signal?: AbortSignal) =>
    request("/api/archive", toArchiveList, { cache: "no-cache", ...(signal ? { signal } : {}) }),
  bundle: (season: number, round: number, signal?: AbortSignal) =>
    request(`/api/archive/${season}/${round}`, toArchiveBundle, {
      cache: "no-cache",
      ...(signal ? { signal } : {}),
    }),
};

export interface ArchiveLoad {
  data: ArchiveBundle | null;
  /** null while loading or after success; a short reason otherwise (404: no bundle). */
  error: string | null;
  status: number | null;
}

/** The race's post-race bundle, loaded once per race (display only). The stored result carries its
 * race key, so after a race change the old result reads as loading. */
export function useArchive(season: number, round: number): ArchiveLoad {
  const key = `${season}:${round}`;
  const [load, setLoad] = useState<ArchiveLoad & { key: string | null }>({ key: null, data: null, error: null, status: null });
  useEffect(() => {
    const ctl = new AbortController();
    const k = `${season}:${round}`;
    archiveApi
      .bundle(season, round, ctl.signal)
      .then((data) => setLoad({ key: k, data, error: null, status: 200 }))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const err = e instanceof ApiError ? { error: e.message, status: e.status } : { error: "archive unavailable", status: null };
        setLoad({ key: k, data: null, ...err });
      });
    return () => ctl.abort();
  }, [season, round]);
  return load.key === key ? load : { data: null, error: null, status: null };
}

/** Whether the race has a post-race bundle: true / false once ``GET /api/archive`` answered, null
 * while loading or when the listing failed (the mode switch then stays enabled). */
export function useArchiveAvailable(season: number, round: number): boolean | null {
  const [races, setRaces] = useState<{ season: number; round: number }[] | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    archiveApi
      .list(ctl.signal)
      .then(setRaces)
      .catch(() => {
        if (!ctl.signal.aborted) setRaces(null);
      });
    return () => ctl.abort();
  }, []);
  return races === null ? null : races.some((r) => r.season === season && r.round === round);
}
