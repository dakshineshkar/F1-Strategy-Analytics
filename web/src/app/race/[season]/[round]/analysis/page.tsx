import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AnalysisPage } from "@/components/analysis/AnalysisPage";
import { parseAnalysisQuery } from "@/lib/analysis";
import { parseRaceParams } from "@/lib/params";

type Params = Promise<{ season: string; round: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { season, round } = await params;
  return { title: `Race analysis · ${season} R${round}` };
}

export default async function RaceAnalysisPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { season, round } = await params;
  const parsed = parseRaceParams(season, round);
  if (parsed === null) notFound();
  const initial = parseAnalysisQuery(await searchParams);
  return <AnalysisPage season={parsed.season} round={parsed.round} initial={initial} />;
}
