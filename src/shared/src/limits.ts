import { z } from "zod";
import limitsJson from "../config/limits.json" with { type: "json" };
import { TIER_IDS, tierIdSchema } from "./events.js";

/**
 * Server-only run limits and model choice (PLAN.md section 11, revenue.md section 2). These are cost
 * controls, not product features: they must never reach the browser, so they live behind the
 * `@swarm/shared/server` entry point and are not exported from the package root.
 */
export const tierLimitsSchema = z.object({
  modelId: z.string().min(1),
  /** null means no fixed cap (per-agent budgets apply instead). */
  pageCap: z.number().int().positive().nullable(),
  llmStepCap: z.number().int().positive().nullable(),
  /** Checks (agent steps) a run may perform in total; the rest are reported as gaps. */
  stepCap: z.number().int().positive(),
  requestCap: z.number().int().positive(),
  requestsPerSecond: z.number().positive(),
  tokenCap: z
    .object({ input: z.number().int().positive(), output: z.number().int().positive() })
    .nullable(),
  spendCapUsd: z.number().positive(),
  concurrency: z.number().int().positive(),
});
export type TierLimits = z.infer<typeof tierLimitsSchema>;

export const tierLimitsConfigSchema = z
  .object({
    scout: tierLimitsSchema,
    sweep: tierLimitsSchema,
    probe: tierLimitsSchema,
    siege: tierLimitsSchema,
  })
  .refine(
    (t) =>
      TIER_IDS.every((id, i) => i === 0 || t[id].spendCapUsd >= t[TIER_IDS[i - 1]!].spendCapUsd),
    "spend caps must not fall as depth increases",
  );
export type TierLimitsConfig = z.infer<typeof tierLimitsConfigSchema>;

export const tierLimits: TierLimitsConfig = tierLimitsConfigSchema.parse(limitsJson);

export const limitsFor = (tier: z.infer<typeof tierIdSchema>): TierLimits => tierLimits[tier];
