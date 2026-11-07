import { z } from "zod";
import tiersJson from "../config/tiers.json" with { type: "json" };
import { areaIdSchema, tierIdSchema } from "./events.js";

/** Tier limits are data, not code (PLAN.md section 11); edit config/tiers.json to tune them. */
export const tierConfigSchema = z.object({
  id: tierIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  modelId: z.string().min(1),
  paid: z.boolean(),
  logins: z.number().int().min(1).max(4),
  wallClockMinutes: z.number().positive(),
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
  /** Findings shown in full detail; null shows all of them. */
  teaserFindings: z.number().int().nonnegative().nullable(),
  steering: z.boolean(),
  areas: z.array(areaIdSchema).min(1),
});
export type TierConfig = z.infer<typeof tierConfigSchema>;

export const tiersConfigSchema = z
  .object({ lite: tierConfigSchema, full: tierConfigSchema })
  .refine((t) => t.lite.id === "lite" && t.full.id === "full", "tier keys must match their ids");
export type TiersConfig = z.infer<typeof tiersConfigSchema>;

export const tiers: TiersConfig = tiersConfigSchema.parse(tiersJson);
