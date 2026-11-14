import {
  TIER_IDS,
  type CostAnalysis,
  type EntitlementSource,
  type TierCostStats,
  type TierId,
} from "@swarm/shared";
import type { Pricing } from "@swarm/shared/server";
import { costOf, entitlementOf, type IndexRecord } from "./index-records.js";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The value below which `p` (0..1) of the sorted values fall (nearest rank). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const SOURCES: EntitlementSource[] = ["staff", "comp", "purchase", "credit"];

/**
 * Cost statistics over closed runs: per depth (average, median, p95, cost per finding), per day, by
 * who paid, and by cost component. With `table`, every run that kept its usage is costed again under
 * that price table; the rest keep what they were recorded with and are counted in `notRepriced`.
 */
export function analyseCosts(
  records: readonly IndexRecord[],
  range: { from: string; to: string },
  table: Pricing | null,
): CostAnalysis {
  const priced = records.map((record) => ({ record, cost: costOf(record, table) }));

  const byTier = Object.fromEntries(
    TIER_IDS.map((tier) => {
      const rows = priced.filter((p) => p.record.tier === tier);
      const costs = rows.map((p) => p.cost.totalUsd).sort((a, b) => a - b);
      const total = costs.reduce((a, b) => a + b, 0);
      const findings = rows.reduce((a, p) => a + p.record.findings.total, 0);
      const stats: TierCostStats = {
        runs: rows.length,
        avgUsd: rows.length ? round(total / rows.length) : 0,
        medianUsd: round(median(costs)),
        p95Usd: round(percentile(costs, 0.95)),
        maxUsd: round(costs.at(-1) ?? 0),
        totalUsd: round(total),
        avgDurationSeconds: rows.length
          ? Math.round(rows.reduce((a, p) => a + p.record.durationSeconds, 0) / rows.length)
          : 0,
        findings,
        costPerFindingUsd: findings > 0 ? round(total / findings) : null,
      };
      return [tier, stats];
    }),
  ) as Record<TierId, TierCostStats>;

  const days = new Map<string, { runs: number; usd: number }>();
  for (const { record, cost } of priced) {
    const day = record.finishedAt.slice(0, 10);
    const entry = days.get(day) ?? { runs: 0, usd: 0 };
    entry.runs += 1;
    entry.usd += cost.totalUsd;
    days.set(day, entry);
  }

  const bySource = Object.fromEntries(
    SOURCES.map((source) => {
      const rows = priced.filter((p) => entitlementOf(p.record) === source);
      return [
        source,
        { runs: rows.length, usd: round(rows.reduce((a, p) => a + p.cost.totalUsd, 0)) },
      ];
    }),
  ) as CostAnalysis["bySource"];

  const sum = (pick: (p: (typeof priced)[number]) => number) =>
    round(priced.reduce((a, p) => a + pick(p), 0));

  return {
    from: range.from,
    to: range.to,
    pricing: table
      ? { mode: "repriced", version: table.version }
      : { mode: "recorded", version: null },
    runs: records.length,
    notRepriced: table ? priced.filter((p) => !p.cost.repriced).length : 0,
    totalUsd: sum((p) => p.cost.totalUsd),
    byTier,
    byDay: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, runs: v.runs, usd: round(v.usd) })),
    bySource,
    components: {
      fargateUsd: sum((p) => p.cost.fargateUsd),
      egressUsd: sum((p) => p.cost.egressUsd),
      bedrockUsd: sum((p) => p.cost.bedrockUsd),
      orchestrationUsd: sum((p) => p.cost.orchestrationUsd),
      learnerUsd: sum((p) => p.cost.learnerUsd),
    },
    topRuns: [...priced]
      .sort((a, b) => b.cost.totalUsd - a.cost.totalUsd)
      .slice(0, 5)
      .map((p) => ({
        runId: p.record.runId,
        tier: p.record.tier,
        costUsd: p.cost.totalUsd,
        startedAt: p.record.startedAt,
      })),
  };
}
