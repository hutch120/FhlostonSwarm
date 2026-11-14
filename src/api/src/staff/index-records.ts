import {
  runStatusSchema,
  runTriggerSchema,
  tierIdSchema,
  type EntitlementSource,
} from "@swarm/shared";
import { bedrockUsd, costUsageSchema, repriceUsage, type Pricing } from "@swarm/shared/server";
import { z } from "zod";
import { creditSourceSchema } from "../credits.js";
import { getJson } from "../storage/json.js";
import { keys } from "../storage/keys.js";
import type { ObjectStore } from "../storage/store.js";

/**
 * One closed run in the anonymised run index (`admin/run-index/`): tier, timings, counts and the
 * cost, with no account, target or finding content, so it outlives a deleted run or account. `usage`
 * is what the run consumed without any price, so it can be costed again under another price table;
 * records from before it was kept have none.
 */
export const indexRecordSchema = z.looseObject({
  test: z.boolean().optional(),
  runId: z.string(),
  tier: tierIdSchema,
  trigger: runTriggerSchema,
  entitlement: z.enum(["credit", "staff"]),
  creditSource: creditSourceSchema.optional(),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  findings: z.looseObject({ total: z.number() }),
  cost: z.looseObject({
    pricingVersion: z.string(),
    fargateUsd: z.number(),
    egressUsd: z.number(),
    orchestrationUsd: z.number().optional(),
    bedrock: z.looseObject({ usd: z.number() }),
    totalUsd: z.number(),
  }),
  usage: costUsageSchema.optional(),
  /** The learning pass that reviewed the run, priced separately; `cost.totalUsd` does not include it. */
  learner: z
    .looseObject({
      modelId: z.string(),
      usd: z.number(),
      seconds: z.number(),
      calls: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});
export type IndexRecord = z.infer<typeof indexRecordSchema>;

export const entitlementOf = (record: {
  entitlement: "credit" | "staff";
  creditSource?: "comp" | "purchase" | undefined;
}): EntitlementSource =>
  record.entitlement === "staff" ? "staff" : (record.creditSource ?? "credit");

export interface CostParts {
  fargateUsd: number;
  egressUsd: number;
  bedrockUsd: number;
  orchestrationUsd: number;
  learnerUsd: number;
  /** All of it: the run and its learning pass. */
  totalUsd: number;
  /** False when the figures are as recorded although another table was asked for. */
  repriced: boolean;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The record's cost as recorded, or costed again under `table` when it kept its usage. */
export function costOf(record: IndexRecord, table: Pricing | null): CostParts {
  const { cost, learner, usage } = record;
  const recordedOrchestration =
    cost.orchestrationUsd ??
    Math.max(0, cost.totalUsd - cost.fargateUsd - cost.egressUsd - cost.bedrock.usd);
  const recorded = {
    fargateUsd: cost.fargateUsd,
    egressUsd: cost.egressUsd,
    bedrockUsd: cost.bedrock.usd,
    orchestrationUsd: recordedOrchestration,
    learnerUsd: learner?.usd ?? 0,
  };
  if (!table || !usage) {
    return {
      ...recorded,
      totalUsd: round(cost.totalUsd + recorded.learnerUsd),
      repriced: false,
    };
  }
  const again = repriceUsage(usage, table, cost.bedrock.usd);
  const learnerUsd =
    learner?.modelId &&
    table.bedrock[learner.modelId] &&
    learner.inputTokens !== undefined &&
    learner.outputTokens !== undefined
      ? round(
          bedrockUsd(
            learner.modelId,
            { inputTokens: learner.inputTokens, outputTokens: learner.outputTokens },
            table,
          ),
        )
      : recorded.learnerUsd;
  return {
    fargateUsd: again.fargateUsd,
    egressUsd: again.egressUsd,
    bedrockUsd: again.bedrockUsd,
    orchestrationUsd: again.orchestrationUsd,
    learnerUsd,
    totalUsd: round(again.totalUsd + learnerUsd),
    repriced: true,
  };
}

/** `YYYY-MM-DD` of the day an index record was written (the key's date, in UTC). */
export const dayOfKey = (key: string): string | null =>
  /admin\/run-index\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(key)?.slice(1).join("-") ?? null;

/** The records written from `from` to `to` (inclusive, `YYYY-MM-DD`), oldest first. */
export async function readIndex(
  store: ObjectStore,
  from: string,
  to: string,
): Promise<IndexRecord[]> {
  const wanted = (await store.list(keys.runIndexPrefix))
    .filter((key) => {
      const day = dayOfKey(key);
      return day !== null && day >= from && day <= to;
    })
    .sort();
  const records: IndexRecord[] = [];
  for (let i = 0; i < wanted.length; i += 25) {
    const page = await Promise.all(
      wanted.slice(i, i + 25).map((key) => getJson(store, key, indexRecordSchema)),
    );
    for (const found of page) if (found) records.push(found.value);
  }
  return records;
}
