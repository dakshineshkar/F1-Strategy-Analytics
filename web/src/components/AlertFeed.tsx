"use client";

import { useRef, useState } from "react";

import { alertCountText, alertIsNew, alertKind, type CallPair, dividersWithin, feedItems, HISTORY_TEXT, TRIGGER_TEXT } from "@/lib/call";
import type { EntrantIndex } from "@/lib/entrants";
import { driverCode, driverName, probability } from "@/lib/format";
import { tipId } from "@/lib/legend";
import type { AlertGroup, Announcement, DriverRow } from "@/lib/reducer";
import { fitRows, rowsBelow, useRowBox } from "@/lib/useFitRows";
import { useFlip } from "@/lib/useFlip";

import { GlossaryKey } from "./GlossaryKey";
import { PairArrow } from "./Marks";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

const pct = (p: number) => Math.max(0, Math.min(100, Math.round(p * 100)));
/** A row's fixed height on desktop (``--row`` on ``.feed`` in globals.css, read at run time) and the "N more"
 * footer, in px at the default root size. */
const ROW_PX = 68;
const FOOTER_PX = 32;
/** The history divider's height (``.alert-divider``, 1.5rem). */
const DIVIDER_PX = 24;

function Tyre({ row }: { row: DriverRow | undefined }) {
  if (row === undefined) return null;
  const age = row.tyreLifeLaps ?? row.tyreAgeLaps;
  return (
    <span className="alert-tyre">
      <TyreGlyph compound={row.compound} size={12} />
      <span className="visually-hidden">{COMPOUND_LABEL[row.compound]} </span>
      <span aria-hidden="true">{COMPOUND_LABEL[row.compound].charAt(0)}</span>
      <span className="num">{age === null ? "—" : age}</span>
      <span className="visually-hidden"> laps</span>
    </span>
  );
}

/** The undercut alerts, newest first (critique F02, F13, F22, F25, F26). Each row: the type as a word
 * (Attempt, Opportunity at or above 50%, Candidate below it), the strength as the percentage and a short
 * bar, the pair with both cars' current tyres, the decision lap, gap, trigger and count; a row's
 * "Simulate" opens the what-if with that pair. The list sits in reserved, scrollable space; rows that move
 * when a newer alert arrives slide there (FLIP, transform only), so nothing jumps.
 *
 * A page opened mid-race gets the run's earlier alerts with its connect snapshot (F09): they sit below a quiet
 * divider, "Received before you opened the page" (after a reconnect, "Received while reconnecting"), are never
 * new and never announced. Without any history (a run the API did not start, or a restarted API) it says since
 * when it has listened, and lists the pairs flagged now from the race state.
 * The polite live region speaks only the reducer's announcements (attempts and threshold crossings). */
export function AlertFeed({
  groups,
  announcement,
  rows = {},
  entrants = {},
  flaggedNow = [],
  sinceLap = null,
  maxLap = 0,
  ended = false,
  onSimulate,
}: {
  /** the leader's lap: alerts from it or the lap before are marked new (the only ones in the signal colour) */
  maxLap?: number;
  /** the race has finished: no alert is new, so the feed holds no signal colour */
  ended?: boolean;
  groups: AlertGroup[];
  announcement: Announcement | null;
  /** current per-car state, for both cars' tyres */
  rows?: Record<string, DriverRow>;
  entrants?: EntrantIndex;
  /** the pairs flagged now (``flaggedPairs``), shown when there is no alert history */
  flaggedNow?: CallPair[];
  /** the leader lap when this page started listening (null when it listened from the start or in the archive) */
  sinceLap?: number | null;
  /** live only: open the what-if with this pair */
  onSimulate?: (attackerId: string, defenderId: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const now = useRef<HTMLUListElement>(null);
  // a short list in its own scroll box: every move slides, however far (an updated pair rises to the top)
  const items = feedItems(groups);
  useFlip(list, items.map((it) => (it.kind === "alert" ? `${it.group.key}:${it.group.seq}` : it.key)).join(","), Infinity);
  useFlip(now, flaggedNow.map((p) => `${p.attackerId}>${p.defenderId}`).join(","), Infinity);
  const code = (id: string) => entrants[id]?.code ?? driverCode(id);
  const name = (id: string) => entrants[id]?.family_name ?? driverName(id);
  // whole rows only: the list is as tall as the rows that fit, and a footer says how many are below
  const { ref: box, height, rowPx } = useRowBox<HTMLDivElement>(ROW_PX);
  // the dividers above the last whole row take their height from the box first
  const first = height > 0 ? fitRows(height, rowPx, groups.length, FOOTER_PX) : groups.length;
  const visible = height > 0 ? fitRows(height - dividersWithin(items, first) * DIVIDER_PX, rowPx, groups.length, FOOTER_PX) : groups.length;
  const listPx = visible * rowPx + dividersWithin(items, visible) * DIVIDER_PX;
  const [scrollPx, setScrollPx] = useState(0);
  const below = rowsBelow(groups.length, visible, scrollPx, rowPx);
  const overflowing = groups.length > visible;

  return (
    <section className="panel alert-panel" aria-labelledby="alerts-h">
      <div className="panel-head">
        <h2 id="alerts-h">Undercut alerts</h2>
        <span className="panel-count num" aria-label={`${groups.length} alert pairs`}>
          {groups.length}
        </span>
        <GlossaryKey ids={["attempt", "opportunity", "candidate", "alertProb"]} label="the alert types" />
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement?.text ?? ""}
      </div>
      <div className="feed" role="region" aria-label="Undercut alert list" tabIndex={0} ref={box}>
        {groups.length === 0 ? (
          <div className="feed-empty">
            <p className="muted">
              {sinceLap !== null && sinceLap > 1
                ? `No alerts since you opened this page (lap ${sinceLap}).`
                : "No undercut alerts yet."}
            </p>
            {flaggedNow.length > 0 ? (
              <>
                <p className="feed-now-h">Flagged now, from the current race state</p>
                <ul className="feed-now" ref={now}>
                  {flaggedNow.map((p) => (
                    <li key={`${p.attackerId}>${p.defenderId}`} data-flip={`${p.attackerId}>${p.defenderId}`}>
                      <span className="code">{code(p.attackerId)}</span>
                      <PairArrow size={12} />
                      <span className="visually-hidden"> on </span>
                      <span className="code">{code(p.defenderId)}</span>
                      <span className="num">{probability(p.prob)}</span>
                    </li>
                  ))}
                </ul>
                <p className="feed-note">The defender is the car directly ahead now; the alert that flagged it arrived before you joined.</p>
              </>
            ) : null}
          </div>
        ) : (
          <>
            <ol
              className="alerts"
              ref={list}
              style={height > 0 ? { height: `${listPx}px` } : undefined}
              onScroll={(e) => setScrollPx(e.currentTarget.scrollTop)}
            >
              {items.map((it) => {
                if (it.kind === "divider") {
                  return (
                    <li key={it.key} data-flip={it.key} className={`alert-divider alert-divider-${it.history}`}>
                      {it.text}
                    </li>
                  );
                }
                const g = it.group;
                const k = alertKind(g);
                const fresh = alertIsNew(g, maxLap, ended);
                return (
                  <li
                    key={g.key}
                    data-flip={g.key}
                    className={`alert alert-${k.kind}${fresh ? " is-new" : ""}${g.history ? " is-history" : ""}`}
                  >
                    <p className="alert-line">
                      <span className={`alert-type type-${k.kind}`} aria-describedby={tipId(k.kind)}>
                        {k.label}
                      </span>
                      {/* a fixed slot, so the pair never moves when an alert stops being new */}
                      <span className="alert-new">{fresh ? "new" : ""}</span>
                      <span className="alert-pair">
                        <span className="code">{code(g.attackerId)}</span>
                        <PairArrow size={12} />
                        <span className="visually-hidden"> attacking </span>
                        <span className="code">{code(g.defenderId)}</span>
                      </span>
                      <span className="alert-strength">
                        <span className="alert-prob num" aria-describedby={tipId("alertProb")}>
                          {probability(g.prob)}
                          <span className="visually-hidden"> success probability</span>
                        </span>
                        <span className="alert-bar" aria-hidden="true">
                          <span className="alert-bar-fill" style={{ transform: `scaleX(${pct(g.prob) / 100})` }} />
                          <span className="alert-bar-mark" />
                        </span>
                      </span>
                    </p>
                    <p className="alert-meta">
                      <span className="kv">
                        <span className="k">lap</span> <span className="num">{g.decisionLap}</span>
                      </span>
                      <span className="kv">
                        <span className="k">gap</span> <span className="num">{g.gapS.toFixed(1)} s</span>
                      </span>
                      <span className="kv alert-tyres">
                        <Tyre row={rows[g.attackerId]} />
                        <span className="k">vs</span>
                        <Tyre row={rows[g.defenderId]} />
                      </span>
                      <span className="kv alert-trigger">{TRIGGER_TEXT[g.trigger]}</span>
                      {g.count > 1 ? (
                        <span className="kv alert-count" title={alertCountText(g.count)}>
                          <span className="num" aria-hidden="true">
                            {g.count}×
                          </span>
                          <span className="visually-hidden">{`, ${alertCountText(g.count)}`}</span>
                        </span>
                      ) : null}
                      <span className="visually-hidden">
                        {`. ${name(g.attackerId)} on ${name(g.defenderId)}`}
                        {g.history ? `, ${HISTORY_TEXT[g.history].toLowerCase()}` : ""}
                      </span>
                    </p>
                    {onSimulate !== undefined ? (
                      <button
                        type="button"
                        className="btn btn-quiet btn-small alert-sim"
                        onClick={() => onSimulate(g.attackerId, g.defenderId)}
                        aria-label={`Simulate ${code(g.attackerId)} on ${code(g.defenderId)}`}
                      >
                        Simulate
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {overflowing ? (
              <p className="feed-more">
                {below > 0 ? (
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    onClick={() => list.current?.scrollBy({ top: visible * rowPx })}
                  >
                    {below} more below
                  </button>
                ) : (
                  <span className="muted">end of the list</span>
                )}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
