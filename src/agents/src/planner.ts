import {
  GUARDRAIL_IDS,
  INSTRUCTIONS_VERSION,
  PLAN_DEPENDENT_AGENTS,
  aiFeatureSchema,
  engagementSchema,
  planProposalSchema,
  runtimeConfig,
  sitePathSchema,
  type AiFeature,
  type Engagement,
  type PlanProposal,
} from "@swarm/shared/server";
import { AGENTS, tiers } from "@swarm/shared";
import type { z } from "zod";
import { findAiFeatures } from "./agents/ai.js";
import { classifyRole, pathOnTarget } from "./agents/support.js";
import { renderModules } from "./instructions/modules.js";
import { LlmBudgetExhausted, type LlmMeter } from "./llm/meter.js";
import { SAFETY_RULES, runLoop, untrusted, type Tool } from "./llm/loop.js";
import type { LlmClient } from "./llm/types.js";
import type { StepContext } from "./types.js";

const NO_AI = "No AI or language-model feature was found on the pages explored.";
const MAX_ROUTES = 60;

const planned = new Set<string>(PLAN_DEPENDENT_AGENTS);
const stepsOf = new Map(AGENTS.map((a) => [a.id, new Set(a.steps.map((s) => s.id))]));

/** The plan the rules alone produce from what discovery saw. */
export async function baseEngagement(ctx: StepContext): Promise<Engagement> {
  const { input } = ctx;
  const group = tiers[input.tier].agents;
  const ai = await findAiFeatures(ctx);

  const slots = ["public", ...ctx.roles().map((r) => r.slot)];
  const routes = [
    ...new Set(
      slots.flatMap((s) =>
        (ctx.explorer?.pagesFor(s) ?? []).flatMap((p) => {
          const path = pathOnTarget(ctx, p.url)?.split("?")[0];
          return path && sitePathSchema.safeParse(path).success ? [path] : [];
        }),
      ),
    ),
  ]
    .sort()
    .slice(0, MAX_ROUTES);

  const code: string[] = [];
  const { external, inline } = await ctx.pageScripts();
  code.push(...inline);
  for (const url of external.slice(0, 6)) {
    const body = await ctx.scriptBody(url);
    if (body) code.push(body);
  }
  const apiBases = [
    ...new Set(
      code.flatMap((text) =>
        [...text.matchAll(/["'`](\/(?:api|graphql|v\d+))(?:\/|["'`])/g)].map((m) => m[1]!),
      ),
    ),
  ].slice(0, 10);

  const roles = Object.entries(input.logins).map(([slot, login]) => ({
    slot: slot as "admin" | "user1" | "user2" | "other",
    description: login.description.slice(0, 500),
    kind: classifyRole(slot, login.description),
  }));
  const admins = roles.filter((r) => r.kind === "admin").map((r) => r.slot);
  const people = roles.filter((r) => r.kind !== "admin");
  const matrix = roles
    .filter((r) => r.kind !== "admin")
    .map((r) => ({
      role: r.slot,
      tests: [
        ...(admins.length > 0 ? ["vertical" as const] : []),
        "admin-exposure" as const,
        ...(group.includes("idor") && people.length > 1 ? ["horizontal" as const] : []),
      ],
      against: [...admins, ...people.filter((p) => p.slot !== r.slot).map((p) => p.slot)],
    }));

  const agents = group.map((id) => ({
    id,
    enabled: !(["prompt", "output"].includes(id) && ai.length === 0),
    ...(["prompt", "output"].includes(id) && ai.length === 0 ? { reason: NO_AI } : {}),
  }));

  const pagesSeen = new Set(
    slots.flatMap((s) => ctx.explorer?.pagesFor(s).map((p) => p.url) ?? []),
  );
  return {
    version: 1,
    runId: input.runId,
    tier: input.tier,
    instructionsVersion: INSTRUCTIONS_VERSION,
    guardrails: [...GUARDRAIL_IDS],
    scope: { hosts: [...input.scope.hosts], readOnly: true },
    agents,
    skippedChecks: [],
    roles,
    matrix,
    hints: { routes, apiBases, ai },
    budget: {
      wallClockSeconds: input.budgets.wallClockSeconds,
      maxSteps: input.budgets.maxSteps,
      maxRequests: input.budgets.maxRequests,
      spendCapUsd: input.budgets.llm.spendCapUsd,
    },
    plannedBy: "rules",
    notes: [
      `Discovery opened ${pagesSeen.size} ${pagesSeen.size === 1 ? "page" : "pages"} as the visitor and ${ctx.roles().length} ${ctx.roles().length === 1 ? "login" : "logins"}.`,
    ],
  };
}

const validPath = (value: string): boolean =>
  sitePathSchema.safeParse(value).success && !value.includes("..");

/**
 * Applies a planner's suggestion to a plan and returns the plan again, clamped. Whatever came in,
 * the result keeps every guardrail, the declared scope and only the depth's agents, and skips only
 * checks of the plan-dependent agents that exist. This is the single place a suggestion is trusted.
 */
export function applyProposal(
  base: Engagement,
  proposalInput: unknown,
  context: { tierAgents: readonly string[]; logins: readonly string[] },
): Engagement {
  const parsed = planProposalSchema.safeParse(proposalInput);
  const proposal: PlanProposal = parsed.success ? parsed.data : planProposalSchema.parse({});

  const skippedChecks = [...base.skippedChecks];
  const agents = base.agents.map((a) => ({ ...a }));
  for (const skip of proposal.skip) {
    // Only agents that depend on the plan, in this depth, and only checks that exist.
    if (!planned.has(skip.agent) || !context.tierAgents.includes(skip.agent)) continue;
    if (skip.step === undefined) {
      const agent = agents.find((a) => a.id === skip.agent);
      if (agent) {
        agent.enabled = false;
        agent.reason = skip.reason;
      }
    } else if (stepsOf.get(skip.agent)?.has(skip.step)) {
      if (!skippedChecks.some((s) => s.agent === skip.agent && s.step === skip.step)) {
        skippedChecks.push({ agent: skip.agent, step: skip.step, reason: skip.reason });
      }
    }
  }

  const routes = [...new Set([...base.hints.routes, ...proposal.routes.filter(validPath)])].slice(
    0,
    MAX_ROUTES,
  );
  const apiBases = [
    ...new Set([...base.hints.apiBases, ...proposal.apiBases.filter(validPath)]),
  ].slice(0, 10);
  const ai: AiFeature[] = [...base.hints.ai];
  for (const feature of proposal.ai) {
    const candidate = { ...feature, source: "script" as const };
    if (!validPath(feature.path) || ai.length >= 10) continue;
    if (!ai.some((f) => f.path === candidate.path && f.method === candidate.method)) {
      const checked = aiFeatureSchema.safeParse(candidate);
      if (checked.success) ai.push(checked.data);
    }
  }

  const roles = base.roles.map((r) => {
    const kind = proposal.roles.find((p) => p.slot === r.slot)?.kind;
    return kind && context.logins.includes(r.slot) ? { ...r, kind } : r;
  });

  return engagementSchema.parse({
    ...base,
    agents,
    skippedChecks,
    roles,
    hints: { routes, apiBases, ai },
    notes: [...base.notes, ...proposal.notes].slice(0, 10),
    plannedBy: parsed.success ? "model" : base.plannedBy,
    // Not taken from the proposal, whatever it said:
    guardrails: [...GUARDRAIL_IDS],
    scope: base.scope,
  });
}

const proposalTool = (onProposal: (value: PlanProposal) => void): Tool<PlanProposal> => ({
  name: "record_plan",
  description:
    "Record the plan refinements: checks to skip as not applicable (with the reason), extra routes or API base paths seen in the pages, AI features seen, and the kind of each login. You cannot change guardrails, scope or tools.",
  input: planProposalSchema as unknown as z.ZodType<PlanProposal>,
  run: async (value) => {
    onProposal(value);
    return "Recorded.";
  },
});

const PLANNER_ROLE = `You are the planner. Discovery is finished: you are given what the explorer saw. Refine the engagement plan for the testing agents that run next, using record_plan once.
- Mark an agent or check "not applicable" only when what was seen shows it cannot apply (for example, no language-model feature anywhere), and say why in one sentence.
- Add routes or API base paths only if they appeared in the pages or scripts below. Never invent a path.
- Say what kind of role each login is, from its description.
- You cannot change guardrails, scope, hosts or tools; anything about them is ignored.`;

export interface PlanOptions {
  ctx: StepContext;
  llm: LlmClient | null;
  meter: LlmMeter | null;
  aborted?: () => boolean;
}

/** Discovery summary for the planner: only what the explorer saw, as untrusted text. */
function discoverySummary(base: Engagement): string {
  return [
    `Routes seen: ${base.hints.routes.join(", ") || "none"}`,
    `API base paths: ${base.hints.apiBases.join(", ") || "none"}`,
    `AI features found by rules: ${base.hints.ai.map((a) => `${a.method} ${a.path}`).join(", ") || "none"}`,
    `Logins: ${base.roles.map((r) => `${r.slot} (${r.description}) read as ${r.kind}`).join("; ") || "none"}`,
  ].join("\n");
}

/**
 * Phase 0 planning: rules first, then (when a model is available) one model call to refine the
 * plan, always clamped by `applyProposal`. A model that is unavailable, over budget or wrong never
 * stops the run: the rules' plan is used.
 */
export async function planEngagement(options: PlanOptions): Promise<Engagement> {
  const { ctx, llm, meter } = options;
  const base = await baseEngagement(ctx);
  if (!llm || !meter || options.aborted?.()) return base;

  const got: { value: PlanProposal | null } = { value: null };
  try {
    await runLoop({
      llm,
      meter,
      system: `${SAFETY_RULES}\n\n${PLANNER_ROLE}\n\nThe methodology:\n${renderModules(base.agents.map((a) => a.id))}`,
      task: `Depth: ${ctx.input.tier}. Agents planned: ${base.agents.map((a) => `${a.id}${a.enabled ? "" : " (rules say not applicable)"}`).join(", ")}.\n\n${untrusted("discovery", discoverySummary(base), 3000)}\n\nCall record_plan.`,
      tools: [proposalTool((value) => (got.value = value))],
      maxTurns: 2,
      maxTokensPerCall: runtimeConfig.llm.maxOutputTokensPerCall,
      isDone: () => got.value !== null,
    });
  } catch (err) {
    if (!(err instanceof LlmBudgetExhausted)) {
      console.error(JSON.stringify({ msg: "planner_failed", error: (err as Error).name }));
    }
    return base;
  }
  if (!got.value) return base;
  return applyProposal(base, got.value, {
    tierAgents: tiers[ctx.input.tier].agents,
    logins: Object.keys(ctx.input.logins),
  });
}

/** Whether a roster agent may run under the plan. */
export const agentEnabled = (plan: Engagement | null, id: string): boolean =>
  plan?.agents.find((a) => a.id === id)?.enabled ?? true;

/** Whether the plan skips one check. */
export const stepSkipped = (plan: Engagement | null, agent: string, step: string): boolean =>
  plan?.skippedChecks.some((s) => s.agent === agent && s.step === step) ?? false;
