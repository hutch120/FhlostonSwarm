import { z } from "zod";
import tiersJson from "../config/tiers.json" with { type: "json" };
import {
  TIER_IDS,
  agentIdSchema,
  areaIdSchema,
  tierIdSchema,
  type AgentSpec,
  type AreaId,
  type AreaSpec,
  type TierId,
} from "./events.js";
import { AGENTS, AREAS } from "./fixtures/roster.js";

/**
 * What a tier offers the customer: scan depth, the agents it runs and its entitlements. This is the
 * only tier data the browser sees. Cost controls (model, spend, token and request caps) are in
 * `limits.ts`, which is server-only (revenue.md section 2). Edit config/tiers.json to tune it.
 */
export const tierConfigSchema = z.object({
  id: tierIdSchema,
  name: z.string().min(1),
  /** 1 (shallowest) to 4 (deepest). Price and cost rise with depth. */
  depth: z.number().int().min(1).max(TIER_IDS.length),
  description: z.string().min(1),
  /** Logins the scan can use; 0 means unauthenticated checks only. */
  logins: z.number().int().min(0).max(4),
  wallClockMinutes: z.number().positive(),
  steering: z.boolean(),
  /** The group of agents this tier runs (ids from the roster). */
  agents: z.array(agentIdSchema).min(1),
});
export type TierConfig = z.infer<typeof tierConfigSchema>;

const knownAgents = new Set(AGENTS.map((a) => a.id));

export const tiersConfigSchema = z
  .object({
    scout: tierConfigSchema,
    sweep: tierConfigSchema,
    probe: tierConfigSchema,
    siege: tierConfigSchema,
  })
  .superRefine((t, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    TIER_IDS.forEach((id, i) => {
      const tier = t[id];
      if (tier.id !== id) issue(`tier key ${id} must match its id`, [id]);
      if (tier.depth !== i + 1) issue(`${id} must have depth ${i + 1}`, [id, "depth"]);
      for (const agent of tier.agents) {
        if (!knownAgents.has(agent)) issue(`unknown agent ${agent}`, [id, "agents"]);
      }
      const shallower = i > 0 ? t[TIER_IDS[i - 1]!] : undefined;
      if (!shallower) return;
      if (!shallower.agents.every((a) => tier.agents.includes(a)))
        issue(`${id} must include every agent of ${shallower.id}`, [id, "agents"]);
      if (tier.logins < shallower.logins)
        issue(`${id} cannot allow fewer logins than ${shallower.id}`, [id, "logins"]);
    });
  });
export type TiersConfig = z.infer<typeof tiersConfigSchema>;

export const tiers: TiersConfig = tiersConfigSchema.parse(tiersJson);

/** Tiers from shallowest to deepest. */
export const TIERS: readonly TierConfig[] = TIER_IDS.map((id) => tiers[id]);

/** The testing areas a tier touches, derived from its agents. */
export function tierAreas(tier: TierId): AreaId[] {
  const wanted = new Set(tiers[tier].agents);
  const areas = new Set(AGENTS.filter((a) => wanted.has(a.id)).map((a) => a.area));
  return areaIdSchema.options.filter((id) => areas.has(id));
}

/** The agents and areas a run of this tier plans to cover, in roster order. */
export function tierRoster(tier: TierId): { areas: AreaSpec[]; agents: AgentSpec[] } {
  const wanted = new Set(tiers[tier].agents);
  const agents = AGENTS.filter((a) => wanted.has(a.id));
  const areaIds = new Set(agents.map((a) => a.area));
  return { areas: AREAS.filter((a) => areaIds.has(a.id)), agents };
}
