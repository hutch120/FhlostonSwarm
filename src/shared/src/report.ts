import { z } from "zod";
import {
  areaIdSchema,
  findingSchema,
  runStatusSchema,
  severitySchema,
  summarySchema,
  tierIdSchema,
  SEVERITY_RANK,
  type RunEvent,
  type Severity,
  type Summary,
} from "./events.js";
import { appProfileSchema, type AppProfile } from "./app-profile.js";
import {
  INSTRUCTIONS_VERSION,
  dynamicUseSchema,
  roleKindSchema,
  type Engagement,
} from "./engagement.js";
import { AGENTS, AREAS } from "./fixtures/roster.js";
import { redactDeep, redactText, type RedactOptions } from "./redact.js";
import type { RunState } from "./reducer.js";
import { tiers } from "./tiers.js";

export const REPORT_DISCLAIMER =
  "This is an automated, AI-assisted security assessment. It has had no human review, is not a certification, and is not a substitute for a full manual penetration test. It covers only the checks listed as performed, and only what was reachable when it ran.";

/** The AI/LLM agents (phase 4 of the methodology). */
const AI_AGENTS = ["prompt", "output"];

const reportFindingSchema = findingSchema.extend({
  /** What the independent re-test said; `checked: false` when the depth does not run one. */
  verification: z.object({ checked: z.boolean(), note: z.string() }),
});

/**
 * The report as data (PLAN.md section 10): what the in-app report and the downloadable HTML and PDF
 * all render. Customer-facing, so it carries no cost figures. Numbers are computed from the events,
 * never generated, and every string has been through the redaction pass.
 */
export const runReportSchema = z.object({
  runId: z.string().min(1),
  /** Hostname of the application URL. */
  target: z.string().min(1),
  tier: tierIdSchema,
  generatedAt: z.iso.datetime(),
  status: runStatusSchema,
  summary: summarySchema,
  /** The instruction modules this run was planned and tested with. */
  instructionsVersion: z.string().min(1),
  /** The learned items and agents the run used (deep depths), with their sources; null when none. */
  dynamic: dynamicUseSchema.nullable(),
  findings: z.array(reportFindingSchema),
  /** Counts computed from the findings. */
  counts: z.object({
    total: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    unconfirmed: z.number().int().nonnegative(),
    bySeverity: z.record(severitySchema, z.number().int().nonnegative()),
  }),
  /** Checks that ran and found nothing. */
  passed: z.array(z.object({ agent: z.string(), stepId: z.string(), label: z.string() })),
  /** Observations that are not findings. */
  notes: z.array(z.object({ agent: z.string(), label: z.string(), note: z.string() })),
  /** Things the swarm could not test. */
  gaps: z.array(
    z.object({
      agent: z.string().nullable(),
      area: areaIdSchema.nullable(),
      reason: z.string(),
    }),
  ),
  /** Agents in this depth's group that did not finish, and why. */
  notRun: z.array(z.object({ agent: z.string(), name: z.string(), reason: z.string() })),
  /** Agents that belong to a deeper scan depth, so this run did not cover what they test. */
  notIncluded: z.array(
    z.object({ agent: z.string(), name: z.string(), area: areaIdSchema, covers: z.string() }),
  ),
  /** Every check of the depth by methodology phase, with how it ended. */
  phases: z.array(
    z.object({
      phase: z.number().int(),
      area: areaIdSchema,
      name: z.string(),
      summary: z.string(),
      checks: z.array(
        z.object({
          agent: z.string(),
          agentName: z.string(),
          stepId: z.string(),
          label: z.string(),
          outcome: z.enum(["clear", "info", "finding", "gap", "not-applicable", "not-run"]),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
  /** The AI/LLM testing outcome (section 5 of the report). */
  ai: z.object({
    status: z.enum(["not-included", "not-applicable", "tested"]),
    summary: z.string(),
    findings: z.array(z.string()),
  }),
  /** What to fix first: the findings by severity, confirmed ones ahead of unconfirmed at equal severity. */
  priorities: z.array(
    z.object({
      rank: z.number().int().positive(),
      findingId: z.string(),
      title: z.string(),
      severity: severitySchema,
      action: z.string(),
      confirmed: z.boolean(),
    }),
  ),
  /** What the plan decided (deep depths only). */
  plan: z
    .object({
      plannedBy: z.enum(["rules", "model"]),
      roles: z.array(z.object({ slot: z.string(), description: z.string(), kind: roleKindSchema })),
      notApplicable: z.array(
        z.object({
          agent: z.string(),
          name: z.string(),
          step: z.string().optional(),
          reason: z.string(),
        }),
      ),
      notes: z.array(z.string()),
    })
    .nullable(),
  /** What the explorer understood about the application; null when it could not be built. */
  profile: appProfileSchema.nullable(),
  disclaimer: z.string(),
});
export type RunReport = z.infer<typeof runReportSchema>;
export type ReportFinding = RunReport["findings"][number];

export interface ReportInput {
  state: RunState;
  events: readonly RunEvent[];
  /** The run's final summary (status, counts, coverage). */
  summary: Summary;
  target: string;
  generatedAt: string;
  profile?: AppProfile | null;
  /** The engagement plan of a deep run. */
  engagement?: Engagement | null;
  /** Secrets of the run (supplied passwords, session values) removed from every string. */
  redact?: RedactOptions;
}

const agentNames = new Map<string, string>(AGENTS.map((a) => [a.id, a.name]));

function describePlan(engagement: Engagement): NonNullable<RunReport["plan"]> {
  const notApplicable: NonNullable<RunReport["plan"]>["notApplicable"] = [
    ...engagement.agents
      .filter((a) => !a.enabled)
      .map((a) => ({
        agent: a.id,
        name: agentNames.get(a.id) ?? a.id,
        reason: a.reason ?? "Not applicable to this application.",
      })),
    ...engagement.skippedChecks.map((s) => ({
      agent: s.agent,
      name: agentNames.get(s.agent) ?? s.agent,
      step: s.step,
      reason: s.reason,
    })),
  ];
  return {
    plannedBy: engagement.plannedBy,
    roles: engagement.roles.map((r) => ({
      slot: r.slot,
      description: r.description,
      kind: r.kind,
    })),
    notApplicable,
    notes: engagement.notes,
  };
}

type Seen = { outcome: "clear" | "info" | "finding" | "gap"; detail?: string };

/** Builds the report data from a finished (or stopped) run's state and event log. */
export function buildReport(input: ReportInput): RunReport {
  const { state, events, target, generatedAt } = input;
  const group = tiers[state.tier].agents;
  const plan = input.engagement ? describePlan(input.engagement) : null;

  const passed: RunReport["passed"] = [];
  const notes: RunReport["notes"] = [];
  const outcomes = new Map<string, Seen>();
  const verdicts = new Map<string, { verified: boolean; note: string }>();
  for (const event of events) {
    if (event.type === "verify") {
      verdicts.set(event.payload.findingId, {
        verified: event.payload.verified,
        note: event.payload.note,
      });
      continue;
    }
    if (event.type !== "finish") continue;
    const { payload } = event;
    const detail =
      payload.outcome === "finding"
        ? payload.finding.id
        : payload.outcome === "gap"
          ? payload.reason
          : payload.outcome === "info"
            ? payload.note
            : undefined;
    outcomes.set(`${event.agent}/${payload.stepId}`, {
      outcome: payload.outcome,
      ...(detail ? { detail } : {}),
    });
    if (payload.outcome === "clear")
      passed.push({ agent: event.agent, stepId: payload.stepId, label: payload.label });
    else if (payload.outcome === "info")
      notes.push({ agent: event.agent, label: payload.label, note: payload.note });
  }

  const notRun: RunReport["notRun"] = [];
  for (const id of state.agentOrder) {
    const agent = state.agents[id]!;
    if (agent.status === "done") continue;
    // An agent with its own scope gap is already listed under the gaps; this is for the rest.
    if (state.gaps.some((g) => g.agent === id)) continue;
    notRun.push({
      agent: id,
      name: agent.spec.name,
      reason:
        agent.status === "idle"
          ? "It was not run."
          : "The run ended before this agent finished its checks.",
    });
  }

  const skippedBy = (agent: string, step: string): string | null => {
    const hit = plan?.notApplicable.find(
      (n) => n.agent === agent && (n.step === undefined || n.step === step),
    );
    return hit?.reason ?? null;
  };

  const rosterPhases: RunReport["phases"] = AREAS.flatMap((area) => {
    const agents = AGENTS.filter((a) => a.area === area.id && group.includes(a.id));
    if (agents.length === 0) return [];
    return [
      {
        phase: area.phase,
        area: area.id,
        name: area.name,
        summary: area.summary,
        checks: agents.flatMap((agent) =>
          agent.steps.map((step): RunReport["phases"][number]["checks"][number] => {
            const base = {
              agent: agent.id,
              agentName: agent.name,
              stepId: step.id,
              label: step.label,
            };
            const seen = outcomes.get(`${agent.id}/${step.id}`);
            if (seen) return { ...base, outcome: seen.outcome, detail: seen.detail };
            const skipped = skippedBy(agent.id, step.id);
            if (skipped) return { ...base, outcome: "not-applicable", detail: skipped };
            return { ...base, outcome: "not-run" };
          }),
        ),
      },
    ];
  });

  const phases: RunReport["phases"] = [...rosterPhases];
  for (const id of state.agentOrder) {
    const agent = state.agents[id]!;
    if (agentNames.has(id)) continue;
    // A dynamic agent: its checks sit in the phase of its area, like any other agent's.
    let phase = phases.find((p) => p.area === agent.spec.area);
    if (!phase) {
      const area = AREAS.find((a) => a.id === agent.spec.area)!;
      phase = {
        phase: area.phase,
        area: area.id,
        name: area.name,
        summary: area.summary,
        checks: [],
      };
      phases.push(phase);
      phases.sort((a, b) => a.phase - b.phase);
    }
    for (const step of agent.spec.steps) {
      const seen = outcomes.get(`${id}/${step.id}`);
      phase.checks.push({
        agent: id,
        agentName: agent.spec.name,
        stepId: step.id,
        label: step.label,
        outcome: seen?.outcome ?? "not-run",
        ...(seen?.detail ? { detail: seen.detail } : {}),
      });
    }
  }

  const findings: ReportFinding[] = state.findings.map((f) => {
    const verdict = verdicts.get(f.id);
    return {
      ...f,
      verification: verdict
        ? { checked: true, note: verdict.note }
        : { checked: false, note: "Not cross-checked at this scan depth." },
    };
  });

  const bySeverity = Object.fromEntries(
    severitySchema.options.map((s) => [s, findings.filter((f) => f.severity === s).length]),
  ) as Record<Severity, number>;

  const aiIncluded = AI_AGENTS.filter((a) => group.includes(a));
  const aiFindings = findings.filter((f) => AI_AGENTS.includes(f.agent)).map((f) => f.id);
  const aiSkipped = plan?.notApplicable.filter((n) => AI_AGENTS.includes(n.agent) && !n.step) ?? [];
  const ai: RunReport["ai"] =
    aiIncluded.length === 0
      ? {
          status: "not-included",
          summary:
            "AI/LLM testing is not included at this scan depth. A deeper scan tests prompt injection, system prompt disclosure and unsafe handling of model output.",
          findings: [],
        }
      : aiSkipped.length === aiIncluded.length
        ? {
            status: "not-applicable",
            summary: `Not applicable: ${aiSkipped[0]!.reason}`,
            findings: [],
          }
        : {
            status: "tested",
            summary:
              aiFindings.length === 0
                ? "The AI/LLM features that could be reached were tested and none of the checks raised an issue."
                : `The AI/LLM checks raised ${aiFindings.length} ${aiFindings.length === 1 ? "issue" : "issues"} (${aiFindings.join(", ")}).`,
            findings: aiFindings,
          };

  const confirmed = (f: ReportFinding) => f.status !== "unconfirmed";
  const priorities: RunReport["priorities"] = findings
    .filter((f) => f.severity !== "info")
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Number(confirmed(b)) - Number(confirmed(a)) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 10)
    .map((f, i) => ({
      rank: i + 1,
      findingId: f.id,
      title: f.title,
      severity: f.severity,
      action: f.remediation,
      confirmed: confirmed(f),
    }));

  const summary = input.summary;
  const report: RunReport = {
    runId: state.runId,
    target,
    tier: state.tier,
    generatedAt,
    status: summary.status,
    summary,
    instructionsVersion: input.engagement?.instructionsVersion ?? INSTRUCTIONS_VERSION,
    dynamic:
      input.engagement && input.engagement.dynamic.version !== null
        ? input.engagement.dynamic
        : null,
    findings,
    counts: {
      total: findings.length,
      verified: findings.filter((f) => f.verified).length,
      unconfirmed: findings.filter((f) => f.status === "unconfirmed").length,
      bySeverity,
    },
    passed,
    notes,
    gaps: state.gaps.map((g) => ({ agent: g.agent, area: g.area, reason: g.reason })),
    notRun,
    notIncluded: AGENTS.filter((a) => !group.includes(a.id)).map((a) => ({
      agent: a.id,
      name: a.name,
      area: a.area,
      covers: a.steps.map((s) => s.label).join("; "),
    })),
    phases,
    ai,
    priorities,
    plan,
    profile: input.profile ?? null,
    disclaimer: REPORT_DISCLAIMER,
  };

  // Scrub every string, and mask personal addresses in the evidence excerpts.
  const options = input.redact ?? {};
  const scrubbed = redactDeep(report, options);
  scrubbed.findings = scrubbed.findings.map((f) => ({
    ...f,
    ...(f.evidence
      ? { evidence: f.evidence.map((e) => redactText(e, { ...options, emails: true })) }
      : {}),
  }));
  return scrubbed;
}
