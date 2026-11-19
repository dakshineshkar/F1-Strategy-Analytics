"use client";

import { useEffect, useState } from "react";

import { type Engineer, fetchEngineer } from "./engineer";

/** The engineer view of the call's attacker (``GET …/engineer/{attacker}``, laps up to the attacker's
 * latest only): the gap trend, both cars' tyres and the race's pit loss behind the call. Fetched once per
 * new leader lap and per new attacker, like the engineer tab and the race status (no polling). A failure
 * keeps nothing stale: the call then shows the stream's values only. Display only, read only. */
export function useCallContext(season: number, round: number, attackerId: string | null, maxLap: number): Engineer | null {
  const [data, setData] = useState<{ key: string; value: Engineer } | null>(null);
  const key = `${season}:${round}:${attackerId ?? ""}`;
  useEffect(() => {
    if (attackerId === null || maxLap < 1) return;
    const ctl = new AbortController();
    fetchEngineer(season, round, attackerId, ctl.signal)
      .then((value) => setData({ key: `${season}:${round}:${attackerId}`, value }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [season, round, attackerId, maxLap]);
  return data !== null && data.key === key ? data.value : null;
}
