"use client";

import { type CSSProperties, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

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
  rejoinLanes,
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
  zeroPct,
} from "@/lib/engineer";
import { fullName, teammates, type EntrantIndex } from "@/lib/entrants";
import { driverName, lapTime } from "@/lib/format";
import { useWidth } from "@/lib/useWidth";

const SPARK_W = 120;
const SPARK_H = 32;
/** Label lanes the rejoin bar always reserves (more only when a lap needs them). */
const REJOIN_LANES = 3;

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

/** The gap of a pair over its last laps, as a small line beside the sentence it supports (critique F21): one
 * neutral 2 px line, the latest lap as the only dot, its value as a direct label, and every value as text. */
export function GapSparkline({ pair, label }: { pair: EngineerPair; label: string }) {
  const pts = sparkline(pair.gaps, SPARK_W, SPARK_H, 4);
  const values = pair.gaps.map((g) => `${g.gap_s.toFixed(1)}`).join(", ");
  const last = pts[pts.length - 1] ?? null;
  if (last === null) {
    // say why there is no line (F12), never a caption of dashes
    return (
      <figure className="eng-spark">
        <figcaption>{label}: no lap of this pair completed yet.</figcaption>
      </figure>
    );
  }
  return (
    <figure className="eng-spark">
      <div className="eng-spark-plot">
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`${label}: ${values} s`} className="eng-spark-svg">
          <title>{`${label} by lap: ${values} s`}</title>
          {pts.length > 1 ? (
            <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ) : null}
          <circle cx={last.x} cy={last.y} r={3} fill="currentColor" stroke="var(--surface)" strokeWidth={1.5} />
        </svg>
        <span className="eng-spark-end num" aria-hidden="true">
          {last.gap_s.toFixed(1)} s
        </span>
      </div>
      <figcaption>
        {label}, laps {pair.gaps[0]?.lap}–{last.lap}: {values} s
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

/** "Pit now" against the field (critique F20): a seconds axis (behind the focus now) with every car as a tick, the
 * code labels in lanes so they never overlap, 0 s (the focus now) and the rejoin slot as an authored triangle in
 * its own row under the axis, and the same in a sentence (the bar itself is hidden from screen readers). */
export function RejoinBar({ rejoin, names }: { rejoin: EngineerRejoin; names: Names }) {
  const bar = rejoinBar(rejoin);
  const { ref: trackRef, width: trackWidth } = useWidth<HTMLDivElement>(640, 120);
  const placed = rejoinLanes(bar.marks, trackWidth);
  const lanes = Math.max(REJOIN_LANES, ...placed.map((p) => p.lane + 1));
  const zero = zeroPct(bar.window);
  const [lo, hi] = bar.window;
  const sentence =
    rejoin.position === null
      ? "No rejoin estimate (no pit-loss prior)."
      : `Pit now: rejoins P${rejoin.position}` +
        (rejoin.ahead_id ? ` behind ${names.code(rejoin.ahead_id)} (${rejoin.gap_ahead_s?.toFixed(1)} s)` : " in the lead") +
        (rejoin.behind_id ? `, ahead of ${names.code(rejoin.behind_id)} (${rejoin.gap_behind_s?.toFixed(1)} s)` : "") +
        (rejoin.in_traffic ? ", in traffic." : ".");
  return (
    <div className="eng-rejoin">
      <p className="eng-rejoin-sentence">
        {sentence}{" "}
        {rejoin.reliable ? null : <strong className="eng-unreliable">Unreliable: {rejoin.reasons.join(", ")}.</strong>}
      </p>
      <p className="panel-note">
        {rejoin.pit_loss_s === null ? "Pit loss: no estimate (no pit-loss prior)." : `Pit loss ${rejoin.pit_loss_s.toFixed(1)} s: ${rejoin.pit_loss_text}.`}
        {rejoin.left_out > 0 ? ` ${rejoin.left_out} cars a lap or more down are not placed.` : ""}
      </p>
      <div className="rejoin-chart" aria-hidden="true" style={{ "--rj-lanes": lanes } as CSSProperties}>
        <div className="rejoin-labels" ref={trackRef}>
          {placed.map(({ mark, lane }) => (
            <span
              key={mark.driverId}
              className={`rejoin-mark${mark.projected ? " is-projected" : ""}`}
              style={{ left: `${mark.pct}%`, "--lane": lane } as CSSProperties}
            >
              {names.code(mark.driverId)}
            </span>
          ))}
        </div>
        <div className="rejoin-axis">
          <span className="rejoin-zero" style={{ left: `${zero}%` }} />
          {placed.map(({ mark }) => (
            <span key={mark.driverId} className={`rejoin-tick${mark.projected ? " is-projected" : ""}`} style={{ left: `${mark.pct}%` }} />
          ))}
          {bar.slot !== null ? <span className="rejoin-slot-tick" style={{ left: `${bar.slot}%` }} /> : null}
        </div>
        <div className="rejoin-scale">
          <span className="rejoin-scale-lo num">{lo < 0 ? `−${Math.abs(lo)}` : lo} s</span>
          <span className="rejoin-scale-zero num" style={{ left: `${zero}%` }}>
            0 s, now
          </span>
          <span className="rejoin-scale-hi num">+{hi.toFixed(1)} s behind</span>
        </div>
        {bar.slot !== null ? (
          <div className="rejoin-slot-row">
            <span className="rejoin-slot" style={{ left: `${bar.slot}%` }}>
              <svg className="rejoin-slot-mark" viewBox="0 0 10 8" width="10" height="8">
                <path d="M5 0 L10 8 L0 8 Z" fill="currentColor" />
              </svg>
              rejoin
            </span>
          </div>
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

/** The calls (display rules) and a live region that announces only calls new since the last lap. A call's kind is
 * a chip that differs by its word and outline (Watch: 2 px solid, Info: 1 px dotted), never a side bar (F35). */
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
            <li key={c.id} className={`eng-call${c.severity === "warn" ? " is-warn" : ""}`}>
              <span className={`eng-kind kind-${c.severity === "warn" ? "watch" : "info"}`}>{c.severity === "warn" ? "Watch" : "Info"}</span>
              <span className="visually-hidden">: </span>
              <span className="eng-call-text">{c.text}</span>
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
  suggested = null,
}: {
  season: number;
  round: number;
  order: readonly string[];
  maxLap: number;
  entrants: EntrantIndex;
  /** the focus to start from when this browser has none locked: the live call's attacker (critique F19) */
  suggested?: string | null;
}) {
  const stored = useSyncExternalStore(subscribeStorage, () => loadFocus(), () => null);
  const [picked, setPicked] = useState<string | null>(null);
  const locked = picked ?? stored ?? suggested;
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
          {/* separate cells, never a dot-joined string; each wraps as a whole */}
          <p className="eng-status">
            <span className="eng-cell">
              <span className="k">Lap</span>{" "}
              <span className="num">
                {shown.lap}
                {shown.lap !== shown.current_lap ? ` of ${shown.current_lap}` : ""}
              </span>
            </span>
            <span className="eng-cell">
              <span className="k">Track</span> {NEUTRAL_TEXT[shown.neutralised.status]}
              {shown.neutralised.source === "estimated" ? <span className="muted"> (estimated from lap times: no race-control data)</span> : null}
            </span>
            {shown.neutralised.message ? (
              <span className="eng-cell">
                <span className="k">Race control, lap {shown.neutralised.message_lap}</span> {shown.neutralised.message}
              </span>
            ) : null}
            {error !== null ? <span className="eng-cell error">{error}</span> : null}
          </p>
          <div className="eng-cards">
            <EngineerCard role="Ahead" car={shown.ahead} focus={shown.focus} entrants={entrants} isTeammate={shown.ahead !== null && mates.has(shown.ahead.driver_id)} names={names} />
            <EngineerCard role="Focus" car={shown.focus} focus={shown.focus} entrants={entrants} isTeammate={false} names={names} />
            <EngineerCard role="Behind" car={shown.behind} focus={shown.focus} entrants={entrants} isTeammate={shown.behind !== null && mates.has(shown.behind.driver_id)} names={names} />
          </div>
          <section className="eng-pairs" aria-label="Gaps">
            <h3>
              Gaps <InfoTip id="gaptrend" /> <InfoTip id="engprob" />
            </h3>
            {shown.pair_ahead ? <PairLine pair={shown.pair_ahead} names={names} label="To the car ahead" /> : <p className="muted">Leading.</p>}
            {shown.pair_behind ? <PairLine pair={shown.pair_behind} names={names} label="From the car behind" /> : <p className="muted">No car behind.</p>}
          </section>
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
