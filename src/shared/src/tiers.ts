import { z } from "zod";
import tiersJson from "../config/tiers.json" with { type: "json" };
import { areaIdSchema, tierIdSchema } from "./events.js";

/**
 * What a tier offers the customer: scope and entitlements only. This is the only tier data the
 * browser sees. Cost controls (model, spend, token and request caps) are in `limits.ts`, which is
 * server-only (revenue.md section 2). Edit config/tiers.json to tune it.
 */
export const tierConfigSchema = z.object({
  id: tierIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  paid: z.boolean(),
  logins: z.number().int().min(1).max(4),
  wallClockMinutes: z.number().positive(),
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
