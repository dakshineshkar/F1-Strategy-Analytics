import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RaceDashboard } from "@/components/RaceDashboard";
import { parseRaceQuery } from "@/lib/archive";
import { parseRaceParams } from "@/lib/params";

type Params = Promise<{ season: string; round: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { season, round } = await params;
  return { title: `${season} R${round}` };
}

export default async function RacePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { season, round } = await params;
  const parsed = parseRaceParams(season, round);
  if (parsed === null) notFound();
  const q = parseRaceQuery(await searchParams);
  return <RaceDashboard season={parsed.season} round={parsed.round} initialMode={q.mode} initialLap={q.lap} />;
}
