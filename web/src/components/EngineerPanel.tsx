"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { CompoundTag } from "@/components/analysis/common";
import { InfoTip } from "@/components/InfoTip";
import { Legend } from "@/components/Legend";
import { TeamBadge } from "@/components/TeamBadge";
import {
  engineerMessage,
  fetchEngineer,
  loadFocus,
  NEUTRAL_TEXT,
  newCalls,
  pickFocus,
  probText,
  rejoinBar,
  saveFocus,
  signed,
  sparkline,
  stintText,
  trendText,
  tyreText,
  type Engineer,
  type EngineerCall,
  type EngineerCar,
  type EngineerPair,
  type EngineerRejoin,
} from "@/lib/engineer";
import { fullName, teammates, type EntrantIndex } from "@/lib/entrants";
import { driverName, lapTime } from "@/lib/format";

const SPARK_W = 120;
const SPARK_H = 32;

interface Names {
  code: (id: string) => string;
  name: (id: string) => string;
}

function namesFor(entrants: EntrantIndex): Names {
  return {
    code: (id) => entrants[id]?.code ?? id.slice(0, 3).toUpperCase(),
    name: (id) => {
      const e = entrants[id];
      return e ? fullName(e) : driverName(id);
    },
  };
}

/** The gap of a pair over its last laps, as a small line (values also as text). */
export function GapSparkline({ pair, label }: { pair: EngineerPair; label: string }) {
  const pts = sparkline(pair.gaps, SPARK_W, SPARK_H);
  const values = pair.gaps.map((g) => `${g.gap_s.toFixed(1)}`).join(", ");
  return (
    <figure className="eng-spark">
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`${label}: ${values || "no laps"} s`} className="eng-spark-svg">
        <title>{`${label} by lap: ${values || "no laps"} s`}</title>
        {pts.length > 1 ? <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} /> : null}
        {pts.map((p) => (
          <circle key={p.lap} cx={p.x} cy={p.y} r={1.75} fill="currentColor" />
        ))}
      </svg>
      <figcaption className="muted">
        {label}, laps {pair.gaps[0]?.lap ?? "—"}–{pair.gaps[pair.gaps.length - 1]?.lap ?? "—"}: {values || "—"} s
      </figcaption>
    </figure>
  );
}

/** One card: the car, its position, tyres, stint, pace and probability, all as text. */
export function EngineerCard({
  role,
  car,
  focus,
  entrants,
  isTeammate,
  names,
}: {
  role: "Ahead" | "Focus" | "Behind";
  car: EngineerCar | null;
  focus: EngineerCar;
  entrants: EntrantIndex;
  isTeammate: boolean;
  names: Names;
}) {
  const id = useId();
  if (car === null) {
    return (
      <section className="eng-card" aria-labelledby={id}>
        <h3 id={id}>{role}</h3>
        <p className="muted">{role === "Ahead" ? "Leading: no car ahead." : "No car behind."}</p>
      </section>
    );
  }
  const entrant = entrants[car.driver_id];
  const isFocus = car.driver_id === focus.driver_id;
  return (
    <section className={`eng-card${isFocus ? " is-focus" : ""}`} aria-labelledby={id}>
      <h3 id={id}>
        {role}: P{car.position} {entrant ? <TeamBadge entrant={entrant} /> : null}
        <span className="code">{names.code(car.driver_id)}</span> <span className="muted">{names.name(car.driver_id)}</span>
        {isTeammate ? <span className="tag">teammate</span> : null}
        {car.in_pit ? <span className="tag tag-pit">IN PIT</span> : null}
      </h3>
      <dl className="eng-dl">
        <div>
          <dt>Tyre</dt>
          <dd>
            <CompoundTag compound={car.compound} />, {tyreText(car)}
            {!isFocus && car.tyre_life_delta_laps !== null ? ` (${signed(car.tyre_life_delta_laps, 0)} vs focus)` : ""}
          </dd>
        </div>
        <div>
          <dt>Stint</dt>
          <dd>{stintText(car)}</dd>
        </div>
        <div>
          <dt>Pace (last 3)</dt>
          <dd>
            {car.pace_last3_s === null ? "needs 3 clean laps" : lapTime(car.pace_last3_s)}
            {!isFocus && car.pace_delta_s !== null ? ` (${signed(car.pace_delta_s, 2)} s vs focus)` : ""}
          </dd>
        </div>
        <div>
          <dt>Last lap</dt>
          <dd>
            {lapTime(car.last_lap_time_s)} (lap {car.lap}
            {car.projected ? ", lap not completed yet: projected" : ""})
          </dd>
        </div>
        <div>
          <dt>Undercut probability</dt>
          <dd>{probText(car.undercut_prob, car.prob_recorded)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** "Pit now" against the field: the cars as ticks on a time axis, the rejoin slot as a ▼ shape,
 * and the same in a sentence. */
export function RejoinBar({ rejoin, names }: { rejoin: EngineerRejoin; names: Names }) {
  const bar = rejoinBar(rejoin);
  const sentence =
    rejoin.position === null
      ? "No rejoin estimate (no pit-loss prior)."
      : `Pit now: rejoins P${rejoin.position}` +
        (rejoin.ahead_id ? ` behind ${names.code(rejoin.ahead_id)} (${rejoin.gap_ahead_s?.toFixed(1)} s)` : " in the lead") +
        (rejoin.behind_id ? `, ahead of ${names.code(rejoin.behind_id)} (${rejoin.gap_behind_s?.toFixed(1)} s)` : "") +
        (rejoin.in_traffic ? ", in traffic." : ".");
  return (
    <div className="eng-rejoin">
      <p>
        {sentence}{" "}
        {rejoin.reliable ? null : <strong className="eng-unreliable">Unreliable: {rejoin.reasons.join(", ")}.</strong>}
      </p>
      <p className="panel-note">
        Pit loss {rejoin.pit_loss_s === null ? "—" : `${rejoin.pit_loss_s.toFixed(1)} s`}: {rejoin.pit_loss_text}.
        {rejoin.left_out > 0 ? ` ${rejoin.left_out} cars a lap or more down are not placed.` : ""}
      </p>
      <div className="rejoin-bar" aria-hidden="true">
        {bar.marks.map((m) => (
          <span key={m.driverId} className={`rejoin-mark${m.projected ? " is-projected" : ""}`} style={{ left: `${m.pct}%` }}>
            {names.code(m.driverId)}
          </span>
        ))}
        {bar.slot !== null ? (
          <span className="rejoin-slot" style={{ left: `${bar.slot}%` }}>
            ▼ rejoin
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PairLine({ pair, names, label }: { pair: EngineerPair; names: Names; label: string }) {
  const rear = names.code(pair.rear_id);
  const front = names.code(pair.front_id);
  return (
    <div className="eng-pair">
      <p>
        <strong>{label}</strong>: {rear} is {pair.gap_s.toFixed(1)} s behind {front}
        {pair.projected ? " (projected)" : ""}; {trendText(pair.trend_s_per_lap, pair.trend_laps)}.{" "}
        {pair.prob_role === "focus_on_ahead" ? "Undercut" : "Threat"} ({rear} on {front}): {probText(pair.prob, pair.prob_recorded)}
        {pair.pair_matches === false ? " (the stream evaluated it against another car)" : ""}.
      </p>
      <GapSparkline pair={pair} label={`Gap ${rear} to ${front}`} />
    </div>
  );
}

/** The calls (display rules) and a live region that announces only calls new since the last lap. */
export function CallsList({ calls, fresh, disclaimer }: { calls: readonly EngineerCall[]; fresh: readonly EngineerCall[]; disclaimer: string }) {
  return (
    <section className="eng-calls" aria-label="Strategy calls">
      <h3>
        Strategy calls <InfoTip id="engcalls" />
      </h3>
      <p className="panel-note">{disclaimer}</p>
      {calls.length === 0 ? (
        <p className="muted">No call at this lap.</p>
      ) : (
        <ul>
          {calls.map((c) => (
            <li key={c.id} className={c.severity === "warn" ? "is-warn" : undefined}>
              <span className="tag">{c.severity === "warn" ? "WATCH" : "INFO"}</span> {c.text}
            </li>
          ))}
        </ul>
      )}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {fresh.map((c) => c.text).join(". ")}
      </div>
    </section>
  );
}

/** Re-read the lock when another tab of this browser changes it. */
function subscribeStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The engineer view for a live race: a locked focus driver against the cars ahead and behind,
 * refreshed on every new leader lap (display only). */
export function EngineerPanel({
  season,
  round,
  order,
  maxLap,
  entrants,
}: {
  season: number;
  round: number;
  order: readonly string[];
  maxLap: number;
  entrants: EntrantIndex;
}) {
  const stored = useSyncExternalStore(subscribeStorage, () => loadFocus(), () => null);
  const [picked, setPicked] = useState<string | null>(null);
  const locked = picked ?? stored;
  const [data, setData] = useState<Engineer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<EngineerCall[]>([]);
  const prevCalls = useRef<{ focus: string; calls: EngineerCall[] } | null>(null);
  const names = namesFor(entrants);

  const focus = pickFocus(locked, order);

  useEffect(() => {
    if (focus === null) return;
    const ctl = new AbortController();
    fetchEngineer(season, round, focus, ctl.signal)
      .then((d) => {
        const prev = prevCalls.current;
        setFresh(newCalls(prev && prev.focus === focus ? prev.calls : null, d.calls));
        prevCalls.current = { focus, calls: d.calls };
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(engineerMessage(e));
      });
    return () => ctl.abort();
  }, [season, round, focus, maxLap]);

  const onPick = (id: string) => {
    setPicked(id);
    saveFocus(id);
  };
  const shown = data !== null && data.focus_id === focus ? data : null;
  const mates = focus ? new Set(teammates(entrants, focus).map((e) => e.driver_id)) : new Set<string>();

  return (
    <section className="panel engineer" aria-labelledby="engineer-h">
      <div className="panel-head">
        <h2 id="engineer-h">Engineer view</h2>
        <label className="inline-field">
          <span>Focus driver (kept in this browser)</span>
          <select value={focus ?? ""} onChange={(e) => onPick(e.target.value)} disabled={order.length === 0}>
            {order.map((id) => (
              <option key={id} value={id}>
                {names.code(id)} · {names.name(id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {focus === null ? (
        <p className="muted">Waiting for the race to start (no cars yet).</p>
      ) : error !== null && shown === null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : shown === null ? (
        <p className="muted" aria-live="polite">
          Loading the engineer view…
        </p>
      ) : (
        <>
          <p className="eng-status">
            Lap {shown.lap}
            {shown.lap !== shown.current_lap ? ` of ${shown.current_lap}` : ""} · {NEUTRAL_TEXT[shown.neutralised.status]}
            {shown.neutralised.source === "estimated" ? " (estimated from lap times: no race-control data)" : ""}
            {shown.neutralised.message ? ` · race control, lap ${shown.neutralised.message_lap}: ${shown.neutralised.message}` : ""}
            {error !== null ? <span className="error"> · {error}</span> : null}
          </p>
          <div className="eng-cards">
            <EngineerCard role="Ahead" car={shown.ahead} focus={shown.focus} entrants={entrants} isTeammate={shown.ahead !== null && mates.has(shown.ahead.driver_id)} names={names} />
            <EngineerCard role="Focus" car={shown.focus} focus={shown.focus} entrants={entrants} isTeammate={false} names={names} />
            <EngineerCard role="Behind" car={shown.behind} focus={shown.focus} entrants={entrants} isTeammate={shown.behind !== null && mates.has(shown.behind.driver_id)} names={names} />
          </div>
          <div className="eng-pairs">
            <h3>
              Gaps <InfoTip id="gaptrend" /> <InfoTip id="engprob" />
            </h3>
            {shown.pair_ahead ? <PairLine pair={shown.pair_ahead} names={names} label="To the car ahead" /> : <p className="muted">Leading.</p>}
            {shown.pair_behind ? <PairLine pair={shown.pair_behind} names={names} label="From the car behind" /> : <p className="muted">No car behind.</p>}
          </div>
          <section className="eng-rejoin-box" aria-label="Pit-rejoin estimate">
            <h3>
              If {names.code(shown.focus_id)} pits now <InfoTip id="rejoin" />
            </h3>
            <RejoinBar rejoin={shown.rejoin} names={names} />
          </section>
          <CallsList calls={shown.calls} fresh={fresh} disclaimer={shown.disclaimer} />
        </>
      )}
      <Legend groups={["engineer"]} />
    </section>
  );
}
