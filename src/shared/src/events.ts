import { z } from "zod";

/**
 * The event contract between the swarm backend and the UI (PLAN.md section 1).
 * Every consumer (live view, replay, report, scheduled-run diffs) derives from RunEvent.
 */

export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;
export const SEVERITIES = severitySchema.options;

/** Higher is worse. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const areaIdSchema = z.enum(["recon", "unauth", "authn", "llm", "logic"]);
export type AreaId = z.infer<typeof areaIdSchema>;

/** Agent ids are open strings so later phases can add agents (explorer, verifier) without a contract change. */
export const agentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,23}$/, "expected a lowercase agent id");
export type AgentId = z.infer<typeof agentIdSchema>;

export const agentFaceSchema = z.enum(["visor", "round", "cyclops", "hex", "ears"]);
export type AgentFace = z.infer<typeof agentFaceSchema>;

const hexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

export const stepSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type StepSpec = z.infer<typeof stepSpecSchema>;

export const agentSpecSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  area: areaIdSchema,
  colour: hexColourSchema,
  face: agentFaceSchema,
  /** The checks this agent can run; progress is steps finished over steps planned. */
  steps: z.array(stepSpecSchema).min(1),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

export const areaSpecSchema = z.object({
  id: areaIdSchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  colour: hexColourSchema,
  /** Maps to the numbered phases in docs/instructions. */
  phase: z.number().int().min(1).max(5),
});
export type AreaSpec = z.infer<typeof areaSpecSchema>;

export const findingStatusSchema = z.enum(["unverified", "open", "accepted"]);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const findingSchema = z.object({
  id: z.string().regex(/^F-\d{2,}$/, "expected F-NN"),
  title: z.string().min(1),
  severity: severitySchema,
  area: areaIdSchema,
  agent: agentIdSchema,
  component: z.string().min(1),
  description: z.string().min(1),
  remediation: z.string().min(1),
  /** OWASP / LLM Top 10 mapping, when there is one. */
  mapping: z.string().optional(),
  /** A finding is a candidate (unverified) until an independent agent cross-checks it. */
  verified: z.boolean(),
  status: findingStatusSchema,
});
export type Finding = z.infer<typeof findingSchema>;

export const stepOutcomeSchema = z.enum(["clear", "info", "finding", "gap"]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export const runStatusSchema = z.enum(["queued", "running", "complete", "stopped", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const tierIdSchema = z.enum(["lite", "full"]);
export type TierId = z.infer<typeof tierIdSchema>;

export const summarySchema = z.object({
  runId: z.string().min(1),
  status: runStatusSchema,
  tier: tierIdSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  durationMs: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  spendUsd: z.number().nonnegative(),
  findings: z.object({
    total: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    bySeverity: z.record(severitySchema, z.number().int().nonnegative()),
  }),
  gaps: z.number().int().nonnegative(),
  agents: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
});
export type Summary = z.infer<typeof summarySchema>;

const baseEvent = {
  /** Strictly increasing per run; the consumer drops anything at or below the last applied seq. */
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  runId: z.string().min(1),
};

const stepRef = {
  stepId: z.string().min(1),
  label: z.string().min(1),
};

/** Optional cost telemetry attached to finished steps; feeds the budget meter. */
const costFields = {
  requests: z.number().int().nonnegative(),
  spendUsd: z.number().nonnegative(),
};

const finishPayloadSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("clear"), ...stepRef, ...costFields }),
  z.object({ outcome: z.literal("info"), ...stepRef, ...costFields, note: z.string().min(1) }),
  z.object({ outcome: z.literal("finding"), ...stepRef, ...costFields, finding: findingSchema }),
  z.object({ outcome: z.literal("gap"), ...stepRef, ...costFields, reason: z.string().min(1) }),
]);

export const dispatchEventSchema = z.object({
  ...baseEvent,
  type: z.literal("dispatch"),
  agent: agentIdSchema,
  payload: z.object({ task: z.string().min(1) }),
});

export const startEventSchema = z.object({
  ...baseEvent,
  type: z.literal("start"),
  agent: agentIdSchema,
  payload: z.object(stepRef),
});

export const finishEventSchema = z.object({
  ...baseEvent,
  type: z.literal("finish"),
  agent: agentIdSchema,
  payload: finishPayloadSchema,
});

export const verifyEventSchema = z.object({
  ...baseEvent,
  type: z.literal("verify"),
  /** The agent that performed the independent cross-check. */
  agent: agentIdSchema,
  payload: z.object({
    findingId: z.string().regex(/^F-\d{2,}$/),
    verified: z.boolean(),
    note: z.string().min(1),
  }),
});

export const agentDoneEventSchema = z.object({
  ...baseEvent,
  type: z.literal("agent-done"),
  agent: agentIdSchema,
  payload: z.object({ summary: z.string().min(1) }),
});

export const completeEventSchema = z.object({
  ...baseEvent,
  type: z.literal("complete"),
  agent: z.null(),
  payload: z.object({ summary: summarySchema }),
});

export const steerEventSchema = z.object({
  ...baseEvent,
  type: z.literal("steer"),
  /** The agent the message is aimed at; null is addressed to the whole swarm. */
  agent: agentIdSchema.nullable(),
  payload: z.object({ message: z.string().min(1), directive: z.string().min(1).optional() }),
});

/** A scope limitation: something the swarm could not test, reported as such. */
export const gapEventSchema = z.object({
  ...baseEvent,
  type: z.literal("gap"),
  agent: agentIdSchema.nullable(),
  payload: z.object({ reason: z.string().min(1), area: areaIdSchema.optional() }),
});

export const runEventSchema = z.discriminatedUnion("type", [
  dispatchEventSchema,
  startEventSchema,
  finishEventSchema,
  verifyEventSchema,
  agentDoneEventSchema,
  completeEventSchema,
  steerEventSchema,
  gapEventSchema,
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
