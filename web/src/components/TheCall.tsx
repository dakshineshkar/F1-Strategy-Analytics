"use client";

import type { Compound } from "@/lib/api";
import {
  type CallLayout,
  type CallPair,
  closestPair,
  closestReason,
  decisionGap,
  flaggedPairs,
  type ModelIdentity,
  modelDetail,
  noCallReason,
  orderChangedText,
  RULE_GAP_S,
  staleFlaggedCount,
} from "@/lib/call";
import type { Engineer, EngineerCar } from "@/lib/engineer";
import { type EntrantIndex } from "@/lib/entrants";
import { driverCode, driverName, probability } from "@/lib/format";
import { tipId } from "@/lib/legend";
import type { DriverRow, RaceState } from "@/lib/reducer";
import { leaderLap, staleIds } from "@/lib/stale";
import type { RacePitLoss } from "@/lib/useCallContext";
import { pitLossSourceText } from "@/lib/whatif";

import { CallGauge } from "./CallGauge";
import { InfoTip } from "./InfoTip";
import { PairArrow } from "./Marks";
import { TeamBadge } from "./TeamBadge";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

const ENGINEER_COMPOUND: Record<string, Compound> = {
  SOFT: "SOFT",
  MEDIUM: "MEDIUM",
  HARD: "HARD",
  INTERMEDIATE: "INTERMEDIATE",
  WET: "WET",
};

/** A car's tyre as the call states it: the engineer view's real tyre life when it has one, else the
 * stream's inferred stint age (marked "est."). */
function tyreOf(row: DriverRow | undefined, car: EngineerCar | null): { compound: Compound; laps: number | null; est: boolean } {
  const fromCar = car?.compound ? ENGINEER_COMPOUND[car.compound] : undefined;
  if (car !== null && car.tyre_life_laps !== null && car.tyre_life_source === "real") {
    return { compound: fromCar ?? row?.compound ?? "UNKNOWN", laps: car.tyre_life_laps, est: false };
  }
  return { compound: row?.compound ?? fromCar ?? "UNKNOWN", laps: row?.tyreLifeLaps ?? row?.tyreAgeLaps ?? null, est: row?.tyreLifeLaps === null };
}

function Car({ id, entrants, role }: { id: string; entrants: EntrantIndex; role: string }) {
  const e = entrants[id];
  return (
    <span className="call-car">
      {e !== undefined ? <TeamBadge entrant={e} /> : null}
      <span className="call-code">{e?.code ?? driverCode(id)}</span>
      <span className="call-name">
        {e?.family_name ?? driverName(id)}
        <span className="visually-hidden">{`, ${role}`}</span>
      </span>
    </span>
  );
}

function TyreText({ t }: { t: ReturnType<typeof tyreOf> }) {
  return (
    <span className="call-tyre">
      <TyreGlyph compound={t.compound} size={13} />
      <span>{COMPOUND_LABEL[t.compound]}</span>
      <span className="num">{t.laps === null ? "—" : `${t.laps} laps`}</span>
      {t.est && t.laps !== null ? <abbr title="estimated: inferred stint age">est.</abbr> : null}
    </span>
  );
}

/** The engineer view of ``pair``'s attacker, when the one loaded is about that car and its car ahead. */
function contextFor(pair: CallPair | null, context: Engineer | null) {
  const ctx = pair !== null && context !== null && context.focus_id === pair.attackerId ? context : null;
  const matches = ctx !== null && ctx.pair_ahead !== null && ctx.pair_ahead.front_id === pair?.defenderId;
  return { ctx, matches };
}

/** The gauge of ``pair``. The pit loss is the race's (``pitLoss``), whichever car the engineer view was loaded
 * for; the trend needs the view of this very pair. */
function PairGauge({
  pair,
  context,
  pitLoss,
  g,
  muted,
}: {
  pair: CallPair;
  context: Engineer | null;
  pitLoss: RacePitLoss | null;
  g: number;
  muted: boolean;
}) {
  const { ctx, matches } = contextFor(pair, context);
  return (
    <CallGauge
      gapS={pair.gapS ?? ctx?.pair_ahead?.gap_s ?? 0}
      pitLossS={pitLoss?.s ?? null}
      pitLossText={pitLoss === null ? null : pitLossSourceText(pitLoss.source)}
      trend={matches ? (ctx?.pair_ahead?.trend_s_per_lap ?? null) : null}
      trendLaps={matches ? (ctx?.pair_ahead?.trend_laps ?? null) : null}
      g={g}
      muted={muted}
    />
  );
}

/** The live undercut call (critique F03): the best pair flagged now (cars with no timing for 2 or more leader
 * laps excluded), with the calibrated probability as a model estimate with its model id, the gap gauge ("gap
 * now"), the reasons (tyres, the rule and the gap at decision), and "Simulate this pair". When the order changed
 * after the decision, the pair keeps the alert's defender: "flagged at lap N against D; order changed since", with
 * the gauge muted at the decision gap and the rule checks not presented as passing (never relabelled).
 * The only panel in the signal colour.
 *
 * Without a call it keeps its reserved height while a replay streams and shows the closest pair instead (muted,
 * with why it is not a call); while nothing streams it shrinks to one line (``layout="compact"``). After the
 * finish it says the race ended and gives no pit instruction (the strip's transport offers Replay again and the
 * post-race archive, so the call has no button of its own then). With ``stored`` (an
 * earlier run's state and nothing streaming, ``storedLap``) it is one line that says so: no pair, no probability. */
export function TheCall({
  state,
  entrants,
  model,
  context,
  pitLoss = null,
  onSimulate,
  replayIdle,
  stored = null,
  layout = "full",
  ended = false,
}: {
  state: RaceState;
  entrants: EntrantIndex;
  model: ModelIdentity | null;
  /** the engineer view of the shown pair's attacker (trend, tyres, pit loss); null while loading or unavailable */
  context: Engineer | null;
  /** the race's pit loss (``useCallContext``): the same for every pair, so it never depends on which car was loaded */
  pitLoss?: RacePitLoss | null;
  onSimulate: (pair: CallPair) => void;
  /** no replay is running and the tower is empty: the call points to the strip's Start replay */
  replayIdle: boolean;
  /** the stored leader lap when the page shows an earlier run's state and nothing streams (``storedLap``) */
  stored?: number | null;
  layout?: CallLayout;
  /** the race has finished (``raceEnded``) */
  ended?: boolean;
}) {
  const stale = staleIds(state);
  const pairs = flaggedPairs(state, stale);
  const call = ended || stored !== null ? null : (pairs[0] ?? null);
  const lapNow = leaderLap(state);
  const lap = lapNow > 0 ? lapNow : null;
  const g = model?.g ?? RULE_GAP_S;
  const cls = ["panel", "call", call !== null ? "has-call" : null, layout === "compact" ? "is-compact" : null, ended ? "is-ended" : null]
    .filter(Boolean)
    .join(" ");

  return (
    <section id="the-call" className={cls} aria-labelledby="call-h" tabIndex={-1}>
      <div className="call-head">
        <h2 id="call-h">
          The call <InfoTip id="call" />
        </h2>
        <span className="call-meta">
          {lap !== null ? <span className="num">Lap {lap}</span> : null}
          {pairs.length > 1 && call !== null ? <span>{pairs.length - 1} more flagged</span> : null}
          {model?.smoke ? <span className="stamp stamp-smoke">SMOKE TEST</span> : null}
        </span>
      </div>

      {ended ? (
        <Ended lap={lap} />
      ) : stored !== null ? (
        <Stored lap={stored} />
      ) : call !== null ? (
        <FullCall call={call} state={state} entrants={entrants} model={model} context={context} pitLoss={pitLoss} g={g} onSimulate={onSimulate} />
      ) : layout === "compact" || state.order.length === 0 ? (
        <Compact state={state} entrants={entrants} replayIdle={replayIdle} g={g} stale={stale} />
      ) : (
        <NoCall state={state} entrants={entrants} context={context} pitLoss={pitLoss} g={g} stale={stale} onSimulate={onSimulate} />
      )}
    </section>
  );
}

function FullCall({
  call,
  state,
  entrants,
  model,
  context,
  pitLoss,
  g,
  onSimulate,
}: {
  call: CallPair;
  state: RaceState;
  entrants: EntrantIndex;
  model: ModelIdentity | null;
  context: Engineer | null;
  pitLoss: RacePitLoss | null;
  g: number;
  onSimulate: (pair: CallPair) => void;
}) {
  const { ctx, matches } = contextFor(call, context);
  const decision = decisionGap(call);
  return (
    <div className="call-body">
      <p className="call-pair">
        <Car id={call.attackerId} entrants={entrants} role="attacker" />
        <span className="call-arrow">
          <PairArrow size={16} />
          <span className="visually-hidden">undercutting</span>
        </span>
        <Car id={call.defenderId} entrants={entrants} role={call.orderChanged ? "defender at the decision lap" : "defender, the car directly ahead"} />
      </p>

      <div className="call-estimate">
        <p className="call-prob" aria-describedby={tipId("undercut")}>
          <span className="call-prob-num num">{probability(call.prob)}</span>
          <span className="call-prob-label">model estimate that pitting next lap brings {driverCode(call.attackerId)} out ahead</span>
        </p>
        <p className="call-context">
          <span className="call-model">
            {model === null ? (
              "model id unavailable (health check)"
            ) : (
              <>
                <span className="num">{model.version}</span>
                {modelDetail(model) ? <span className="call-model-detail">{modelDetail(model)}</span> : null}
              </>
            )}
          </span>
        </p>
      </div>

      {call.orderChanged && call.alert !== null ? (
        <CallGauge
          gapS={call.alert.gapS}
          gapLabel={`gap at decision (lap ${call.alert.decisionLap})`}
          pitLossS={pitLoss?.s ?? null}
          pitLossText={pitLoss === null ? null : pitLossSourceText(pitLoss.source)}
          trend={null}
          trendLaps={null}
          g={g}
          muted
        />
      ) : (
        <PairGauge pair={call} context={context} pitLoss={pitLoss} g={g} muted={false} />
      )}

      <dl className="call-reasons">
        <div>
          <dt>Tyres</dt>
          <dd>
            <TyreText t={tyreOf(state.drivers[call.attackerId], ctx?.focus ?? null)} />
            <span className="call-vs">against</span>
            <TyreText t={tyreOf(state.drivers[call.defenderId], matches ? (ctx?.ahead ?? null) : null)} />
          </dd>
        </div>
        <div>
          <dt>Rule</dt>
          <dd>
            <span>
              {decision === null ? (
                <>gap at decision: not received (before you opened the page)</>
              ) : (
                <>
                  gap at decision (lap {decision.lap}) <span className="num">{decision.gapS.toFixed(1)} s</span>
                </>
              )}
            </span>
            {call.orderChanged && call.alert !== null ? (
              <OrderChanged call={call} code={(id) => entrants[id]?.code ?? driverCode(id)} />
            ) : (
              <span className="call-rule-checks">within {g} s, not teammates, nobody between, green lap</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="call-actions">
        <button type="button" className="btn btn-primary" onClick={() => onSimulate(call)}>
          Simulate this pair
        </button>
        <span className="call-hint">pit now, next lap or stay out, from this lap</span>
      </div>
    </div>
  );
}

/** "flagged at lap N against D; order changed since", with the car directly ahead now for screen readers (the visible
 * line keeps the length of the rule checks it replaces, so the call's fixed blocks never overflow). */
function OrderChanged({ call, code }: { call: CallPair; code: (id: string) => string }) {
  const t = orderChangedText(call, code);
  if (t === null) return null;
  return (
    <span className="call-rule-checks call-order-changed">
      {t.text}
      <span className="visually-hidden">{` (${t.aheadNow})`}</span>
    </span>
  );
}

/** No call while a replay streams: the reserved space holds the closest pair, muted, and why it is not a call. */
function NoCall({
  state,
  entrants,
  context,
  pitLoss,
  g,
  stale,
  onSimulate,
}: {
  state: RaceState;
  entrants: EntrantIndex;
  context: Engineer | null;
  pitLoss: RacePitLoss | null;
  g: number;
  stale: ReadonlySet<string>;
  onSimulate: (pair: CallPair) => void;
}) {
  const close = closestPair(state, entrants, stale);
  const staleFlags = staleFlaggedCount(state, stale);
  const code = (id: string) => entrants[id]?.code ?? driverCode(id);
  return (
    <div className="call-body call-empty">
      <p className="call-none">No undercut call</p>
      {close === null || close.gapS === null ? (
        <p className="call-explain">{noCallReason(state, entrants, g)}</p>
      ) : (
        <>
          <p className="call-closest">
            <span className="call-closest-k">Closest pair</span>
            <span className="call-closest-pair">
              <span className="code">{code(close.attackerId)}</span>
              <PairArrow size={12} />
              <span className="visually-hidden"> on </span>
              <span className="code">{code(close.defenderId)}</span>
            </span>
            <span className="call-closest-why">{closestReason(close, g)}</span>
          </p>
          <PairGauge pair={close} context={context} pitLoss={pitLoss} g={g} muted />
        </>
      )}
      {staleFlags > 0 ? (
        <p className="call-explain call-stale-flags">
          {staleFlags} {staleFlags === 1 ? "car" : "cars"} flagged, none qualifies: no timing from {staleFlags === 1 ? "it or the car ahead" : "them or the cars ahead"} for 2 or more laps
        </p>
      ) : null}
      {close !== null && close.gapS !== null ? (
        <div className="call-actions">
          <button type="button" className="btn" onClick={() => onSimulate(close)}>
            Simulate closest pair
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Where a replay starts: the status strip's inline transport, always visible right above the call (the call has no
 * start button of its own, so the page never offers two "Start replay" controls). */
const START_HINT = "Start one from the status strip above.";

/** One line while nothing streams (no replay, no lap yet): the feed moves up into the space. */
function Compact({
  state,
  entrants,
  replayIdle,
  g,
  stale,
}: {
  state: RaceState;
  entrants: EntrantIndex;
  replayIdle: boolean;
  g: number;
  stale: ReadonlySet<string>;
}) {
  if (state.order.length === 0) {
    return (
      <div className="call-body call-empty">
        <p className="call-line">
          <span className="call-none">{replayIdle ? "No replay of this race is running." : "Waiting for the first lap."}</span>
          {replayIdle ? <span className="call-line-text">{START_HINT}</span> : null}
        </p>
      </div>
    );
  }
  const close = closestPair(state, entrants, stale);
  const code = (id: string) => entrants[id]?.code ?? driverCode(id);
  return (
    <div className="call-body call-empty">
      <p className="call-line">
        <span className="call-none">No undercut call</span>
        {close !== null && close.gapS !== null ? (
          <span className="call-line-text">
            closest pair <span className="code">{code(close.attackerId)}</span> on <span className="code">{code(close.defenderId)}</span>:{" "}
            {closestReason(close, g)}
          </span>
        ) : (
          <span className="call-line-text">{noCallReason(state, entrants, g)}</span>
        )}
      </p>
    </div>
  );
}

/** An earlier run's state with nothing streaming (``storedLap``): one line, no pair and no probability, because
 * the stored flags were scored by that run's model, which this page cannot name. */
function Stored({ lap }: { lap: number }) {
  return (
    <div className="call-body call-empty">
      <p className="call-line">
        <span className="call-none">No replay of this race is running.</span>
        <span className="call-line-text">
          The tower shows the state an earlier run left (lap {lap}); its flags are not a live call.
        </span>
        <span className="call-line-text">{START_HINT}</span>
      </p>
    </div>
  );
}

/** After the finish: no pit instruction, no Simulate and no button (the strip's transport, right above the call,
 * offers Replay again and the post-race archive). */
function Ended({ lap }: { lap: number | null }) {
  return (
    <div className="call-body call-empty">
      <p className="call-line">
        <span className="call-none">Race ended{lap !== null ? ` at lap ${lap}` : ""}</span>
        <span className="call-line-text">The live call stops at the chequered flag.</span>
      </p>
    </div>
  );
}
