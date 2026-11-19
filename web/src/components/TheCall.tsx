"use client";

import type { Compound } from "@/lib/api";
import {
  BASE_RATE_2025,
  type CallPair,
  closestPair,
  flaggedPairs,
  type ModelIdentity,
  modelDetail,
  noCallReason,
  RULE_GAP_S,
} from "@/lib/call";
import type { Engineer, EngineerCar } from "@/lib/engineer";
import { type EntrantIndex } from "@/lib/entrants";
import { driverCode, driverName, probability } from "@/lib/format";
import { tipId } from "@/lib/legend";
import type { DriverRow, RaceState } from "@/lib/reducer";
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

/** The live undercut call (critique F03): the best pair flagged now, with the calibrated probability as a
 * model estimate with its model id and the 2025 base rate, the gap-against-pit-loss gauge, the reasons
 * (tyres, trend, pit loss), the rule checks it passed, and "Simulate this pair". With no flagged pair it
 * says why and shows the closest pair, muted. The only panel in the signal colour. */
export function TheCall({
  state,
  entrants,
  model,
  context,
  onSimulate,
  replayIdle,
  onOpenReplay,
}: {
  state: RaceState;
  entrants: EntrantIndex;
  model: ModelIdentity | null;
  /** the engineer view of the call's attacker (trend, tyres, pit loss); null while loading or unavailable */
  context: Engineer | null;
  onSimulate: (pair: CallPair) => void;
  /** no replay is running and the tower is empty: the call explains how to start one */
  replayIdle: boolean;
  onOpenReplay: () => void;
}) {
  const pairs = flaggedPairs(state);
  const call = pairs[0] ?? null;
  const ctx = call !== null && context !== null && context.focus_id === call.attackerId ? context : null;
  const pairMatches = ctx?.pair_ahead !== null && ctx?.pair_ahead?.front_id === call?.defenderId;
  const lap = state.maxLap > 0 ? state.maxLap : null;

  return (
    <section id="the-call" className={`panel call${call !== null ? " has-call" : ""}`} aria-labelledby="call-h" tabIndex={-1}>
      <div className="call-head">
        <h2 id="call-h">
          The call <InfoTip id="call" />
        </h2>
        <span className="call-meta">
          {lap !== null ? <span className="num">Lap {lap}</span> : null}
          {pairs.length > 1 ? <span>{pairs.length - 1} more flagged</span> : null}
          {model?.smoke ? <span className="stamp stamp-smoke">SMOKE TEST</span> : null}
        </span>
      </div>

      {call === null ? (
        <NoCall state={state} entrants={entrants} replayIdle={replayIdle} onOpenReplay={onOpenReplay} />
      ) : (
        <div className="call-body">
          <p className="call-pair">
            <Car id={call.attackerId} entrants={entrants} role="attacker" />
            <span className="call-arrow">
              <PairArrow size={16} />
              <span className="visually-hidden">undercutting</span>
            </span>
            <Car id={call.defenderId} entrants={entrants} role="defender, the car directly ahead" />
          </p>

          <div className="call-estimate">
            <p className="call-prob" aria-describedby={tipId("undercut")}>
              <span className="call-prob-num num">{probability(call.prob)}</span>
              <span className="call-prob-label">
                model estimate that pitting next lap brings {driverCode(call.attackerId)} out ahead
              </span>
            </p>
            <p className="call-context">
              <span>
                2025 base rate <span className="num">{probability(BASE_RATE_2025)}</span> of attempts
              </span>
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

          <CallGauge
            gapS={call.gapS ?? ctx?.pair_ahead?.gap_s ?? 0}
            pitLossS={ctx?.rejoin.pit_loss_s ?? null}
            pitLossText={ctx === null ? null : pitLossSourceText(ctx.rejoin.pit_loss_source)}
            trend={pairMatches ? (ctx?.pair_ahead?.trend_s_per_lap ?? null) : null}
            trendLaps={pairMatches ? (ctx?.pair_ahead?.trend_laps ?? null) : null}
            g={model?.g ?? RULE_GAP_S}
          />

          <dl className="call-reasons">
            <div>
              <dt>Tyres</dt>
              <dd>
                <TyreText t={tyreOf(state.drivers[call.attackerId], ctx?.focus ?? null)} />
                <span className="call-vs">against</span>
                <TyreText t={tyreOf(state.drivers[call.defenderId], pairMatches ? (ctx?.ahead ?? null) : null)} />
              </dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd>
                passed at lap {call.lap ?? "—"}: within {model?.g ?? RULE_GAP_S} s, not teammates, nobody between, green lap
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
      )}
    </section>
  );
}

function NoCall({
  state,
  entrants,
  replayIdle,
  onOpenReplay,
}: {
  state: RaceState;
  entrants: EntrantIndex;
  replayIdle: boolean;
  onOpenReplay: () => void;
}) {
  if (replayIdle && state.order.length === 0) {
    return (
      <div className="call-body call-empty">
        <p className="call-none">No replay of this race is running.</p>
        <p className="call-explain">
          Start one from the replay controls: the tower fills lap by lap, and the call names the pair the model and the
          rule flag.
        </p>
        <button type="button" className="btn btn-primary" onClick={onOpenReplay}>
          Open replay controls
        </button>
      </div>
    );
  }
  const close = closestPair(state, entrants);
  return (
    <div className="call-body call-empty">
      <p className="call-none">No undercut call</p>
      <p className="call-explain">{noCallReason(state, entrants)}</p>
      {close !== null && close.gapS !== null ? (
        <p className="call-closest">
          Closest pair: <span className="code">{entrants[close.attackerId]?.code ?? driverCode(close.attackerId)}</span>{" "}
          on <span className="code">{entrants[close.defenderId]?.code ?? driverCode(close.defenderId)}</span>,{" "}
          <span className="num">{close.gapS.toFixed(1)} s</span>
        </p>
      ) : null}
    </div>
  );
}
