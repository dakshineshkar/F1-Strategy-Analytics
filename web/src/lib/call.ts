/** "The call": the live undercut pair the race view leads with, and the small pure helpers around it
 * (model identity, the gauge's geometry, alert wording, the replay mode, the previous-lap marker).
 * Display only: everything here reads the reducer's state and responses the page already receives;
 * nothing is written back, and nothing feeds the model, the rule, the live features or the what-if. */

import type { Health, Replay } from "./api";
import { type EntrantIndex, teammates } from "./entrants";
import { type AlertGroup, alertKey, type Connection, type DriverRow, type RaceState } from "./reducer";

/** The rule's gap threshold G (the deployed primary model, G = 3.5 s; the health check names the live one). */
export const RULE_GAP_S = 3.5;
/** The model's decision threshold (``ALERT_THRESHOLD`` in streaming/alerts.py). */
export const DECISION_THRESHOLD = 0.5;
/** Share of the 2025 labelled undercut attempts that succeeded (17 of 49; docs/model_results.md, the sealed
 * test set): the context a probability is read against. */
export const BASE_RATE_2025 = 0.347;
/** 2025 ECE (10 bins) of the what-if simulator and of the calibrated model, from results/whatif_consistency.csv. */
export const SIM_ECE_2025 = 0.207;
export const MODEL_ECE_2025 = 0.107;
/** Prefix of the sample deployment model (``SAMPLE_PREFIX``, src/f1sa/model/deploy.py), which is a smoke test. */
export const SMOKE_MODEL_PREFIX = "sample_";

// ------------------------------------------------------------------ model identity
export interface ModelIdentity {
  version: string;
  featureSet: string | null;
  g: number | null;
  k: number | null;
  /** The sample deployment model, trained on the two sample races: a smoke test, not a result. */
  smoke: boolean;
}

export const isSmokeModel = (version: string): boolean => version.startsWith(SMOKE_MODEL_PREFIX);

/** The scoring model from ``/api/health`` (null while unknown or when the API reports none). */
export function modelIdentity(health: Health | null): ModelIdentity | null {
  const m = health?.model ?? null;
  if (m === null) return null;
  return { version: m.model_version, featureSet: m.feature_set, g: m.g, k: m.k, smoke: isSmokeModel(m.model_version) };
}

/** "real features, G 3.5 s, k 2" (whatever of it is known). */
export function modelDetail(m: ModelIdentity): string {
  const parts: string[] = [];
  if (m.featureSet !== null) parts.push(`${m.featureSet} features`);
  if (m.g !== null) parts.push(`G ${m.g} s`);
  if (m.k !== null) parts.push(`k ${m.k}`);
  return parts.join(", ");
}

// ------------------------------------------------------------------ pairs
export interface CallPair {
  attackerId: string;
  /** The car directly ahead now (``order``), which is the car the flag was evaluated against unless the
   * order changed after the decision lap. */
  defenderId: string;
  prob: number | null;
  gapS: number | null;
  /** The attacker's latest lap. */
  lap: number | null;
  /** This page's alert group for the same pair, when one arrived since the page opened. */
  alert: AlertGroup | null;
}

function pairAt(state: RaceState, i: number): CallPair | null {
  const attackerId = state.order[i];
  const defenderId = state.order[i - 1];
  if (attackerId === undefined || defenderId === undefined) return null;
  const row = state.drivers[attackerId];
  if (row === undefined) return null;
  return {
    attackerId,
    defenderId,
    prob: row.undercutProb,
    gapS: row.gapAheadS,
    lap: row.lap,
    alert: state.alerts[alertKey(attackerId, defenderId)] ?? null,
  };
}

/** The pairs flagged now: every car whose driver hash carries ``undercut_flag``, against the car directly
 * ahead in the order. This comes from the snapshot and the lap frames, so it is right after a late join or
 * a reconnect too (the alert history is not in the snapshot; critique F09). Highest probability first,
 * then the newest alert, then the higher position. */
export function flaggedPairs(state: RaceState): CallPair[] {
  const out: CallPair[] = [];
  for (let i = 1; i < state.order.length; i += 1) {
    const id = state.order[i];
    if (id !== undefined && state.drivers[id]?.undercutFlag) {
      const p = pairAt(state, i);
      if (p !== null) out.push(p);
    }
  }
  return out
    .map((p, rank) => ({ p, rank }))
    .sort((a, b) => (b.p.prob ?? -1) - (a.p.prob ?? -1) || (b.p.alert?.seq ?? 0) - (a.p.alert?.seq ?? 0) || a.rank - b.rank)
    .map(({ p }) => p);
}

/** The call: the best flagged pair, or null. */
export const theCall = (state: RaceState): CallPair | null => flaggedPairs(state)[0] ?? null;

/** The closest pair that is not teammates and not in the pit lane (shown, muted, when nothing is flagged). */
export function closestPair(state: RaceState, entrants: EntrantIndex): CallPair | null {
  let best: CallPair | null = null;
  for (let i = 1; i < state.order.length; i += 1) {
    const p = pairAt(state, i);
    if (p === null || p.gapS === null) continue;
    const a = state.drivers[p.attackerId];
    const d = state.drivers[p.defenderId];
    if (a?.inPit || d?.inPit) continue;
    if (teammates(entrants, p.attackerId).some((m) => m.driver_id === p.defenderId)) continue;
    if (best === null || p.gapS < (best.gapS ?? Infinity)) best = p;
  }
  return best;
}

/** Why there is no call right now, in words. */
export function noCallReason(state: RaceState, entrants: EntrantIndex, g: number = RULE_GAP_S): string {
  if (state.order.length < 2) return "Waiting for the first lap of the race stream.";
  const lap = state.maxLap > 0 ? ` at lap ${state.maxLap}` : "";
  const close = closestPair(state, entrants);
  if (close === null || close.gapS === null) return `No car is an undercut candidate${lap}.`;
  if (close.gapS > g) return `No car is within ${g} s of a non-teammate ahead${lap}.`;
  return `The cars within ${g} s are not candidates${lap}: the rule skips teammates, pit laps and neutralised laps, and scores a pair only once per lap.`;
}

// ------------------------------------------------------------------ gauge
export interface Gauge {
  /** The scale's end in seconds: the pit loss, or the gap and G when they are larger. */
  maxS: number;
  /** 0–100 along the track */
  gapPct: number;
  gPct: number;
  pitLossPct: number | null;
  /** The gap is beyond the scale's end (drawn at the end with a "beyond" mark). */
  gapBeyond: boolean;
}

/** Geometry of the gap-against-pit-loss scale: 0 s on the left, the race's pit loss on the right. The rule
 * window (0 to G) is shaded and the current gap is the marker. Without a pit loss the scale ends at twice G. */
export function gaugeGeometry(gapS: number, pitLossS: number | null, g: number = RULE_GAP_S): Gauge {
  const end = pitLossS !== null && pitLossS > g ? pitLossS : g * 2;
  const maxS = end;
  const pct = (s: number) => Math.max(0, Math.min(100, (s / maxS) * 100));
  return {
    maxS,
    gapPct: pct(Math.max(0, gapS)),
    gPct: pct(g),
    pitLossPct: pitLossS === null ? null : pct(pitLossS),
    gapBeyond: gapS > maxS,
  };
}

export type TrendDirection = "closing" | "opening" | "steady";

/** The gap trend in words. ``trend`` is the least-squares slope of the gap (s/lap); a negative slope means the
 * attacker is closing. Below 0.05 s/lap either way it is "steady". */
export function trendOf(trend: number | null): { dir: TrendDirection; text: string } | null {
  if (trend === null || !Number.isFinite(trend)) return null;
  const v = Math.abs(trend).toFixed(2);
  if (Math.abs(trend) < 0.05) return { dir: "steady", text: `steady (${v} s/lap)` };
  return trend < 0 ? { dir: "closing", text: `closing ${v} s/lap` } : { dir: "opening", text: `opening ${v} s/lap` };
}

// ------------------------------------------------------------------ alerts
export type AlertKind = "attempt" | "opportunity" | "candidate";

/** What an alert is, in words that match its strength: an attempt (the attacker pitted), an opportunity (at
 * or above the model's 50% threshold), or a candidate (newly eligible, below the threshold). The wire's
 * ``reason=opportunity`` covers both of the last two; the probability decides the word (critique F13). */
export function alertKind(g: Pick<AlertGroup, "reason" | "prob" | "threshold">): { kind: AlertKind; label: string } {
  if (g.reason === "attempt") return { kind: "attempt", label: "Attempt" };
  if (g.prob >= g.threshold) return { kind: "opportunity", label: "Opportunity" };
  return { kind: "candidate", label: "Candidate" };
}

export const TRIGGER_TEXT: Record<AlertGroup["trigger"], string> = {
  new_candidate: "new candidate",
  probability_crossed: "crossed 50%",
  pit_in: "attacker pitted",
};

// ------------------------------------------------------------------ the previous-lap marker (F38)
/** The lap a car's gap was measured at when that lap is behind the leader's and the car is not simply
 * lapped (``lapsDown`` laps down and up to date): the car has not crossed the line on this lap yet, so its
 * gap and interval are a lap old. Null otherwise. */
export function previousLapOf(row: Pick<DriverRow, "lap">, leaderLap: number | null, lapsDown: number): number | null {
  if (row.lap === null || leaderLap === null) return null;
  return leaderLap - row.lap > lapsDown ? row.lap : null;
}

// ------------------------------------------------------------------ the status strip's mode
export type ModeTone = "live" | "replay" | "paused" | "ended" | "idle";

export interface Mode {
  label: string;
  tone: ModeTone;
  /** Sentence for screen readers and the tooltip. */
  description: string;
}

/** The replay state the strip shows: REPLAY n× / PAUSED / STOPPED / FINISHED / FAILED from ``/api/replays``
 * (polled), else the stream's own state. A stop sends no ``session_end``, so the stream alone would still
 * say "Live" (inventory: paused and stopped states). */
export function modeOf(current: Replay | null, sessionEnded: boolean, connection: Connection): Mode {
  if (current !== null) {
    const speed = `${current.speed}×`;
    switch (current.state) {
      case "starting":
        return { label: `REPLAY ${speed}`, tone: "replay", description: `Replay starting at ${speed}.` };
      case "running":
        return { label: `REPLAY ${speed}`, tone: "replay", description: `Replay running at ${speed} real time.` };
      case "paused":
        return { label: "PAUSED", tone: "paused", description: `Replay paused${current.lap === null ? "" : ` at lap ${current.lap}`}.` };
      case "stopped":
        return { label: "STOPPED", tone: "ended", description: `Replay stopped${current.lap === null ? "" : ` at lap ${current.lap}`}.` };
      case "failed":
        return { label: "FAILED", tone: "ended", description: "The replay failed; see the replay control." };
      case "finished":
        return { label: "FINISHED", tone: "ended", description: "The replay finished: the session ended." };
    }
  }
  if (sessionEnded) return { label: "FINISHED", tone: "ended", description: "The session ended." };
  if (connection === "connected") return { label: "LIVE", tone: "live", description: "Connected to the race stream." };
  return { label: "NO REPLAY", tone: "idle", description: "No replay of this race is running." };
}
