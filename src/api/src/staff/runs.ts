import {
  tiers,
  type EntitlementSource,
  type StaffAgentActivity,
  type StaffBudgetLine,
  type StaffRunCost,
  type StaffRunDetail,
  type StaffRunRow,
  type RunEvent,
  type TierId,
} from "@swarm/shared";
import { runCostSchema, type RunCost, type TierLimits } from "@swarm/shared/server";
import { getSequencer, readAllEvents } from "../events.js";
import { getRunFile, listRunFiles, type RunFile } from "../runs.js";
import { effectiveLimits } from "../settings.js";
import { getJson } from "../storage/json.js";
import { keys } from "../storage/keys.js";
import type { ObjectStore } from "../storage/store.js";
import { entitlementOf, costOf, type IndexRecord } from "./index-records.js";

/** The accounts that exist: the hash folders under `users/`. */
export async function listAccountHashes(store: ObjectStore): Promise<string[]> {
  return (await store.folders("users/"))
    .map((folder) => folder.slice("users/".length).replace(/\/$/, ""))
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
}

/** When a run was created, read from its id (`run_<time in base 36><random>`); null for an odd id. */
export function runCreatedAt(runId: string): number | null {
  const ms = Number.parseInt(runId.slice(4, 13), 36);
  return Number.isFinite(ms) ? ms : null;
}

export interface OwnedRun {
  emailHash: string;
  file: RunFile;
}

/**
 * Runs that were created within `sinceMs` of now, across every account: the ones that may still be
 * going. A run's id carries its creation time, so older runs are skipped without being read.
 */
export async function recentRuns(
  store: ObjectStore,
  now: number,
  sinceMs: number,
): Promise<OwnedRun[]> {
  const found: OwnedRun[] = [];
  for (const emailHash of await listAccountHashes(store)) {
    const folders = await store.folders(keys.runsPrefix(emailHash));
    const recent = folders.filter((folder) => {
      const created = runCreatedAt(folder.slice(keys.runsPrefix(emailHash).length));
      return created === null || now - created <= sinceMs;
    });
    const files = await Promise.all(
      recent.map((folder) => {
        const runId = folder.slice(keys.runsPrefix(emailHash).length).replace(/\/$/, "");
        return getRunFile(store, emailHash, runId);
      }),
    );
    for (const file of files) if (file) found.push({ emailHash, file });
  }
  return found;
}

/** The account that owns a run, found by looking for its summary under every account. */
export async function findRunOwner(store: ObjectStore, runId: string): Promise<string | null> {
  for (const emailHash of await listAccountHashes(store)) {
    if (await store.get(keys.runSummary(emailHash, runId))) return emailHash;
  }
  return null;
}

const rowEntitlement = (file: RunFile): EntitlementSource =>
  entitlementOf({ entitlement: file.entitlement, creditSource: file.creditSource });

/** A run that is still going, as a row of the Runs table. */
export function liveRow(file: RunFile): StaffRunRow {
  return {
    runId: file.runId,
    tier: file.tier,
    trigger: file.trigger,
    entitlement: rowEntitlement(file),
    status: file.status,
    startedAt: file.startedAt,
    finishedAt: null,
    durationSeconds: Math.round(file.durationMs / 1000),
    findings: file.findings.total,
    costUsd: null,
    live: true,
    test: file.test === true,
  };
}

/** A closed run, from the anonymised index. */
export function closedRow(record: IndexRecord): StaffRunRow {
  return {
    runId: record.runId,
    tier: record.tier,
    trigger: record.trigger,
    entitlement: entitlementOf(record),
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationSeconds: Math.round(record.durationSeconds),
    findings: record.findings.total,
    costUsd: costOf(record, null).totalUsd,
    live: false,
    test: record.test === true,
  };
}

const text = (event: RunEvent): string => {
  switch (event.type) {
    case "dispatch":
      return event.payload.task;
    case "start":
      return event.payload.label;
    case "finish":
      return `${event.payload.outcome}: ${event.payload.label}`;
    case "verify":
      return `${event.payload.findingId} ${event.payload.verified ? "confirmed" : "unconfirmed"}: ${event.payload.note}`;
    case "agent-done":
      return event.payload.summary;
    case "gap":
      return event.payload.reason;
    case "complete":
      return `run ${event.payload.summary.status}`;
  }
};

const MAX_EVENTS = 300;

function costView(cost: RunCost): StaffRunCost {
  return {
    pricingVersion: cost.pricingVersion,
    pricingVerified: cost.pricingVerified,
    totalUsd: cost.totalUsd,
    fargate: { usd: cost.fargate.usd, taskSeconds: cost.fargate.taskSeconds },
    egress: { usd: cost.egress.usd, bytesOut: cost.egress.bytesOut },
    bedrock: {
      usd: cost.bedrock.usd,
      calls: cost.bedrock.calls,
      inputTokens: cost.bedrock.inputTokens,
      outputTokens: cost.bedrock.outputTokens,
      modelId: cost.bedrock.modelId ?? null,
    },
    orchestration: { usd: cost.orchestration.usd },
    learner: cost.learner
      ? {
          usd: cost.learner.usd,
          seconds: cost.learner.seconds,
          calls: cost.learner.calls,
          inputTokens: cost.learner.inputTokens,
          outputTokens: cost.learner.outputTokens,
          modelId: cost.learner.modelId,
        }
      : null,
  };
}

/** What the run used against the depth's caps as they are now. */
function budgetLines(limits: TierLimits, file: RunFile, cost: RunCost | null): StaffBudgetLine[] {
  const wall = tiers[file.tier].wallClockMinutes * 60;
  return [
    { name: "Time", used: Math.round(file.durationMs / 1000), cap: Math.round(wall), unit: "s" },
    { name: "Checks", used: file.checks, cap: limits.stepCap, unit: "checks" },
    { name: "Requests", used: file.requests, cap: limits.requestCap, unit: "requests" },
    ...(cost
      ? [
          {
            name: "Model calls",
            used: cost.bedrock.calls,
            cap: limits.llmStepCap,
            unit: "calls",
          },
          {
            name: "Input tokens",
            used: cost.bedrock.inputTokens,
            cap: limits.tokenCap?.input ?? null,
            unit: "tokens",
          },
          {
            name: "Output tokens",
            used: cost.bedrock.outputTokens,
            cap: limits.tokenCap?.output ?? null,
            unit: "tokens",
          },
          { name: "Model spend", used: cost.bedrock.usd, cap: limits.spendCapUsd, unit: "USD" },
        ]
      : []),
  ];
}

/** Everything staff see about one run: its cost, caps, agents, gaps and event log. */
export async function runDetail(
  store: ObjectStore,
  emailHash: string,
  runId: string,
): Promise<StaffRunDetail | null> {
  const file = await getRunFile(store, emailHash, runId);
  if (!file) return null;
  const [cost, events, sequencer, report, limits] = await Promise.all([
    getJson(store, keys.runCost(emailHash, runId), runCostSchema).catch(() => null),
    readAllEvents(store, { emailHash, runId }),
    getSequencer(store, { emailHash, runId, tier: file.tier, test: file.test }),
    store.get(keys.runReportData(emailHash, runId)),
    effectiveLimits(store, file.tier),
  ]);
  const activity = new Map<string, StaffAgentActivity>();
  const row = (agent: string): StaffAgentActivity => {
    let found = activity.get(agent);
    if (!found) {
      found = {
        agent,
        name: sequencer.run.agents[agent]?.spec.name ?? agent,
        steps: 0,
        requests: 0,
        findings: 0,
        gaps: 0,
        done: false,
      };
      activity.set(agent, found);
    }
    return found;
  };
  for (const event of events) {
    if (event.type === "finish") {
      const a = row(event.agent);
      a.steps += 1;
      a.requests += event.payload.requests;
      if (event.payload.outcome === "finding") a.findings += 1;
      if (event.payload.outcome === "gap") a.gaps += 1;
    } else if (event.type === "agent-done") {
      row(event.agent).done = true;
    } else if (event.type === "dispatch") {
      row(event.agent);
    }
  }

  const reportData = report ? (JSON.parse(report.body) as Record<string, unknown>) : null;
  const dynamic = (reportData?.["dynamic"] as { version?: number } | null | undefined)?.version;
  const tail = events.slice(-MAX_EVENTS);
  return {
    runId,
    accountHash: emailHash,
    tier: file.tier,
    status: file.status,
    trigger: file.trigger,
    entitlement: rowEntitlement(file),
    test: file.test === true,
    target: file.target,
    startedAt: file.startedAt,
    finishedAt: file.finishedAt ?? null,
    durationSeconds: Math.round(file.durationMs / 1000),
    reason: file.reason ?? null,
    summary: {
      checks: file.checks,
      requests: file.requests,
      coverage: file.coverage,
      gaps: file.gaps,
      findings: file.findings,
      agents: file.agents,
    },
    cost: cost ? costView(cost.value) : null,
    budgets: budgetLines(limits, file, cost?.value ?? null),
    agents: [...activity.values()],
    gaps: sequencer.run.gaps.map((g) => ({ agent: g.agent, reason: g.reason })),
    events: tail.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      type: e.type,
      agent: e.agent,
      text: text(e),
    })),
    eventCount: events.length,
    reportReady: report !== null,
    instructionsVersion:
      typeof reportData?.["instructionsVersion"] === "string"
        ? (reportData["instructionsVersion"] as string)
        : null,
    dynamicVersion: typeof dynamic === "number" ? dynamic : null,
  };
}

/** The runs of one account, newest first, as staff see them in the Users view. */
export async function accountRuns(store: ObjectStore, emailHash: string) {
  return (await listRunFiles(store, emailHash)).map((run) => ({
    runId: run.runId,
    tier: run.tier as TierId,
    status: run.status,
    startedAt: run.startedAt,
    trigger: run.trigger,
    entitlement: rowEntitlement(run),
  }));
}
