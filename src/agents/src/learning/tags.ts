import { technologiesIn, tokensOf } from "@swarm/shared/server";
import { header } from "../http.js";
import type { StepContext } from "../types.js";

/** The words of a run's discovery that learned items and agents are matched against. */
export async function discoveryTokens(
  ctx: StepContext,
  extra: readonly string[],
): Promise<Set<string>> {
  const texts: string[] = [];
  try {
    const page = await ctx.baseline();
    for (const name of ["server", "x-powered-by", "via", "x-generator"]) {
      const value = header(page, name);
      if (value) texts.push(value);
    }
    const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,80})["']/i.exec(
      page.body,
    );
    if (generator?.[1]) texts.push(generator[1]);
  } catch {
    // The page is best effort: its headers only help match learned entries.
  }
  const { external } = await ctx.pageScripts();
  texts.push(...external);
  texts.push(...(ctx.explorer?.profile?.technologies ?? []));
  const names = technologiesIn(texts).map((t) => t.name);
  return tokensOf(texts, [...names, ...extra]);
}
