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

/** `unverified`: not cross-checked yet. `unconfirmed`: an independent re-test could not reproduce it. */
export const findingStatusSchema = z.enum(["unverified", "unconfirmed", "open", "accepted"]);
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
  /** What an attacker gains, when the description does not say. */
  impact: z.string().max(600).optional(),
  /** Short excerpts of what was observed (never credentials, tokens or cookies). */
  evidence: z.array(z.string().max(600)).max(6).optional(),
  /** Steps to reproduce it by hand. */
  reproduction: z.array(z.string().max(300)).max(8).optional(),
  /** A finding is a candidate (unverified) until an independent agent cross-checks it. */
  verified: z.boolean(),
  status: findingStatusSchema,
});
export type Finding = z.infer<typeof findingSchema>;

export const stepOutcomeSchema = z.enum(["clear", "info", "finding", "gap"]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export const runStatusSchema = z.enum(["queued", "running", "complete", "stopped", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Scan depth, shallowest first. A tier is a group of agents (config/tiers.json). */
export const tierIdSchema = z.enum(["scout", "sweep", "probe", "siege"]);
export type TierId = z.infer<typeof tierIdSchema>;
export const TIER_IDS = tierIdSchema.options;

export const summarySchema = z.object({
  runId: z.string().min(1),
  status: runStatusSchema,
  tier: tierIdSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  durationMs: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  /** 0..1 share of the planned work for this run's scope that has been covered. */
  coverage: z.number().min(0).max(1),
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

/** Per-step activity shown to the customer. Dollar cost is deliberately not part of this stream. */
const costFields = {
  requests: z.number().int().nonnegative(),
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
  payload: z.object({
    task: z.string().min(1),
    /** Sent with the first dispatch of an agent that is not in the depth's roster (a dynamic agent). */
    spec: agentSpecSchema.optional(),
  }),
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
  gapEventSchema,
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

/**
 * What an agent task emits. It has no `seq`: the events API is the single sequencer for a run, so
 * several agents can write at once. `complete` comes from the platform, never from an agent task.
 */
export const agentEventSchema = z.discriminatedUnion("type", [
  dispatchEventSchema.omit({ seq: true }),
  startEventSchema.omit({ seq: true }),
  finishEventSchema.omit({ seq: true }),
  verifyEventSchema.omit({ seq: true }),
  agentDoneEventSchema.omit({ seq: true }),
  gapEventSchema.omit({ seq: true }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** A batch of agent events. `batchId` makes a retried POST idempotent. */
export const eventBatchSchema = z.object({
  batchId: z.string().regex(/^[0-9a-z-]{8,64}$/, "expected a lowercase id"),
  events: z.array(agentEventSchema).min(1).max(100),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** Gives an agent event its place in the run's stream. */
export const stampEvent = (event: AgentEvent, seq: number): RunEvent =>
  runEventSchema.parse({ ...event, seq });
