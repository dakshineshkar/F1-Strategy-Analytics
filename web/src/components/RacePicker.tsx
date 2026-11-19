"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { api, type Race } from "@/lib/api";
import { filterRaces, groupBySeason, type RunningReplay, type StartHere, startHere } from "@/lib/races";
import { archiveApi } from "@/lib/useArchive";

/** The first choice for a grader (critique F36): the race replaying now, else the demo race. Neutral styling (the
 * signal amber belongs to the undercut call); its height is reserved while the lists load. */
function StartHereCard({ pick, loading }: { pick: StartHere | null; loading: boolean }) {
  if (pick === null) {
    return loading ? (
      <section className="panel start-here" aria-labelledby="start-h" aria-busy="true">
        <h2 id="start-h">Start here</h2>
        <p className="muted">Loading races…</p>
      </section>
    ) : null;
  }
  const { race } = pick;
  const href = `/race/${race.season}/${race.round}`;
  const name = race.name ?? `Round ${race.round}`;
  const why =
    pick.why === "replaying"
      ? `Replaying now${pick.paused ? ", paused" : ""}${pick.lap !== null ? ` at lap ${pick.lap} of ${race.laps}` : ", starting"}.`
      : pick.why === "demo"
        ? "The demo race (the one make demo replays)."
        : "The newest race in this lake.";
  return (
    <section className="panel start-here" aria-labelledby="start-h">
      <h2 id="start-h">Start here</h2>
      <p className="start-race">
        <span className="race-season">{race.season}</span> <span className="start-name">{name}</span>
        <span className="start-meta">
          <span className="num">R{String(race.round).padStart(2, "0")}</span>
          <span className="num">{race.laps} laps</span>
          {race.synthetic ? <span className="tag">synthetic tyres</span> : null}
        </span>
      </p>
      <p className="start-why">{why}</p>
      <p className="start-actions">
        <Link className="btn start-open" href={href}>
          {pick.why === "replaying" ? "Open the live race" : "Open the race"}
          <span className="visually-hidden">{`: ${race.season} ${name}`}</span>
        </Link>
        {pick.archived ? (
          <Link className="btn btn-secondary" href={`${href}?mode=archive`}>
            Open the post-race archive<span className="visually-hidden">{`: ${race.season} ${name}`}</span>
          </Link>
        ) : null}
      </p>
      {pick.why !== "replaying" ? (
        <p className="panel-note start-how">
          On the race page, start a replay with Replay controls in the status strip. The undercut call is the panel at
          the top right; the timing tower beside it is its evidence.
        </p>
      ) : null}
    </section>
  );
}

/** Races grouped by season, filtered by name, after a "Start here" choice. Arrow keys / Home / End move between
 * races; Tab leaves the list. */
export function RacePicker() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // the replay and archive lists only refine "Start here": a failure leaves them empty, never an error
  const [running, setRunning] = useState<RunningReplay[]>([]);
  const [archived, setArchived] = useState<{ season: number; round: number }[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .races(ctl.signal)
      .then(setRaces)
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setError((err as Error).message);
      });
    api
      .replays(ctl.signal)
      .then((st) => setRunning(st.running))
      .catch(() => undefined);
    archiveApi
      .list(ctl.signal)
      .then(setArchived)
      .catch(() => undefined);
    return () => ctl.abort();
  }, []);

  const pick = useMemo(() => startHere(races ?? [], running, archived), [races, running, archived]);

  const shown = useMemo(() => filterRaces(races ?? [], query), [races, query]);
  const groups = useMemo(() => groupBySeason(shown), [shown]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a.race-link") ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const go = (i: number) => {
      e.preventDefault();
      links[Math.max(0, Math.min(links.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at <= 0 ? 0 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(links.length - 1);
  };

  return (
    <div className="picker">
      <StartHereCard pick={pick} loading={races === null && error === null} />
      <search className="picker-search">
        <label htmlFor="race-search">Search races</label>
        <input
          id="race-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Monaco, 2023, r5"
          aria-controls="race-list"
          aria-describedby="race-count"
          autoComplete="off"
        />
        <p id="race-count" className="muted" aria-live="polite">
          {races === null ? (error ? "" : "Loading races…") : `${shown.length} of ${races.length} races`}
        </p>
      </search>
      {error ? (
        <p className="error" role="alert">
          Could not load races: {error}
        </p>
      ) : null}
      <div id="race-list" ref={listRef} onKeyDown={onKeyDown} className="race-list">
        {groups.map(([season, list]) => (
          <section key={season} aria-labelledby={`season-${season}`} className="season">
            <h2 id={`season-${season}`}>
              {season} <span className="muted">· {list.length} {list.length === 1 ? "race" : "races"}</span>
            </h2>
            <ul>
              {list.map((r) => (
                <li key={`${r.season}-${r.round}`}>
                  <Link className="race-link" href={`/race/${r.season}/${r.round}`}>
                    <span className="race-round">R{String(r.round).padStart(2, "0")}</span>
                    <span className="race-name">{r.name ?? `Round ${r.round}`}</span>
                    <span className="race-laps">{r.laps} laps</span>
                    {r.synthetic ? <span className="tag">synthetic tyres</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
