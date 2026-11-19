"use client";

import { useEffect, useState } from "react";

import { type Engineer, fetchEngineer } from "./engineer";

/** The race's pit loss as the engineer view states it (``rejoin.pit_loss_s`` and its source). The API takes it
 * from the race's prior (``pit_loss(season, round)``), so it is the same for every car of the race. */
export interface RacePitLoss {
  s: number | null;
  source: Engineer["rejoin"]["pit_loss_source"];
}

/** The pit loss an engineer response carries; null without a response. */
export function pitLossOf(engineer: Engineer | null): RacePitLoss | null {
  return engineer === null ? null : { s: engineer.rejoin.pit_loss_s, source: engineer.rejoin.pit_loss_source };
}

/** The engineer view of the call's attacker (``GET …/engineer/{attacker}``, laps up to the attacker's latest
 * only): the gap trend and both cars' tyres behind the call, plus the race's pit loss. Fetched once per new
 * leader lap and per new attacker, like the engineer tab and the race status (no polling).
 *
 * ``leaderLap`` is the leader's lap as the page knows it (``leaderLap`` in stale.ts), so a page that holds only
 * the snapshot so far (a late join, before the next crossing) fetches at once. The pit loss is per race: it is
 * kept from any response for this race and survives a change of attacker, so the call states the same value at
 * any width and whichever pair it shows. A failure keeps nothing stale: the call then shows the stream's values
 * only. Display only, read only. */
export function useCallContext(
  season: number,
  round: number,
  attackerId: string | null,
  leaderLap: number,
): { context: Engineer | null; pitLoss: RacePitLoss | null } {
  const [data, setData] = useState<{ key: string; value: Engineer } | null>(null);
  const [loss, setLoss] = useState<{ race: string; value: RacePitLoss } | null>(null);
  const race = `${season}:${round}`;
  const key = `${race}:${attackerId ?? ""}`;
  useEffect(() => {
    if (attackerId === null || leaderLap < 1) return;
    const ctl = new AbortController();
    fetchEngineer(season, round, attackerId, ctl.signal)
      .then((value) => {
        setData({ key: `${season}:${round}:${attackerId}`, value });
        const p = pitLossOf(value);
        if (p !== null) setLoss({ race: `${season}:${round}`, value: p });
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [season, round, attackerId, leaderLap]);
  return {
    context: data !== null && data.key === key ? data.value : null,
    pitLoss: loss !== null && loss.race === race ? loss.value : null,
  };
}
