import type { CSSProperties } from "react";

import type { Entrant } from "@/lib/entrants";

/** An original team mark: a rounded swatch in the team colour with the short code as text
 * (FER, MCL, RBR). No logo or artwork. The code is always visible and the team name is in the
 * ``title`` and, for screen readers, in text, so colour never carries the meaning on its own. A
 * fixed outline in the border token (>= 3:1 on every background) keeps white or grey swatches visible on any
 * background. */
export function TeamBadge({ entrant, title, describedBy }: { entrant: Entrant; title?: string; describedBy?: string }) {
  const style = {
    "--team": entrant.team_colour_hex,
    "--team-ink": entrant.team_text_hex,
  } as CSSProperties;
  return (
    <span
      className="team-badge"
      style={style}
      title={title ?? entrant.team_name}
      data-team={entrant.constructor_id}
      aria-describedby={describedBy}
    >
      <span aria-hidden="true">{entrant.team_code}</span>
      <span className="visually-hidden">{`${entrant.team_name}, `}</span>
    </span>
  );
}
