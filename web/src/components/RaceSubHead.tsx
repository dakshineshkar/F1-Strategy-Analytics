import Link from "next/link";

import { PhoneLabel } from "./PhoneLabel";

export type RaceSubPage = "analysis" | "drivers";

/** The head of the race analysis and drivers pages (redesign step 4B, critique F08): the live and archive head's
 * order (crumbs, the race's name, then the race's views), so every race page reads the same. The current page is
 * marked by ``aria-current`` and a 2 px underline, never by the signal amber. */
export function RaceSubHead({ season, round, name, page }: { season: number; round: number; name: string | null; page: RaceSubPage }) {
  const base = `/race/${season}/${round}`;
  return (
    <div className="race-head race-head-sub">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">All races</Link>
      </nav>
      <h1>
        <span className="race-season">{season}</span> {name ?? `Round ${round}`}
        <span className="race-round"> R{round}</span>
      </h1>
      <nav aria-label="Race views" className="race-views">
        <Link href={base}>
          <PhoneLabel full="Live race" short="Live" />
        </Link>
        <Link href={`${base}/analysis`} aria-current={page === "analysis" ? "page" : undefined}>
          <PhoneLabel full="Race analysis" short="Analysis" />
        </Link>
        <Link href={`${base}/drivers`} aria-current={page === "drivers" ? "page" : undefined}>
          Drivers
        </Link>
      </nav>
    </div>
  );
}
