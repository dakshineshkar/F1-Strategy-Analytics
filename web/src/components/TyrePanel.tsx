import { driverCode, driverName } from "@/lib/format";
import type { DriverRow } from "@/lib/reducer";
import { tipId } from "@/lib/legend";
import { tyreAgeView } from "@/lib/tyre";

import { InfoTip } from "./InfoTip";
import { TyreAge } from "./TyreAge";
import { COMPOUND_LABEL, TyreGlyph } from "./TyreGlyph";

export const AGE_SCALE_LAPS = 40;

/** Compound as text plus a shape, and tyre age as a bar with its number: the real tyre life when
 * known (marked "used" for a set with earlier laps), else the inferred age marked "est.". */
export function TyrePanel({ rows }: { rows: DriverRow[] }) {
  return (
    <section className="panel tyre-panel" aria-labelledby="tyres-h">
      <div className="panel-head">
        <h2 id="tyres-h">Tyres</h2>
        <InfoTip id="age" scope="panel" align="end" label="tyre age" />
      </div>
      <ul className="tyres">
        {rows.map((r) => {
          const age = tyreAgeView(r).laps;
          const pct = age === null ? 0 : Math.min(100, (age / AGE_SCALE_LAPS) * 100);
          return (
            <li key={r.driverId} className="tyre-row">
              <span className="code" title={driverName(r.driverId)}>{driverCode(r.driverId)}</span>
              <span className={`compound compound-${r.compound.toLowerCase()}`}>
                <TyreGlyph compound={r.compound} /> {COMPOUND_LABEL[r.compound]}
              </span>
              <span className="age-bar" aria-hidden="true">
                <span className="age-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="age-num">
                <TyreAge row={r} unit describedBy={tipId("age", "panel")} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
