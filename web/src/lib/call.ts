/** "The call": the live undercut pair the race view leads with, and the small pure helpers around it
 * (model identity, the gauge's geometry, alert wording, the replay mode, the previous-lap marker).
 * Display only: everything here reads the reducer's state and responses the page already receives;
 * nothing is written back, and nothing feeds the model, the rule, the live features or the what-if. */

import type { Health, Replay } from "./api";
import { type EntrantIndex, teammates } from "./entrants";
import { type AlertGroup, type AlertHistory, alertKey, type Connection, type DriverRow, type RaceState } from "./reducer";
import { leaderLap, staleIds } from "./stale";

/** The rule's gap threshold G (the deployed primary model, G = 3.5 s; the health check names the live one). */
export const RULE_GAP_S = 3.5;
/** The model's decision threshold (``ALERT_THRESHOLD`` in streaming/alerts.py). */
export const DECISION_THRESHOLD = 0.5;
/** 2025 ECE (10 bins) of the what-if simulator and of the calibrated model, from results/whatif_consistency.csv. */
export const SIM_ECE_2025 = 0.207;
export const MODEL_ECE_2025 = 0.107;
/** Prefix of the sample deployment model (``SAMPLE_PREFIX``, src/f1sa/model/deploy.py), which is a smoke test.
 * Only a fallback since F10: the API's ``checks.model.smoke_test`` decides when it is present. */
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

/** The scoring model from ``/api/health`` (null while unknown or when the API reports none). The SMOKE TEST
 * stamp follows the API's ``smoke_test`` (F10); an older API without the field falls back to the name prefix. */
export function modelIdentity(health: Health | null): ModelIdentity | null {
  const m = health?.model ?? null;
  if (m === null) return null;
  const smoke = m.smoke_test ?? isSmokeModel(m.model_version);
  return { version: m.model_version, featureSet: m.feature_set, g: m.g, k: m.k, smoke };
}

/** No-break space: a value never wraps away from its label ("k" and "2" stay on one line). */
const NBSP = "\u00a0";

/** "real features, G 3.5 s, k 2" (whatever of it is known). Each part is joined inside by no-break spaces, so
 * a line breaks only between parts, never inside "k 2" or "G 3.5 s". */
export function modelDetail(m: ModelIdentity): string {
  const parts: string[] = [];
  if (m.featureSet !== null) parts.push(`${m.featureSet}${NBSP}features`);
  if (m.g !== null) parts.push(`G${NBSP}${m.g}${NBSP}s`);
  if (m.k !== null) parts.push(`k${NBSP}${m.k}`);
  return parts.join(", ");
}

// ------------------------------------------------------------------ pairs
export interface CallPair {
  attackerId: string;
  /** The car the flag was evaluated against: the defender of the attacker's latest alert on this page, else
   * the car directly ahead now (``order``). Never relabelled to a different car after the order changes. */
  defenderId: string;
  /** The car directly ahead of the attacker now (``order``). */
  aheadNowId: string;
  /** The attacker's latest alert names a defender that is no longer directly ahead: the call says "flagged at
   * lap N against D; order changed since", mutes its gauge and does not present the rule checks as passing. */
  orderChanged: boolean;
  /** The probability of this pair: the alert's when the order changed (the hash's value is the attacker's latest
   * decision, which may be against another car), else the driver hash's. */
  prob: number | null;
  /** The gap to the car directly ahead now (null when the order changed: there is no "gap now" to the defender). */
  gapS: number | null;
  /** The attacker's latest lap. */
  lap: number | null;
  /** This page's alert group for the pair (live or from the connect snapshot's history), when it holds one. */
  alert: AlertGroup | null;
}

/** The attacker's newest alert group on this page (any defender), or null. */
export function latestAlertOf(state: Pick<RaceState, "alerts">, attackerId: string): AlertGroup | null {
  let best: AlertGroup | null = null;
  for (const g of Object.values(state.alerts)) {
    if (g.attackerId === attackerId && (best === null || g.seq > best.seq)) best = g;
  }
  return best;
}

/** The pair of the car at ``order[i]`` and the car directly ahead. With ``fromAlert`` (flagged pairs), the
 * defender is the one the attacker's latest alert names: when that car is no longer directly ahead the pair keeps
 * it and is marked ``orderChanged`` (the hash's flag and probability belong to that decision, not to whichever car
 * the order puts ahead now). */
function pairAt(state: RaceState, i: number, fromAlert = false): CallPair | null {
  const attackerId = state.order[i];
  const aheadNowId = state.order[i - 1];
  if (attackerId === undefined || aheadNowId === undefined) return null;
  const row = state.drivers[attackerId];
  if (row === undefined) return null;
  const latest = fromAlert ? latestAlertOf(state, attackerId) : null;
  if (latest !== null && latest.defenderId !== aheadNowId) {
    return {
      attackerId,
      defenderId: latest.defenderId,
      aheadNowId,
      orderChanged: true,
      prob: latest.prob,
      gapS: null,
      lap: row.lap,
      alert: latest,
    };
  }
  return {
    attackerId,
    defenderId: aheadNowId,
    aheadNowId,
    orderChanged: false,
    prob: row.undercutProb,
    gapS: row.gapAheadS,
    lap: row.lap,
    alert: state.alerts[alertKey(attackerId, aheadNowId)] ?? null,
  };
}

/** The call's rule line when the order changed since the attacker's latest alert: the visible text ("flagged at lap 16
 * against SAI; order changed since") and the car directly ahead now, for screen readers ("LEC is directly ahead
 * now"). Null when the order did not change. */
export function orderChangedText(
  call: Pick<CallPair, "orderChanged" | "alert" | "defenderId" | "aheadNowId">,
  code: (id: string) => string,
): { text: string; aheadNow: string } | null {
  if (!call.orderChanged || call.alert === null) return null;
  return {
    text: `flagged at lap ${call.alert.decisionLap} against ${code(call.defenderId)}; order changed since`,
    aheadNow: `${code(call.aheadNowId)} is directly ahead now`,
  };
}

/** The pairs flagged now: every car whose driver hash carries ``undercut_flag``, against the car directly
 * ahead in the order. This comes from the snapshot and the lap frames, so it is right after a late join or
 * a reconnect too (the alert history is not in the snapshot; critique F09). A pair with a stale car (no
 * timing for 2 or more leader laps: ``stale.ts``) is left out: its flag is the last decision's, kept in the
 * hash after the car stopped. Highest probability first, then the newest alert, then the higher position. */
export function flaggedPairs(state: RaceState, stale: ReadonlySet<string> = staleIds(state)): CallPair[] {
  const out: CallPair[] = [];
  for (let i = 1; i < state.order.length; i += 1) {
    const id = state.order[i];
    if (id !== undefined && state.drivers[id]?.undercutFlag) {
      const p = pairAt(state, i, true);
      if (p !== null && !stale.has(p.attackerId) && !stale.has(p.defenderId)) out.push(p);
    }
  }
  return out
    .map((p, rank) => ({ p, rank }))
    .sort((a, b) => (b.p.prob ?? -1) - (a.p.prob ?? -1) || (b.p.alert?.seq ?? 0) - (a.p.alert?.seq ?? 0) || a.rank - b.rank)
    .map(({ p }) => p);
}

/** The call: the best flagged pair, or null. */
export const theCall = (state: RaceState): CallPair | null => flaggedPairs(state)[0] ?? null;

/** Cars whose hash still carries ``undercut_flag`` but that cannot be a call: they or the car ahead are
 * stale ("2 cars flagged, none qualifies"). */
export function staleFlaggedCount(state: RaceState, stale: ReadonlySet<string> = staleIds(state)): number {
  let n = 0;
  for (let i = 1; i < state.order.length; i += 1) {
    const id = state.order[i];
    const ahead = state.order[i - 1];
    if (id !== undefined && ahead !== undefined && state.drivers[id]?.undercutFlag && (stale.has(id) || stale.has(ahead))) n += 1;
  }
  return n;
}

/** The closest pair that is not teammates, not in the pit lane and has no stale car (shown, muted, when
 * nothing is flagged). */
export function closestPair(state: RaceState, entrants: EntrantIndex, stale: ReadonlySet<string> = staleIds(state)): CallPair | null {
  let best: CallPair | null = null;
  for (let i = 1; i < state.order.length; i += 1) {
    const p = pairAt(state, i);
    if (p === null || p.gapS === null) continue;
    if (stale.has(p.attackerId) || stale.has(p.defenderId)) continue;
    const a = state.drivers[p.attackerId];
    const d = state.drivers[p.defenderId];
    if (a?.inPit || d?.inPit) continue;
    if (teammates(entrants, p.attackerId).some((m) => m.driver_id === p.defenderId)) continue;
    if (best === null || p.gapS < (best.gapS ?? Infinity)) best = p;
  }
  return best;
}

/** The main reason the closest pair is not a call, in words. */
export function closestReason(pair: Pick<CallPair, "gapS">, g: number = RULE_GAP_S): string {
  if (pair.gapS === null) return "gap unknown";
  const gap = `${pair.gapS.toFixed(1)} s`;
  if (pair.gapS > g) return `gap ${gap}, outside the ${g} s rule window`;
  return `gap ${gap} now, but not flagged at the last decision (a pit lap, a neutralised lap, or the gap was above ${g} s then)`;
}

/** Why there is no call right now, in words. */
export function noCallReason(state: RaceState, entrants: EntrantIndex, g: number = RULE_GAP_S): string {
  if (state.order.length < 2) return "Waiting for the first lap of the race stream.";
  const now = leaderLap(state);
  const lap = now > 0 ? ` at lap ${now}` : "";
  const close = closestPair(state, entrants);
  if (close === null || close.gapS === null) return `No car is an undercut candidate${lap}.`;
  if (close.gapS > g) return `No car is within ${g} s of a non-teammate ahead${lap}.`;
  return `The cars within ${g} s are not candidates${lap}: the rule skips teammates, pit laps and neutralised laps, and scores a pair only once per lap.`;
}

// ------------------------------------------------------------------ gauge
/** The gauge's axis never ends before this many seconds, so a small gap is not drawn at the far right. */
export const GAUGE_MIN_S = 5;

export interface Gauge {
  /** The axis end in seconds: ``max(5 s, gap × 1.5)``, so the gap sits at two thirds of the axis or less. */
  maxS: number;
  /** 0–100 along the track */
  gapPct: number;
  /** The rule window's end (the rule's gap threshold, 3.5 s for the deployed model). */
  windowPct: number;
  /** Where the gap will be next lap if the trend holds (gap + trend, never below 0), or null without a trend. */
  nextS: number | null;
  nextPct: number | null;
  /** The next-lap gap is beyond the axis end (the arrow stops at the end, marked). */
  nextBeyond: boolean;
}

/** Geometry of the gap gauge: 0 s on the left, ``max(5 s, gap × 1.5)`` on the right, the rule window (0 to
 * the rule's gap threshold) shaded, the gap now as the marker and the trend as an arrow to next lap's gap.
 * The pit loss is not on this axis (it is a different quantity; the call states it in text). */
export function gaugeGeometry(gapS: number, trendSPerLap: number | null = null, g: number = RULE_GAP_S): Gauge {
  const gap = Math.max(0, gapS);
  const maxS = Math.max(GAUGE_MIN_S, gap * 1.5, g);
  const pct = (s: number) => Math.max(0, Math.min(100, (s / maxS) * 100));
  const nextS = trendSPerLap === null || !Number.isFinite(trendSPerLap) ? null : Math.max(0, gap + trendSPerLap);
  return {
    maxS,
    gapPct: pct(gap),
    windowPct: pct(g),
    nextS,
    nextPct: nextS === null ? null : pct(nextS),
    nextBeyond: nextS !== null && nextS > maxS,
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

/** An alert from the leader's lap or the one before (it arrived within the last lap): the only alerts the feed
 * marks in the signal colour. After the finish (``ended``) nothing is live, so no alert is new; nor is an
 * alert from the connect snapshot's history (F09: it arrived before the page opened). */
export const alertIsNew = (g: Pick<AlertGroup, "decisionLap" | "history">, maxLap: number, ended = false): boolean =>
  !ended && (g.history ?? null) === null && maxLap > 0 && g.decisionLap >= maxLap - 1;

/** F09: the quiet label above alerts that came with a connect snapshot's history, not live. */
export const HISTORY_TEXT: Record<AlertHistory, string> = {
  before_open: "Received before you opened the page",
  while_away: "Received while reconnecting",
};

export type FeedItem =
  | { kind: "alert"; group: AlertGroup }
  | { kind: "divider"; key: string; history: AlertHistory; text: string };

/** The feed's rows in display order (``groups`` newest first): a divider before each run of history alerts of
 * one kind. History alerts are older than every live one after the first connect, so normally there is one
 * divider, above the bottom block; a reconnect's missed alerts get their own. */
export function feedItems(groups: readonly AlertGroup[]): FeedItem[] {
  const out: FeedItem[] = [];
  let prev: AlertHistory | null = null;
  for (const g of groups) {
    const h = g.history ?? null;
    if (h !== null && h !== prev) out.push({ kind: "divider", key: `history:${h}:${g.key}`, history: h, text: HISTORY_TEXT[h] });
    out.push({ kind: "alert", group: g });
    prev = h;
  }
  return out;
}

/** Dividers before the ``n``-th alert row of ``items`` (the ones inside a window of ``n`` alert rows). */
export function dividersWithin(items: readonly FeedItem[], n: number): number {
  let alerts = 0;
  let dividers = 0;
  for (const it of items) {
    if (it.kind === "alert") {
      alerts += 1;
      if (alerts >= n) break;
    } else {
      dividers += 1;
    }
  }
  return dividers;
}

/** The accessible text of an alert pair's counter ("4×"). */
export const alertCountText = (count: number): string => `${count} ${count === 1 ? "alert" : "alerts"} for this pair`;

// ------------------------------------------------------------------ the call's states
/** The gap the rule saw when it flagged the pair: the decision lap and gap of this page's alert for the pair, live
 * or from the connect snapshot's history (F09). Null when this page holds no alert for the pair (none in the
 * history either: a run the API did not record, or older than the history it sends). */
export function decisionGap(call: Pick<CallPair, "alert">): { lap: number; gapS: number } | null {
  return call.alert === null ? null : { lap: call.alert.decisionLap, gapS: call.alert.gapS };
}

/** The race is over: the replay finished, ``session_end`` arrived, or the leader has completed the race's
 * last lap (nobody pits after the chequered flag). A replay stopped mid-race is not "ended". */
export function raceEnded(current: Pick<Replay, "state"> | null, sessionEnded: boolean, leaderLap: number | null, laps: number | null): boolean {
  if (sessionEnded || current?.state === "finished") return true;
  return leaderLap !== null && laps !== null && laps > 0 && leaderLap >= laps;
}

export type CallLayout = "full" | "compact";

/** The call keeps its full reserved height while a replay streams, so a call appearing or disappearing never
 * moves the alert feed: with no call it fills that height with the closest pair. It shrinks to one line only
 * when nothing streams (no active replay, or no lap yet) and there is no call, and always once the race has
 * ended (the call stops at the chequered flag). */
export function callLayout(hasCall: boolean, streaming: boolean, maxLap: number, ended: boolean): CallLayout {
  if (ended) return "compact";
  if (hasCall) return "full";
  return !streaming || maxLap < 1 ? "compact" : "full";
}

// ------------------------------------------------------------------ the previous-lap marker (F38)
/** The lap a car's gap was measured at when that lap is behind the leader's and the car is not simply
 * lapped (``lapsDown`` laps down and up to date): the car has not crossed the line on this lap yet, so its
 * gap and interval are a lap old. Null otherwise. */
export function previousLapOf(row: Pick<DriverRow, "lap">, leaderLap: number | null, lapsDown: number): number | null {
  if (row.lap === null || leaderLap === null) return null;
  return leaderLap - row.lap > lapsDown ? row.lap : null;
}

// ------------------------------------------------------------------ the status strip's mode
export type ModeTone = "live" | "replay" | "paused" | "ended" | "idle" | "stored";

export interface Mode {
  label: string;
  tone: ModeTone;
  /** Sentence for screen readers and the tooltip. */
  description: string;
}

/** The page holds a race state that nothing is streaming: ``/api/replays`` has been read and lists no run of this
 * race (running or recent: after an API restart the list is empty), no ``session_end`` arrived, the race store
 * still has cars, and no lap frame has reached this page since it connected. That state is what an earlier run
 * left in Redis (its keys keep their TTL), scored by whichever model ran then, so it is never shown as live and
 * its flags are never a call. A replay run outside the API still sends lap frames, so it reads as live. Returns the
 * stored leader lap, or null when the state is not a stored one. */
export function storedLap(
  replaysKnown: boolean,
  current: Replay | null,
  state: RaceState,
): number | null {
  if (!replaysKnown || current !== null || state.sessionEnded || state.order.length === 0) return null;
  if (Object.keys(state.history).length > 0) return null;
  return leaderLap(state) || null;
}

/** The replay state the strip shows: REPLAY n× / PAUSED / STOPPED / FINISHED / FAILED from ``/api/replays``
 * (polled), else the stream's own state. A stop sends no ``session_end``, so the stream alone would still
 * say "Live" (inventory: paused and stopped states). With ``stored`` (``storedLap``), nothing streams: the page
 * shows an earlier run's state, never "LIVE". */
export function modeOf(current: Replay | null, sessionEnded: boolean, connection: Connection, stored: number | null = null): Mode {
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
  if (stored !== null) {
    return {
      label: "NOT REPLAYING",
      tone: "stored",
      description: `No replay of this race is running: the page shows the state an earlier run left (lap ${stored}), not a live stream.`,
    };
  }
  if (connection === "connected") return { label: "LIVE", tone: "live", description: "Connected to the race stream." };
  return { label: "NO REPLAY", tone: "idle", description: "No replay of this race is running." };
}
