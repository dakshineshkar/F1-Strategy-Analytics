import type { DriverRow } from "@/lib/reducer";
import { ESTIMATED_NOTE, tyreAgeView } from "@/lib/tyre";

/** A car's tyre age as text: the real tyre life (with a "used" tag when the set had laps before the
 * stint) or the inferred age marked "est.". The visible text is for sighted readers; one full
 * sentence is read by screen readers instead. Nothing depends on colour. */
export function TyreAge({
  row,
  unit = false,
}: {
  row: Pick<DriverRow, "tyreLifeLaps" | "tyreLifeAtStartLaps" | "tyreAgeLaps">;
  unit?: boolean;
}) {
  const v = tyreAgeView(row);
  const num = v.laps === null ? "—" : unit ? `${v.laps} ${v.laps === 1 ? "lap" : "laps"}` : String(v.laps);
  return (
    <span className={`tyre-age tyre-age-${v.kind}`} title={v.description} data-tyre-age={v.kind}>
      <span aria-hidden="true">
        {num}
        {v.used ? <span className="tag tag-used">used</span> : null}
        {v.kind === "estimated" ? (
          <abbr className="age-est" title={ESTIMATED_NOTE}>
            est.
          </abbr>
        ) : null}
      </span>
      <span className="visually-hidden">{v.description}</span>
    </span>
  );
}
