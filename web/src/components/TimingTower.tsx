"use client";

import { useEffect, useRef, useState } from "react";

import { type EntrantIndex, teamHighlight, teammates, teamTitle } from "@/lib/entrants";
import { driverCode, driverName, gap, lapTime, probability } from "@/lib/format";
import { glossary, tipId } from "@/lib/legend";
import type { DriverRow } from "@/lib/reducer";
import {
  type BestSoFar,
  bestSoFar,
  type ColumnId,
  DEFAULT_COLUMNS,
  MARK_WORDS,
  type Mark,
  noSectorData,
  SECTORS,
  type SectorIndex,
  sectorMark,
  sectorTime,
  speed,
  trapMark,
} from "@/lib/tower";

import { InfoTip } from "./InfoTip";
import { TeamBadge } from "./TeamBadge";
import { TyreAge } from "./TyreAge";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

export const TOWER_ROWS = 22;

function MarkTag({ mark }: { mark: Mark }) {
  if (mark === null) return null;
  return (
    <span className={`tag mark mark-${mark.toLowerCase()}`} aria-describedby={tipId("pbob")}>
      {mark}
      <span className="visually-hidden">{`, ${MARK_WORDS[mark]}`}</span>
    </span>
  );
}

/** "Best so far" of the race (OB values with the car that holds them), or why there is none. */
function BestLine({
  best,
  code,
  rows,
  extrasNote,
}: {
  best: BestSoFar;
  code: (id: string) => string;
  rows: DriverRow[];
  extrasNote: string | null;
}) {
  if (extrasNote !== null) return <p className="tower-best muted">{extrasNote}</p>;
  if (rows.length === 0) return null;
  if (noSectorData(rows)) {
    return (
      <p className="tower-best muted">
        No sector or speed-trap data for this race (the sample race has none); pit counts are real.
      </p>
    );
  }
  const part = (label: string, b: { value: number; driverId: string } | null, text: (v: number) => string) =>
    b === null ? `${label} —` : `${label} ${text(b.value)} ${code(b.driverId)}`;
  return (
    <p className="tower-best">
      <span className="tower-best-label">Best so far</span>{" "}
      {SECTORS.map((i) => part(`S${i + 1}`, best.sectors[i], sectorTime)).join(" · ")}
      {" · "}
      {part("Trap", best.speedTrap, (v) => `${speed(v)} km/h`)}
    </p>
  );
}

/** True when part of ``el`` is inside the window: only then does the pinned row follow the order
 * (a reader looking at another panel is never scrolled back to the tower). */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
}

/** The timing tower: a real table in order-set order. Fixed row height and reserved space for
 * ``TOWER_ROWS`` rows, so live updates never shift the page. Every column header that needs it has
 * a focusable "?" tooltip (``InfoTip``); the per-row markers keep their visible text and a
 * screen-reader sentence and point to that header text with ``aria-describedby``, so the meaning is
 * reachable by keyboard without 20 extra tab stops per column.
 *
 * With ``entrants`` (display only, ``GET …/entrants``) each driver gets a team badge, the real code and
 * surname; the badge tooltip names the team and the teammate, and hovering a row outlines both
 * teammates' rows. The teammate is also in the row's screen-reader text, so nothing depends on
 * hover or colour. Without entrants the tower falls back to codes guessed from the driverId.
 *
 * Feature 5 (display only): S1 / S2 / S3 and the speed trap of each car's last lap with "PB" / "OB"
 * tags (personal / overall best so far, from completed laps only), the pit-stop count, a "Best so
 * far" line, a pin button per row (``pinned`` / ``onPin``; one car) and the ``visible`` columns
 * (Pos, Pin and Driver are always shown). */
export function TimingTower({
  rows,
  lapsDown,
  entrants = {},
  captionNote = "gaps at the timing line, live from the race stream",
  visible = DEFAULT_COLUMNS,
  pinned = null,
  onPin,
  extrasNote = null,
}: {
  rows: DriverRow[];
  lapsDown: (driverId: string) => number;
  entrants?: EntrantIndex;
  /** The caption's source note (the post-race mode names the archive). */
  captionNote?: string;
  visible?: readonly ColumnId[];
  pinned?: string | null;
  onPin?: (driverId: string) => void;
  /** Replaces the "Best so far" line (a v1 archive bundle without the Feature 5 values). */
  extrasNote?: string | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const show = new Set<ColumnId>(visible);
  const best = bestSoFar(rows);
  const code = (id: string) => entrants[id]?.code ?? driverCode(id);
  const pinnedIndex = pinned === null ? -1 : rows.findIndex((r) => r.driverId === pinned);

  // keep the pinned row in view when its place changes (only while the tower is on screen)
  useEffect(() => {
    if (pinned === null || pinnedIndex < 0 || wrap.current === null || !onScreen(wrap.current)) return;
    const row = wrap.current.querySelector(`tr[data-driver="${pinned}"]`);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  }, [pinned, pinnedIndex]);

  const sectorCell = (r: DriverRow, i: SectorIndex) => (
    <td key={`s${i}`} className="c-sec" data-col={`s${i + 1}`}>
      {sectorTime(r.timing.sectors[i])}
      <MarkTag mark={sectorMark(r, i, best)} />
    </td>
  );

  return (
    <div className="tower-block">
      <BestLine best={best} code={code} rows={rows} extrasNote={extrasNote} />
      <div className="tower-wrap" role="region" aria-labelledby="tower-title" tabIndex={0} ref={wrap}>
        <table className="tower">
          <caption id="tower-title">
            Timing tower <span className="caption-note">{captionNote}</span>
          </caption>
          <thead>
            <tr>
              <th scope="col" className="c-pos">
                <abbr title="Position">Pos</abbr> <InfoTip id="flag" />
              </th>
              <th scope="col" className="c-pin">
                Pin <InfoTip id="pin" />
              </th>
              <th scope="col" className="c-drv">
                Driver <InfoTip id="team" /> <InfoTip id="lapsDown" />
              </th>
              {show.has("int") ? (
                <th scope="col" className="c-num">
                  Int <InfoTip id="int" align="end" />
                </th>
              ) : null}
              {show.has("gap") ? (
                <th scope="col" className="c-num">
                  Gap <InfoTip id="gap" align="end" />
                </th>
              ) : null}
              {show.has("last") ? (
                <th scope="col" className="c-num">
                  Last lap
                </th>
              ) : null}
              {show.has("s1") ? (
                <th scope="col" className="c-sec">
                  S1 <InfoTip id="sectors" align="end" />
                </th>
              ) : null}
              {show.has("s2") ? (
                <th scope="col" className="c-sec">
                  S2
                </th>
              ) : null}
              {show.has("s3") ? (
                <th scope="col" className="c-sec">
                  S3 <InfoTip id="pbob" align="end" />
                </th>
              ) : null}
              {show.has("trap") ? (
                <th scope="col" className="c-trap">
                  Trap <InfoTip id="trap" align="end" />
                </th>
              ) : null}
              {show.has("pits") ? (
                <th scope="col" className="c-pits">
                  Pits <InfoTip id="pits" align="end" />
                </th>
              ) : null}
              {show.has("tyre") ? (
                <th scope="col" className="c-tyre">
                  Tyre
                </th>
              ) : null}
              {show.has("age") ? (
                <th scope="col" className="c-age">
                  Age <InfoTip id="age" align="end" />
                </th>
              ) : null}
              {show.has("undercut") ? (
                <th scope="col" className="c-num">
                  Undercut <InfoTip id="undercut" align="end" />
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const down = lapsDown(r.driverId);
              const e = entrants[r.driverId];
              const mates = e === undefined ? [] : teammates(entrants, r.driverId);
              const isPinned = pinned === r.driverId;
              const cls = [
                r.undercutFlag ? "is-flagged" : null,
                isPinned ? "is-pinned" : null,
                teamHighlight(entrants, hovered, r.driverId),
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr
                  key={r.driverId}
                  data-driver={r.driverId}
                  data-team={e?.constructor_id}
                  className={cls || undefined}
                  onMouseEnter={() => setHovered(r.driverId)}
                  onMouseLeave={() => setHovered((h) => (h === r.driverId ? null : h))}
                >
                  <th scope="row" className="c-pos">{r.position ?? "—"}</th>
                  <td className="c-pin">
                    <button
                      type="button"
                      className="pin-btn"
                      aria-pressed={isPinned}
                      aria-label={`Pin ${code(r.driverId)}`}
                      aria-describedby={tipId("pin")}
                      disabled={onPin === undefined}
                      onClick={() => onPin?.(r.driverId)}
                    >
                      <span aria-hidden="true">{isPinned ? "★" : "☆"}</span>
                    </button>
                  </td>
                  <td className="c-drv">
                    {e !== undefined ? (
                      <TeamBadge entrant={e} title={teamTitle(entrants, r.driverId) ?? e.team_name} describedBy={tipId("team")} />
                    ) : null}
                    <span className="code">{code(r.driverId)}</span>{" "}
                    <span className="name">{e?.family_name ?? driverName(r.driverId)}</span>
                    {mates.length > 0 ? (
                      <span className="visually-hidden">{`, teammate of ${mates.map((m) => m.family_name ?? m.driver_id).join(" and ")}`}</span>
                    ) : null}
                    {isPinned ? <span className="visually-hidden">, pinned</span> : null}
                    {r.inPit ? (
                      <span className="tag tag-pit" title="In the pit lane now" aria-describedby={tipId("lapsDown")}>
                        IN PIT
                      </span>
                    ) : null}
                    {down > 0 ? (
                      <span
                        className="tag"
                        title={`${down} ${down === 1 ? "lap" : "laps"} behind the leader`}
                        aria-describedby={tipId("lapsDown")}
                      >
                        {`+${down} L`}
                        <span className="visually-hidden">{` (${down} ${down === 1 ? "lap" : "laps"} down)`}</span>
                      </span>
                    ) : null}
                  </td>
                  {show.has("int") ? <td className="c-num">{r.position === 1 ? "Leader" : gap(r.gapAheadS)}</td> : null}
                  {show.has("gap") ? <td className="c-num">{r.position === 1 ? "Leader" : gap(r.gapLeaderS)}</td> : null}
                  {show.has("last") ? (
                    <td className="c-num" data-col="last-lap">
                      {lapTime(r.lastLapTimeS)}
                    </td>
                  ) : null}
                  {show.has("s1") ? sectorCell(r, 0) : null}
                  {show.has("s2") ? sectorCell(r, 1) : null}
                  {show.has("s3") ? sectorCell(r, 2) : null}
                  {show.has("trap") ? (
                    <td className="c-trap" data-col="trap">
                      {speed(r.timing.speedTrapKph)}
                      <MarkTag mark={trapMark(r, best)} />
                    </td>
                  ) : null}
                  {show.has("pits") ? (
                    <td className="c-pits" data-col="pits">
                      {r.stops}
                    </td>
                  ) : null}
                  {show.has("tyre") ? (
                    <td className="c-tyre">
                      <TyreGlyph compound={r.compound} /> <span>{COMPOUND_LABEL[r.compound]}</span>
                    </td>
                  ) : null}
                  {show.has("age") ? (
                    <td className="c-age">
                      <TyreAge row={r} describedBy={tipId("age")} />
                    </td>
                  ) : null}
                  {show.has("undercut") ? (
                    <td className="c-num">
                      {r.undercutFlag ? (
                        <span className="flag" title={glossary("flag").text} aria-describedby={tipId("flag")}>
                          <span aria-hidden="true">▲ </span>
                          <span className="visually-hidden">Undercut opportunity on the car ahead, </span>
                        </span>
                      ) : null}
                      {r.undercutProb === null ? (
                        <span className="undercut-none" title="Not an undercut candidate" aria-describedby={tipId("undercut")}>
                          <span aria-hidden="true">{probability(null)}</span>
                          <span className="visually-hidden">not a candidate</span>
                        </span>
                      ) : (
                        <span aria-describedby={tipId("undercut")}>
                          {probability(r.undercutProb)}
                          <span className="visually-hidden"> undercut success probability</span>
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="tower-empty">No timing yet. Start a replay to fill the tower.</p>
        ) : null}
      </div>
    </div>
  );
}
