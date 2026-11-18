"use client";

import { useState } from "react";

import { type EntrantIndex, teamHighlight, teammates, teamTitle } from "@/lib/entrants";
import { driverCode, driverName, gap, lapTime, probability } from "@/lib/format";
import { glossary, tipId } from "@/lib/legend";
import type { DriverRow } from "@/lib/reducer";

import { InfoTip } from "./InfoTip";
import { TeamBadge } from "./TeamBadge";
import { TyreAge } from "./TyreAge";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

export const TOWER_ROWS = 22;

/** The timing tower: a real table in order-set order. Fixed row height and reserved space for
 * ``TOWER_ROWS`` rows, so live updates never shift the page. Every column header that needs it has
 * a focusable "?" tooltip (``InfoTip``); the per-row markers keep their visible text and a
 * screen-reader sentence and point to that header text with ``aria-describedby``, so the meaning is
 * reachable by keyboard without 20 extra tab stops per column.
 *
 * With ``entrants`` (display only, ``GET …/entrants``) each driver gets a team badge, the real code and
 * surname; the badge tooltip names the team and the teammate, and hovering a row outlines both
 * teammates' rows. The teammate is also in the row's screen-reader text, so nothing depends on
 * hover or colour. Without entrants the tower falls back to codes guessed from the driverId. */
export function TimingTower({
  rows,
  lapsDown,
  entrants = {},
  captionNote = "gaps at the timing line, live from the race stream",
}: {
  rows: DriverRow[];
  lapsDown: (driverId: string) => number;
  entrants?: EntrantIndex;
  /** The caption's source note (the post-race mode names the archive). */
  captionNote?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div className="tower-wrap" role="region" aria-labelledby="tower-title" tabIndex={0}>
      <table className="tower">
        <caption id="tower-title">
          Timing tower <span className="caption-note">{captionNote}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col" className="c-pos">
              <abbr title="Position">Pos</abbr> <InfoTip id="flag" />
            </th>
            <th scope="col" className="c-drv">
              Driver <InfoTip id="team" /> <InfoTip id="lapsDown" />
            </th>
            <th scope="col" className="c-num">
              Int <InfoTip id="int" align="end" />
            </th>
            <th scope="col" className="c-num">
              Gap <InfoTip id="gap" align="end" />
            </th>
            <th scope="col" className="c-num">Last lap</th>
            <th scope="col" className="c-tyre">Tyre</th>
            <th scope="col" className="c-age">
              Age <InfoTip id="age" align="end" />
            </th>
            <th scope="col" className="c-num">
              Undercut <InfoTip id="undercut" align="end" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const down = lapsDown(r.driverId);
            const e = entrants[r.driverId];
            const mates = e === undefined ? [] : teammates(entrants, r.driverId);
            const cls = [r.undercutFlag ? "is-flagged" : null, teamHighlight(entrants, hovered, r.driverId)]
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
                <td className="c-drv">
                  {e !== undefined ? (
                    <TeamBadge entrant={e} title={teamTitle(entrants, r.driverId) ?? e.team_name} describedBy={tipId("team")} />
                  ) : null}
                  <span className="code">{e?.code ?? driverCode(r.driverId)}</span>{" "}
                  <span className="name">{e?.family_name ?? driverName(r.driverId)}</span>
                  {mates.length > 0 ? (
                    <span className="visually-hidden">{`, teammate of ${mates.map((m) => m.family_name ?? m.driver_id).join(" and ")}`}</span>
                  ) : null}
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
                <td className="c-num">{r.position === 1 ? "Leader" : gap(r.gapAheadS)}</td>
                <td className="c-num">{r.position === 1 ? "Leader" : gap(r.gapLeaderS)}</td>
                <td className="c-num" data-col="last-lap">{lapTime(r.lastLapTimeS)}</td>
                <td className="c-tyre">
                  <TyreGlyph compound={r.compound} /> <span>{COMPOUND_LABEL[r.compound]}</span>
                </td>
                <td className="c-age">
                  <TyreAge row={r} describedBy={tipId("age")} />
                </td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="tower-empty">No timing yet. Start a replay to fill the tower.</p>
      ) : null}
    </div>
  );
}
