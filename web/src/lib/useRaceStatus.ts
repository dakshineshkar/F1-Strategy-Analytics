"use client";

import { useEffect, useState } from "react";

import { fetchRaceStatus, type RaceStatus } from "./raceStatus";

/** The live race-status banner: fetched once per new leader lap (``maxLap``), the request of an
 * older lap aborted. A failure (no laps yet, API down) keeps the last status; ``null`` before the
 * first answer. Display only and read only. */
export function useRaceStatus(season: number, round: number, maxLap: number): RaceStatus | null {
  const [status, setStatus] = useState<{ key: string; value: RaceStatus } | null>(null);
  const key = `${season}:${round}`;
  useEffect(() => {
    if (maxLap < 1) return;
    const ctl = new AbortController();
    fetchRaceStatus(season, round, maxLap, ctl.signal)
      .then((value) => setStatus({ key: `${season}:${round}`, value }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [season, round, maxLap]);
  return status !== null && status.key === key ? status.value : null;
}
