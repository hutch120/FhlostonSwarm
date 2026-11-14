import { z } from "zod";
import learningJson from "../../config/learning.json" with { type: "json" };
import { areaIdSchema, severitySchema, tierIdSchema } from "../events.js";
import { sitePathSchema } from "../engagement.js";

/**
 * The dynamic layer (PLAN.md section 9): knowledge items and dynamic agents that a learning pass
 * revises after every run. Everything here is data. A dynamic agent is a declarative spec built
 * only from the read-only primitives below (a safe request with a response matcher, a header
 * assertion, a search of the scripts the pages load), so it inherits the scope proxy, the read-only
 * rule and the run's caps; nothing learned is code, a host, a tool or a limit.
 */

// Config ------------------------------------------------------------------------------------

const sourceConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/),
  name: z.string().min(1).max(80),
  url: z.url().refine((u) => u.startsWith("https://"), "sources are fetched over https"),
  /** `html` pages are reduced to text; `cisa-kev` is the KEV catalogue JSON, newest entries first. */
  kind: z.enum(["html", "cisa-kev"]),
  refreshHours: z.number().positive(),
  maxBytes: z.number().int().positive(),
});
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const learningConfigSchema = z.object({
  /** The kill switch in config: false makes every run use the baseline only and stops learning. */
  enabled: z.boolean(),
  /** The most capable Claude model the account can invoke; used by the learner only. */
  learnerModelId: z.string().min(1),
  /** Tried when the learner model cannot be invoked. */
  fallbackModelId: z.string().min(1),
  learner: z.object({
    timeoutSeconds: z.number().positive(),
    maxCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxTokensPerCall: z.number().int().positive(),
    spendCapUsd: z.number().positive(),
    maxDigestChars: z.number().int().positive(),
    maxSourceChars: z.number().int().positive(),
  }),
  limits: z.object({
    maxActiveItems: z.number().int().positive(),
    /** Dynamic agents in the layer (candidates and active). */
    maxDynamicAgents: z.number().int().positive(),
    maxChecksPerAgent: z.number().int().positive(),
    maxPathsPerCheck: z.number().int().positive(),
    maxChangesPerRun: z.number().int().positive(),
    /** Runs an item or agent may go without applying or firing before it is retired. */
    retireAfterRuns: z.number().int().positive(),
    /** Runs a candidate stays in shadow before it can be promoted. */
    shadowRuns: z.number().int().positive(),
    /** Retired entries kept in a snapshot (so a retired id is not proposed again). */
    maxRetained: z.number().int().nonnegative(),
    maxItemChars: z.number().int().positive(),
    itemsPerPrompt: z.number().int().positive(),
    /** The highest severity a learned check may raise; anything above is lowered to this. */
    maxSeverity: severitySchema,
  }),
  /** Dynamic agents one run may use, per depth: none in the shallow depths. */
  dynamicAgentsPerRun: z.record(tierIdSchema, z.number().int().nonnegative()),
  sources: z.array(sourceConfigSchema).min(1),
});
export type LearningConfig = z.infer<typeof learningConfigSchema>;

export const learningConfig: LearningConfig = learningConfigSchema.parse(learningJson);

// The dynamic layer ---------------------------------------------------------------------------

/** A technology or feature a thing applies to: one or two lower-case words; `any` applies to every run. */
export const tagSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9 .+#-]{0,29}$/, "expected a lower-case tag");
const appliesToSchema = z.array(tagSchema).min(1).max(8);

export const sourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  url: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const layerStatusSchema = z.enum(["candidate", "active", "retired"]);
export type LayerStatus = z.infer<typeof layerStatusSchema>;

const layerMeta = {
  status: layerStatusSchema,
  addedInVersion: z.number().int().positive(),
  /** Set by staff: never retired or replaced by the learner. */
  pinned: z.boolean().optional(),
  /** Set by staff: not used by any run. */
  disabled: z.boolean().optional(),
};

export const knowledgeItemSchema = z.object({
  id: z.string().regex(/^k-[a-z0-9-]{3,40}$/),
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().min(10).max(1000),
  appliesTo: appliesToSchema,
  source: sourceRefSchema,
  severityHint: severitySchema,
  ...layerMeta,
});
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

const needleSchema = z.string().trim().min(3).max(80);
const headerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, "expected a lower-case header name");

/** What a check says when it matches: the generic wording of the finding it raises. */
export const findingTemplateSchema = z.object({
  title: z.string().trim().min(5).max(100),
  severity: severitySchema,
  description: z.string().trim().min(20).max(500),
  remediation: z.string().trim().min(10).max(400),
  mapping: z.string().trim().max(100).optional(),
});
export type FindingTemplate = z.infer<typeof findingTemplateSchema>;

/** A response matcher: every condition given must hold, and at least one must look at content. */
export const matcherSchema = z
  .object({
    status: z.array(z.number().int().min(100).max(599)).max(5).optional(),
    headerPresent: z.array(headerNameSchema).max(4).optional(),
    headerIncludes: z
      .array(z.object({ name: headerNameSchema, value: needleSchema }))
      .max(4)
      .optional(),
    bodyIncludes: z.array(needleSchema).max(4).optional(),
  })
  .refine(
    (m) =>
      (m.headerPresent?.length ?? 0) +
        (m.headerIncludes?.length ?? 0) +
        (m.bodyIncludes?.length ?? 0) >
      0,
    "a status alone is too weak: match on a header or on the body as well",
  );
export type Matcher = z.infer<typeof matcherSchema>;

const checkId = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/);

/** A safe request (GET, HEAD or OPTIONS) for fixed generic paths of the application, and a matcher. */
export const probeCheckSchema = z.object({
  kind: z.literal("probe"),
  id: checkId,
  label: z.string().trim().min(3).max(80),
  method: z.enum(["GET", "HEAD", "OPTIONS"]),
  paths: z.array(sitePathSchema).min(1).max(12),
  match: matcherSchema,
  finding: findingTemplateSchema,
});

/** A header assertion on one page of the application. */
export const headerCheckSchema = z
  .object({
    kind: z.literal("header"),
    id: checkId,
    label: z.string().trim().min(3).max(80),
    path: sitePathSchema,
    header: headerNameSchema,
    raiseWhen: z.enum(["present", "absent", "includes", "excludes"]),
    value: needleSchema.optional(),
    finding: findingTemplateSchema,
  })
  .refine(
    (c) =>
      c.raiseWhen === "includes" || c.raiseWhen === "excludes" ? c.value !== undefined : true,
    "includes and excludes need a value",
  );

/** A search of the scripts the application's own pages load. */
export const scriptsCheckSchema = z.object({
  kind: z.literal("scripts"),
  id: checkId,
  label: z.string().trim().min(3).max(80),
  includes: z.array(needleSchema).min(1).max(6),
  finding: findingTemplateSchema,
});

export const dynamicCheckSchema = z.union([
  probeCheckSchema,
  headerCheckSchema,
  scriptsCheckSchema,
]);
export type DynamicCheck = z.infer<typeof dynamicCheckSchema>;

export const dynamicAgentSchema = z.object({
  id: z.string().regex(/^dyn-[a-z0-9-]{3,19}$/),
  title: z.string().trim().min(3).max(30),
  objective: z.string().trim().min(10).max(300),
  area: areaIdSchema,
  appliesTo: appliesToSchema,
  source: sourceRefSchema,
  checks: z.array(dynamicCheckSchema).min(1).max(8),
  ...layerMeta,
});
export type DynamicAgent = z.infer<typeof dynamicAgentSchema>;

export const snapshotSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  parent: z.number().int().positive().nullable(),
  reason: z.string().max(300),
  items: z.array(knowledgeItemSchema),
  agents: z.array(dynamicAgentSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** `learning/current.json`: which version runs use, and the kill switch. */
export const pointerSchema = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean(),
  updatedAt: z.iso.datetime(),
  by: z.string().min(1),
  note: z.string().max(300).optional(),
});
export type Pointer = z.infer<typeof pointerSchema>;

/** The slice of the layer a run is given (pinned when the run starts): what is in use, with its score. */
export const pinnedLayerSchema = z.object({
  version: z.number().int().positive(),
  items: z.array(knowledgeItemSchema.extend({ score: z.number() })),
  agents: z.array(dynamicAgentSchema.extend({ score: z.number() })),
});
export type PinnedLayer = z.infer<typeof pinnedLayerSchema>;

// What a run did with the layer -----------------------------------------------------------------

/** A finding a shadow agent would have raised: what-if evidence for the promotion gate. */
export const wouldRaiseSchema = z.object({
  agent: z.string(),
  check: z.string(),
  title: z.string(),
  component: z.string(),
});

/** Posted by the agent task as evidence `dynamic-results`; the learner folds it into the counters. */
export const dynamicResultsSchema = z.object({
  version: z.number().int().positive(),
  items: z.array(z.object({ id: z.string(), mode: z.enum(["active", "shadow"]) })),
  agents: z.array(
    z.object({
      id: z.string(),
      mode: z.enum(["active", "shadow"]),
      checks: z.number().int().nonnegative(),
      fired: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      /** Requests the scope proxy refused (the check tried to leave the scope). */
      outOfScope: z.number().int().nonnegative(),
      /** Findings the verifier could not confirm (active agents). */
      unconfirmed: z.number().int().nonnegative(),
    }),
  ),
  wouldRaise: z.array(wouldRaiseSchema).max(40),
});
export type DynamicResults = z.infer<typeof dynamicResultsSchema>;

// Counters and the gate (kept apart from the immutable snapshots) -------------------------------

export const itemStatSchema = z.object({
  applied: z.number().int().nonnegative(),
  lastRun: z.number().int().nonnegative(),
  score: z.number(),
});
export const agentStatSchema = z.object({
  shadowRuns: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  fires: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  outOfScope: z.number().int().nonnegative(),
  unconfirmed: z.number().int().nonnegative(),
  lastRun: z.number().int().nonnegative(),
  score: z.number(),
});

/** The synthetic-target regression a candidate must pass before it is promoted. */
export const gateSchema = z.object({
  passed: z.boolean(),
  /** The layer version the regression was run against. */
  version: z.number().int().positive(),
  runId: z.string().min(1),
  recordedAt: z.iso.datetime(),
  found: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  stray: z.number().int().nonnegative(),
});
export type Gate = z.infer<typeof gateSchema>;

export const statsSchema = z.object({
  /** Runs the layer has been told about. */
  runs: z.number().int().nonnegative(),
  items: z.record(z.string(), itemStatSchema),
  agents: z.record(z.string(), agentStatSchema),
  /** Per roster check (`agent.step`): runs seen and runs where its finding went unconfirmed. */
  checks: z.record(z.string(), z.object({ runs: z.number().int(), unconfirmed: z.number().int() })),
  /** Hash of each source's content the last learning pass has read. */
  sources: z.record(z.string(), z.object({ processedHash: z.string() })),
  gate: gateSchema.nullable(),
});
export type LearningStats = z.infer<typeof statsSchema>;
export type ItemStat = z.infer<typeof itemStatSchema>;
export type AgentStat = z.infer<typeof agentStatSchema>;

export const emptyStats = (): LearningStats => ({
  runs: 0,
  items: {},
  agents: {},
  checks: {},
  sources: {},
  gate: null,
});

// What the learner may propose ------------------------------------------------------------------

const sourceId = z.string().min(1).max(40);
const idReason = z.object({ id: z.string().max(60), reason: z.string().max(200) });

/** Only these fields exist: there is nothing in a proposal that can reach a guardrail, host, tool or limit. */
export const itemDraftSchema = z.object({
  id: knowledgeItemSchema.shape.id,
  title: knowledgeItemSchema.shape.title,
  description: knowledgeItemSchema.shape.description,
  appliesTo: appliesToSchema,
  sourceId,
  severityHint: severitySchema,
});
export const agentDraftSchema = z.object({
  id: dynamicAgentSchema.shape.id,
  title: dynamicAgentSchema.shape.title,
  objective: dynamicAgentSchema.shape.objective,
  area: areaIdSchema,
  appliesTo: appliesToSchema,
  sourceId,
  checks: z.array(dynamicCheckSchema).min(1).max(8),
});

export const learningProposalSchema = z.object({
  addItems: z.array(itemDraftSchema).max(6).default([]),
  reviseItems: z
    .array(
      z.object({
        id: knowledgeItemSchema.shape.id,
        title: knowledgeItemSchema.shape.title.optional(),
        description: knowledgeItemSchema.shape.description.optional(),
        appliesTo: appliesToSchema.optional(),
      }),
    )
    .max(6)
    .default([]),
  retireItems: z.array(idReason).max(6).default([]),
  addAgents: z.array(agentDraftSchema).max(3).default([]),
  retireAgents: z.array(idReason).max(3).default([]),
  /** Ids of items or agents that never fire for this kind of target: their score goes down. */
  lowerScore: z.array(idReason).max(6).default([]),
  notes: z.array(z.string().max(300)).max(3).default([]),
});
export type LearningProposal = z.infer<typeof learningProposalSchema>;

/** One entry of `learning/log/`: a proposal with what was decided and from which sources. */
export const learningLogSchema = z.object({
  at: z.iso.datetime(),
  trigger: z.enum(["run", "manual"]),
  model: z.string().nullable(),
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().nonnegative().nullable(),
  /** Hash and date of each source the pass read. */
  sources: z.array(z.object({ id: z.string(), hash: z.string(), fetchedAt: z.string() })),
  proposal: learningProposalSchema.nullable(),
  applied: z.array(z.string()),
  rejected: z.array(z.object({ what: z.string(), why: z.string() })),
  lifecycle: z.array(z.string()),
  outcome: z.enum(["changed", "unchanged", "skipped", "failed", "dry-run"]),
  note: z.string().max(300).optional(),
});
export type LearningLog = z.infer<typeof learningLogSchema>;
