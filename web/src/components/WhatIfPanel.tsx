"use client";

import { forwardRef, useEffect, useState } from "react";

import { type EntrantIndex, teammates } from "@/lib/entrants";
import { driverCode, driverName, probability } from "@/lib/format";
import { glossary } from "@/lib/legend";
import {
  attackerChoices,
  barWidth,
  defenderFor,
  fetchWhatIf,
  gapOutcome,
  pitLossSourceText,
  rangeText,
  reasonText,
  STRATEGY_LABEL,
  type Strategy,
  timelineText,
  warningTexts,
  type WhatIf,
  whatifMessage,
} from "@/lib/whatif";


/** One scale for every range bar of a result: ± the widest end, so rows compare at a glance. */
function rangeScale(rows: readonly Strategy[]): number {
  let m = 1;
  for (const s of rows) if (s.interval80_s !== null) m = Math.max(m, Math.abs(s.interval80_s[0]), Math.abs(s.interval80_s[1]));
  return m;
}

function RangeBar({ interval, expected, scale }: { interval: [number, number] | null; expected: number | null; scale: number }) {
  if (interval === null) return null;
  const x = (v: number) => 50 + (v / scale) * 50;
  const [lo, hi] = interval[0] <= interval[1] ? interval : [interval[1], interval[0]];
  return (
    <span className="wi-range" aria-hidden="true">
      <span className="wi-range-level" />
      <span className="wi-range-span" style={{ left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%` }} />
      {expected !== null ? <span className="wi-range-mid" style={{ left: `${x(expected)}%` }} /> : null}
    </span>
  );
}

function StrategyRow({ s, scale }: { s: Strategy; scale: number }) {
  const p = s.p_attacker_ahead;
  return (
    <tr className={s.feasible ? undefined : "is-infeasible"}>
      <th scope="row">
        <span className="wi-name">{STRATEGY_LABEL[s.strategy]}</span>
        <span className="wi-timeline">{timelineText(s)}</span>
      </th>
      {s.feasible ? (
        <>
          <td className="wi-prob">
            <span className="wi-prob-num num">{probability(p)}</span>
            <span className="wi-bar" aria-hidden="true">
              <span className="wi-fill" style={{ transform: `scaleX(${barWidth(p) / 100})` }} />
            </span>
          </td>
          <td className="wi-num num">{gapOutcome(s.expected_gap_s)}</td>
          <td className="wi-num">
            <span className="num">{rangeText(s.interval80_s)}</span>
            <RangeBar interval={s.interval80_s} expected={s.expected_gap_s} scale={scale} />
          </td>
        </>
      ) : (
        <td colSpan={3} className="wi-reason">
          {reasonText(s.reason)}
        </td>
      )}
    </tr>
  );
}

/** A request from the call or an alert: fill the pair and run (``nonce`` makes a repeat click run again). */
export interface WhatIfRequestFromCall {
  attacker: string;
  nonce: number;
}

/** What-if (critique F11, F14–F18): pit now / pit next lap / stay out for an attacker and the car directly
 * ahead, from the same race state. Results are a modelled comparison (the share of simulated runs in which
 * the attacker comes out ahead, the expected gap and its 80% range), with the calibration caveat next to
 * the numbers; never odds. There is no default pair: it starts from the call, an alert, or the attacker
 * picked here. The defender is derived (the API simulates only the car directly ahead) and a teammate pair
 * is named before the run. Until the viewer picks an attacker, the selection follows the call's attacker
 * (``suggested``), but nothing runs until Run is pressed (or Simulate on the call or an alert). Before a run
 * there is no table, only a one-line state; the explanation sits in a "How to read this" disclosure. */
export const WhatIfPanel = forwardRef<HTMLElement, {
  season: number;
  round: number;
  order: string[];
  entrants?: EntrantIndex;
  request?: WhatIfRequestFromCall | null;
  /** the call's attacker: preselected until the viewer picks (never run on its own) */
  suggested?: string | null;
}>(function WhatIfPanel({ season, round, order, entrants = {}, request = null, suggested = null }, ref) {
  const choices = attackerChoices(order);
  /** null: follow ``suggested``; "" or an id: the viewer's choice */
  const [chosen, setAttacker] = useState<string | null>(null);
  const following = chosen === null && suggested !== null && choices.includes(suggested);
  const attacker = chosen ?? (following ? (suggested ?? "") : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIf | null>(null);
  /** the run in flight; a new job aborts the previous one (effect cleanup) */
  const [job, setJob] = useState<{ attacker: string; defender: string; n: number } | null>(null);
  const code = (id: string) => entrants[id]?.code ?? driverCode(id);
  const label = (id: string): string => `${code(id)} · ${entrants[id]?.family_name ?? driverName(id)}`;
  const isMate = (a: string, b: string) => teammates(entrants, a).some((m) => m.driver_id === b);
  const { defender, teammate } = attacker ? defenderFor(order, attacker, isMate) : { defender: null, teammate: false };

  const start = (att: string, def: string) => {
    setPending(true);
    setError(null);
    setJob((j) => ({ attacker: att, defender: def, n: (j?.n ?? 0) + 1 }));
  };

  // a "Simulate" from the call or an alert: fill the pair and run, once per click (state during render)
  const [seen, setSeen] = useState<number | null>(null);
  if (request !== null && request.nonce !== seen) {
    setSeen(request.nonce);
    setAttacker(request.attacker);
    const d = defenderFor(order, request.attacker, isMate).defender;
    if (d !== null) start(request.attacker, d);
    else setError(`${code(request.attacker)} has no car directly ahead now.`);
  }

  useEffect(() => {
    if (job === null) return;
    const c = new AbortController();
    fetchWhatIf(season, round, { attacker: job.attacker, defender: job.defender }, c.signal)
      .then((r) => {
        if (!c.signal.aborted) setResult(r);
      })
      .catch((err: unknown) => {
        if (!c.signal.aborted) setError(whatifMessage(err));
      })
      .finally(() => {
        if (!c.signal.aborted) setPending(false);
      });
    return () => c.abort();
  }, [job, season, round]);

  const disabled = pending || !attacker || defender === null;
  const status = pending
    ? "Simulating…"
    : result
      ? `${code(result.attacker)} on ${code(result.defender)} from lap ${result.inputs.current_lap ?? "?"}: ${result.n} simulated runs, seed ${result.seed}, ${Math.round(result.runtime_ms)} ms`
      : choices.length === 0
        ? "Waiting for the race order."
        : following && defender !== null
          ? `No run yet. ${code(attacker)} on ${code(defender)} is preselected from the call: press Run what-if.`
          : "No run yet. Choose an attacker, or press Simulate on the call or an alert.";
  const all = result ? [...result.strategies, ...result.sensitivity] : [];
  const scale = rangeScale(all);
  const modelNote =
    result === null
      ? null
      : result.model.probability === null
        ? `not scored at lap ${result.inputs.current_lap ?? "?"}: the pair is not an undercut candidate now (gap above 3.5 s, teammates, or a pit or neutralised lap)`
        : null;

  return (
    <section ref={ref} id="whatif" className="panel whatif-panel" aria-labelledby="whatif-h" tabIndex={-1}>
      <div className="panel-head">
        <h2 id="whatif-h">What-if: pit strategy</h2>
        {result?.inputs.synthetic ? <span className="stamp">Synthetic tyres</span> : null}
      </div>
      <form
        className="whatif-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && defender !== null) start(attacker, defender);
        }}
      >
        <label className="wi-field">
          <span>Attacker</span>
          <select value={attacker} onChange={(e) => setAttacker(e.target.value)} disabled={choices.length === 0} aria-describedby="whatif-status">
            <option value="">Choose a car</option>
            {choices.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </select>
        </label>
        <p className="wi-defender">
          <span className="wi-defender-label">Defender (car ahead)</span>
          <span className="wi-defender-value">{defender === null ? "—" : label(defender)}</span>
        </p>
        <button type="submit" className="btn" disabled={disabled} aria-describedby="whatif-status">
          {pending ? "Running…" : "Run what-if"}
        </button>
      </form>
      {teammate && defender !== null ? (
        <p className="whatif-warning">
          {code(attacker)} and {code(defender)} are teammates: the undercut rule never flags this pair, so the model has
          no estimate for it.
        </p>
      ) : null}
      <p id="whatif-status" className="whatif-status" role="status">
        {status}
      </p>
      <p className="replay-error" role="alert">
        {error ?? ""}
      </p>
      <p className="panel-note wi-summary">
        A modelled comparison of three strategies from the same race state: not odds, and less well calibrated than the
        model.
      </p>
      <details className="wi-how">
        <summary>How to read this</summary>
        <p id="whatif-note" className="panel-note">
          {glossary("whatif").text}
        </p>
      </details>
      {result ? (
        <table className="whatif-table">
          <caption className="visually-hidden">
            Modelled comparison of three pit strategies from the same race state: share of simulated runs with the
            attacker ahead once both cars have stopped, expected gap and 80% range
          </caption>
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Share of sim runs ahead</th>
              <th scope="col">Expected gap</th>
              <th scope="col">80% range</th>
            </tr>
          </thead>
          <tbody>
            {result.strategies.map((s) => (
              <StrategyRow key={s.strategy} s={s} scale={scale} />
            ))}
          </tbody>
          <tbody className="wi-sensitivity">
            <tr>
              <th scope="rowgroup" colSpan={4}>
                Sensitivity: the defender covers 2 laps later
              </th>
            </tr>
            {result.sensitivity.map((s) => (
              <StrategyRow key={`s-${s.strategy}`} s={s} scale={scale} />
            ))}
          </tbody>
        </table>
      ) : null}
      {result ? (
        <>
          <p className="whatif-model">
            <span className="wi-model-label">Model estimate (calibrated, from the stream, {result.model.model_version}):</span>{" "}
            <strong className="num">{probability(result.model.probability)}</strong>
            {result.model.undercut_flag ? <span> flagged by the rule</span> : null}
            {modelNote !== null ? <span className="muted"> {modelNote}</span> : null}
          </p>
          <p className="whatif-inputs muted">
            <span className="kv">
              Gap <span className="num">{result.inputs.gap_s.toFixed(2)} s</span>
            </span>
            <span className="kv">
              {code(result.attacker)} {result.inputs.attacker.compound.toLowerCase()} to {result.inputs.attacker.new_compound.toLowerCase()}
            </span>
            <span className="kv">
              {code(result.defender)} {result.inputs.defender.compound.toLowerCase()} to {result.inputs.defender.new_compound.toLowerCase()}
            </span>
            <span className="kv">
              pit loss{" "}
              <span className="num">
                {result.inputs.pit_loss_prior_s === null ? "unknown" : `${result.inputs.pit_loss_prior_s.toFixed(1)} s`}
              </span>{" "}
              from {pitLossSourceText(result.inputs.pit_loss_source)}
            </span>
          </p>
          {warningTexts(result.inputs.warnings).map((w) => (
            <p key={w} className="whatif-warning">
              Note: {w}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
});
