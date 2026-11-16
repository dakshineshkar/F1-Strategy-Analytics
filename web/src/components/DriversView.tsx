import { byGrid, colourSourceText, type Entrant, fullName, gridLabel, teammates, indexEntrants } from "@/lib/entrants";

import { TeamBadge } from "./TeamBadge";

/** The per-race "Drivers" view: a real table sorted by grid slot (pit-lane starts last). Each row
 * shows the team badge and code, the driver's name, the F1-style nationality code, the season's team
 * name in text and the car number raced in this race. Display only. */
export function DriversView({ entrants }: { entrants: readonly Entrant[] }) {
  const rows = [...entrants].sort(byGrid);
  const index = indexEntrants(rows);
  const sources = new Set(rows.map((e) => e.colour_source));
  return (
    <div className="tower-wrap" role="region" aria-labelledby="drivers-title" tabIndex={0}>
      <table className="tower drivers-table">
        <caption id="drivers-title">
          Drivers <span className="caption-note">sorted by grid position</span>
        </caption>
        <thead>
          <tr>
            <th scope="col" className="c-grid">Grid</th>
            <th scope="col" className="c-drv">Driver</th>
            <th scope="col" className="c-nat">
              <abbr title="Nationality">Nat.</abbr>
            </th>
            <th scope="col" className="c-team">Team</th>
            <th scope="col" className="c-car">
              <abbr title="Car number">No.</abbr>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const mates = teammates(index, e.driver_id);
            return (
              <tr key={e.driver_id} data-driver={e.driver_id} data-team={e.constructor_id}>
                <td className="c-grid">{gridLabel(e.grid)}</td>
                <th scope="row" className="c-drv">
                  <TeamBadge entrant={e} />
                  <span className="code">{e.code ?? "—"}</span> <span className="name">{fullName(e)}</span>
                  {mates.length > 0 ? (
                    <span className="visually-hidden">{`, teammate of ${mates.map(fullName).join(" and ")}`}</span>
                  ) : null}
                </th>
                <td className="c-nat">
                  {e.nationality_code !== null ? <abbr title={e.nationality ?? undefined}>{e.nationality_code}</abbr> : "—"}
                </td>
                <td className="c-team">{e.team_name}</td>
                <td className="c-car">{e.car_number ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="drivers-note muted">
        Team badges are original swatches with a text code, not official logos.{" "}
        {[...sources].sort().map((s) => `Badge ${colourSourceText(s)}.`).join(" ")}
      </p>
    </div>
  );
}
