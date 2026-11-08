import { z } from "zod";
import limitsJson from "../config/limits.json" with { type: "json" };
import { tierIdSchema } from "./events.js";

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
  requestCap: z.number().int().positive(),
  requestsPerSecond: z.number().positive(),
  tokenCap: z
    .object({ input: z.number().int().positive(), output: z.number().int().positive() })
    .nullable(),
  spendCapUsd: z.number().positive(),
  concurrency: z.number().int().positive(),
});
export type TierLimits = z.infer<typeof tierLimitsSchema>;

export const tierLimitsConfigSchema = z.object({ lite: tierLimitsSchema, full: tierLimitsSchema });
export type TierLimitsConfig = z.infer<typeof tierLimitsConfigSchema>;

export const tierLimits: TierLimitsConfig = tierLimitsConfigSchema.parse(limitsJson);

export const limitsFor = (tier: z.infer<typeof tierIdSchema>): TierLimits => tierLimits[tier];
