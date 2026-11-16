"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type Race } from "@/lib/api";
import { useEntrants } from "@/lib/useEntrants";

import { DriversView } from "./DriversView";

export function DriversPage({ season, round }: { season: number; round: number }) {
  const { entrants, error } = useEntrants(season, round);
  const [race, setRace] = useState<Race | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api
      .races(ctl.signal)
      .then((list) => setRace(list.find((r) => r.season === season && r.round === round) ?? null))
      .catch(() => setRace(null));
    return () => ctl.abort();
  }, [season, round]);

  return (
    <>
      <div className="race-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link href="/">All races</Link> / <Link href={`/race/${season}/${round}`}>Race</Link>
        </nav>
        <h1>
          <span className="race-season">{season}</span> {race?.name ?? `Round ${round}`}
          <span className="muted"> · R{round} · Drivers</span>
        </h1>
      </div>
      {error !== null ? (
        <p className="error" role="alert">
          Could not load the drivers: {error}
        </p>
      ) : entrants === null ? (
        <p className="muted" aria-live="polite">
          Loading drivers…
        </p>
      ) : (
        <DriversView entrants={entrants} />
      )}
    </>
  );
}
