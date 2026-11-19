import { GLOSSARY, GROUP_TITLE, type GlossaryGroup } from "@/lib/legend";

/** The live race page's groups (the analysis tab passes its own). */
export const LIVE_GROUPS: readonly GlossaryGroup[] = ["tower", "alerts", "whatif", "pipeline"];

/** "How to read this": every marker of the dashboard in one collapsible list (native
 * ``<details>``, keyboard-operable without script). The texts are the tooltips' (``lib/legend``). */
export function Legend({ groups = LIVE_GROUPS }: { groups?: readonly GlossaryGroup[] }) {
  return (
    <details className="legend panel">
      <summary>How to read this</summary>
      <div className="legend-body">
        {groups.map((g) => (
          <section key={g} className="legend-group" aria-label={GROUP_TITLE[g]}>
            <h3>{GROUP_TITLE[g]}</h3>
            <dl>
              {GLOSSARY.filter((e) => e.group === g).map((e) => (
                <div key={e.id} className="legend-item">
                  <dt>
                    {e.id === "flag" ? <span className="legend-bar" aria-hidden="true" /> : null}
                    {e.term}
                  </dt>
                  <dd>{e.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </details>
  );
}
