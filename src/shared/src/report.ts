import { z } from "zod";
import {
  areaIdSchema,
  findingSchema,
  runStatusSchema,
  summarySchema,
  tierIdSchema,
  type RunEvent,
  type Summary,
} from "./events.js";
import { appProfileSchema, type AppProfile } from "./app-profile.js";
import { AGENTS } from "./fixtures/roster.js";
import type { RunState } from "./reducer.js";
import { tiers } from "./tiers.js";

export const REPORT_DISCLAIMER =
  "This is an automated, AI-assisted security assessment. It has had no human review, is not a certification, and is not a substitute for a full manual penetration test. It covers only the checks listed as performed, and only what was reachable when it ran.";

/**
 * The report as data (PLAN.md section 10): what the in-app report and the downloadable HTML both
 * render. Customer-facing, so it carries no cost figures. Numbers are computed from the events,
 * never generated.
 */
export const runReportSchema = z.object({
  runId: z.string().min(1),
  /** Hostname of the application URL. */
  target: z.string().min(1),
  tier: tierIdSchema,
  generatedAt: z.iso.datetime(),
  status: runStatusSchema,
  summary: summarySchema,
  findings: z.array(findingSchema),
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
  /** What the explorer understood about the application; null when it could not be built. */
  profile: appProfileSchema.nullable(),
  disclaimer: z.string(),
});
export type RunReport = z.infer<typeof runReportSchema>;

export interface ReportInput {
  state: RunState;
  events: readonly RunEvent[];
  /** The run's final summary (status, counts, coverage). */
  summary: Summary;
  target: string;
  generatedAt: string;
  profile?: AppProfile | null;
}

/** Builds the report data from a finished (or stopped) run's state and event log. */
export function buildReport(input: ReportInput): RunReport {
  const { state, events, target, generatedAt } = input;
  const passed: RunReport["passed"] = [];
  const notes: RunReport["notes"] = [];
  for (const event of events) {
    if (event.type !== "finish") continue;
    const { payload } = event;
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

  const summary = input.summary;
  return {
    runId: state.runId,
    target,
    tier: state.tier,
    generatedAt,
    status: summary.status,
    summary,
    findings: state.findings,
    passed,
    notes,
    gaps: state.gaps.map((g) => ({ agent: g.agent, area: g.area, reason: g.reason })),
    notRun,
    notIncluded: AGENTS.filter((a) => !tiers[state.tier].agents.includes(a.id)).map((a) => ({
      agent: a.id,
      name: a.name,
      area: a.area,
      covers: a.steps.map((s) => s.label).join("; "),
    })),
    profile: input.profile ?? null,
    disclaimer: REPORT_DISCLAIMER,
  };
}
