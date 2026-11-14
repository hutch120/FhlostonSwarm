import { z } from "zod";
import pricingJson from "../config/pricing.json" with { type: "json" };
import runtimeJson from "../config/runtime.json" with { type: "json" };
import { tierIdSchema } from "./events.js";

/** Runtime knobs for the run infrastructure (task size, timeouts, reaper). Edit config/runtime.json. */
export const runtimeConfigSchema = z.object({
  agentTask: z.object({ vcpu: z.number().positive(), memoryGb: z.number().positive() }),
  /** Added to a tier's wall-clock limit to get the task's hard timeout. */
  taskTimeoutMarginSeconds: z.number().int().nonnegative(),
  reaper: z.object({
    intervalMinutes: z.number().int().positive(),
    /** A task older than the tier's wall clock plus this is stopped by the reaper. */
    graceMinutes: z.number().int().nonnegative(),
  }),
  streamTokenMinutes: z.number().positive(),
  proxyPort: z.number().int().min(1024).max(65535),
  /** Per-depth concurrency pools: a run that finds its pool full waits, then is declined. */
  pool: z.object({
    pollSeconds: z.number().int().positive(),
    queueTimeoutMinutes: z.number().positive(),
  }),
  llm: z.object({
    maxOutputTokensPerCall: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryBaseMs: z.number().int().positive(),
  }),
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export const runtimeConfig: RuntimeConfig = runtimeConfigSchema.parse(runtimeJson);

/**
 * The price table behind the staff-only cost estimate. Values are estimates to be checked against
 * current AWS prices (`verified`); the table is versioned so a run keeps the prices it was costed with.
 */
export const pricingSchema = z.object({
  version: z.string().min(1),
  verified: z.boolean(),
  currency: z.literal("USD"),
  fargate: z.object({ vcpuPerHour: z.number().nonnegative(), gbPerHour: z.number().nonnegative() }),
  egressPerGb: z.number().nonnegative(),
  stepFunctionsPerTransition: z.number().nonnegative(),
  /** Per model id, in USD per million tokens. */
  bedrock: z.record(
    z.string(),
    z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }),
  ),
});
export type Pricing = z.infer<typeof pricingSchema>;
export const pricing: Pricing = pricingSchema.parse(pricingJson);

/** What a model call costs from the price table; an unpriced model is an error, not free. */
export function bedrockUsd(
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number },
  table: Pricing = pricing,
): number {
  const price = table.bedrock[modelId];
  if (!price) throw new Error(`no Bedrock price for ${modelId}`);
  return (
    (tokens.inputTokens * price.inputPerMTok + tokens.outputTokens * price.outputPerMTok) / 1e6
  );
}

/** The model usage an agent task reports as evidence when it finishes; it feeds `cost.json`. */
export const llmUsageSchema = z.object({
  modelId: z.string().min(1),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

/** What the post-run learning pass used: tokens and seconds, priced like any other model call. */
export const learnerCostSchema = llmUsageSchema.extend({ seconds: z.number().nonnegative() });
export type LearnerCost = z.infer<typeof learnerCostSchema>;

/** What one run consumed and what we estimate it cost. Staff only: never part of a customer response. */
export const runCostSchema = z.object({
  test: z.boolean().optional(),
  runId: z.string().min(1),
  tier: tierIdSchema,
  pricingVersion: z.string().min(1),
  pricingVerified: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationSeconds: z.number().nonnegative(),
  fargate: z.object({
    taskSeconds: z.number().nonnegative(),
    vcpu: z.number().positive(),
    memoryGb: z.number().positive(),
    usd: z.number().nonnegative(),
  }),
  egress: z.object({
    bytesOut: z.number().int().nonnegative(),
    bytesIn: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  /** Zero when the run used no model. */
  bedrock: z.object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  orchestration: z.object({
    stateTransitions: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  requests: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  /** The learning pass that reviewed the run, added once it has finished (its own line for staff). */
  learner: learnerCostSchema.optional(),
  totalUsd: z.number().nonnegative(),
});
export type RunCost = z.infer<typeof runCostSchema>;

/** Adds the learner's own line to a run's cost, and to its total. */
export function withLearnerCost(cost: RunCost, learner: LearnerCost): RunCost {
  const had = cost.learner?.usd ?? 0;
  return {
    ...cost,
    learner,
    totalUsd: Math.round((cost.totalUsd - had + learner.usd) * 1e6) / 1e6,
  };
}

export interface CostInputs {
  runId: string;
  tier: z.infer<typeof tierIdSchema>;
  test?: boolean;
  startedAt: string;
  finishedAt: string;
  taskSeconds: number;
  bytesOut: number;
  bytesIn: number;
  requests: number;
  checks: number;
  bedrock?: { calls: number; inputTokens: number; outputTokens: number; usd?: number };
  /** Fargate size; defaults to the configured agent task. */
  task?: { vcpu: number; memoryGb: number };
}

/** Fargate bills a minimum of one minute per task. */
const MIN_TASK_SECONDS = 60;
/** Create, prepare, run, finalize and a couple of retries: a generous fixed count. */
const STATE_TRANSITIONS = 8;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The cost estimate for one run, from what it consumed and the price table. */
export function estimateCost(
  inputs: CostInputs,
  table: Pricing = pricing,
  task = inputs.task ?? runtimeConfig.agentTask,
): RunCost {
  const seconds = inputs.taskSeconds > 0 ? Math.max(MIN_TASK_SECONDS, inputs.taskSeconds) : 0;
  const hours = seconds / 3600;
  const fargateUsd =
    hours * (task.vcpu * table.fargate.vcpuPerHour + task.memoryGb * table.fargate.gbPerHour);
  const egressUsd = (inputs.bytesOut / 1024 ** 3) * table.egressPerGb;
  const bedrock = inputs.bedrock ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  const bedrockUsd = bedrock.usd ?? 0;
  const orchestrationUsd = STATE_TRANSITIONS * table.stepFunctionsPerTransition;
  const durationSeconds = Math.max(
    0,
    (Date.parse(inputs.finishedAt) - Date.parse(inputs.startedAt)) / 1000,
  );
  return {
    ...(inputs.test ? { test: true } : {}),
    runId: inputs.runId,
    tier: inputs.tier,
    pricingVersion: table.version,
    pricingVerified: table.verified,
    startedAt: inputs.startedAt,
    finishedAt: inputs.finishedAt,
    durationSeconds,
    fargate: {
      taskSeconds: seconds,
      vcpu: task.vcpu,
      memoryGb: task.memoryGb,
      usd: round(fargateUsd),
    },
    egress: { bytesOut: inputs.bytesOut, bytesIn: inputs.bytesIn, usd: round(egressUsd) },
    bedrock: {
      calls: bedrock.calls,
      inputTokens: bedrock.inputTokens,
      outputTokens: bedrock.outputTokens,
      usd: round(bedrockUsd),
    },
    orchestration: { stateTransitions: STATE_TRANSITIONS, usd: round(orchestrationUsd) },
    requests: inputs.requests,
    checks: inputs.checks,
    totalUsd: round(fargateUsd + egressUsd + bedrockUsd + orchestrationUsd),
  };
}
