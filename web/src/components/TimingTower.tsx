import { driverCode, driverName, gap, lapTime, probability } from "@/lib/format";
import { glossary, tipId } from "@/lib/legend";
import type { DriverRow } from "@/lib/reducer";

import { InfoTip } from "./InfoTip";
import { TyreAge } from "./TyreAge";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

export const TOWER_ROWS = 22;

/** The timing tower: a real table in order-set order. Fixed row height and reserved space for
 * ``TOWER_ROWS`` rows, so live updates never shift the page. Every column header that needs it has
 * a focusable "?" tooltip (``InfoTip``); the per-row markers keep their visible text and a
 * screen-reader sentence and point to that header text with ``aria-describedby``, so the meaning is
 * reachable by keyboard without 20 extra tab stops per column. */
export function TimingTower({ rows, lapsDown }: { rows: DriverRow[]; lapsDown: (driverId: string) => number }) {
  return (
    <div className="tower-wrap" role="region" aria-labelledby="tower-title" tabIndex={0}>
      <table className="tower">
        <caption id="tower-title">
          Timing tower <span className="caption-note">gaps at the timing line, live from the race stream</span>
        </caption>
        <thead>
          <tr>
            <th scope="col" className="c-pos">
              <abbr title="Position">Pos</abbr> <InfoTip id="flag" />
            </th>
            <th scope="col" className="c-drv">
              Driver <InfoTip id="lapsDown" />
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
            return (
              <tr key={r.driverId} data-driver={r.driverId} className={r.undercutFlag ? "is-flagged" : undefined}>
                <th scope="row" className="c-pos">{r.position ?? "—"}</th>
                <td className="c-drv">
                  <span className="code">{driverCode(r.driverId)}</span>{" "}
                  <span className="name">{driverName(r.driverId)}</span>
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
