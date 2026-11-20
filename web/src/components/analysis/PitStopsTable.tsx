import { useId } from "react";

import { PairArrow } from "@/components/Marks";
import { pitStopsSummary, type PitStop } from "@/lib/analysis";

import { CompoundTag, LapLink, type Names } from "./common";

/** "from → to": the authored arrow (the font subset has no "→"), read as "to". */
function To() {
  return (
    <span className="to-mark">
      <PairArrow size={12} />
      <span className="visually-hidden">to</span>
    </span>
  );
}

/** Every Jolpica pit stop by lap: the pit-lane time (entry to exit, not the stationary time), the
 * tyres before and after, the positions on the in-lap and the out-lap, and notes. */
export function PitStopsTable({ stops, names, onLap }: { stops: readonly PitStop[]; names: Names; onLap: (lap: number) => void }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="analysis-view">
      <h2 id={`${id}-h`}>Pit stops</h2>
      <p className="chart-summary">{pitStopsSummary(stops, names.code)}</p>
      <p className="panel-note">Pit lane = the pit-lane time from Jolpica (entry to exit, not the stationary time).</p>
      {stops.length === 0 ? (
        <p className="muted">No pit stops in the lake for this race.</p>
      ) : (
        <div className="tower-wrap" role="region" aria-label="Pit stops by lap (table)" tabIndex={0}>
          <table className="tower analysis-table">
            <caption>Pit stops by lap</caption>
            <thead>
              <tr>
                <th scope="col" className="c-num">Lap</th>
                <th scope="col">Driver</th>
                <th scope="col" className="c-num">Stop</th>
                <th scope="col" className="c-num">Pit lane</th>
                <th scope="col">Tyres</th>
                <th scope="col" className="c-num">Position</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {stops.map((p) => (
                <tr key={`${p.driver_id}-${p.stop}`}>
                  <td className="c-num">
                    <LapLink lap={p.lap} onLap={onLap}>
                      {p.lap}
                    </LapLink>
                  </td>
                  <th scope="row">
                    {names.code(p.driver_id)} <span className="name">{names.name(p.driver_id)}</span>
                  </th>
                  <td className="c-num">{p.stop}</td>
                  <td className="c-num">{p.duration_s === null ? "—" : `${p.duration_s.toFixed(3)} s`}</td>
                  <td className="wrap">
                    <CompoundTag compound={p.compound_before} />
                    {p.tyre_life_before !== null ? ` (${p.tyre_life_before} laps)` : ""} <To /> <CompoundTag compound={p.compound_after} />
                  </td>
                  <td className="c-num">
                    {p.position_before ?? "—"} <To /> {p.position_after ?? "—"}
                  </td>
                  <td>
                    {[p.under_neutralisation ? "under SC/VSC" : "", p.is_long_stop ? "long stop (> 60 s)" : ""]
                      .filter(Boolean)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
