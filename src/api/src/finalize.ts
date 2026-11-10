import { buildReport, summarise, tiers, type RunStatus, type Summary } from "@swarm/shared";
import { estimateCost, proxyStatsSchema } from "@swarm/shared/server";
import { appendEvents, getSequencer, readAllEvents, type DraftEvent } from "./events.js";
import type { Mailer } from "./mailer.js";
import type { EventPublisher } from "./publisher.js";
import { renderReportHtml } from "./report-html.js";
import {
  getRunFile,
  getRunInput,
  isTerminal,
  refundRunCredit,
  runFileSchema,
  type RunFile,
} from "./runs.js";
import { getJson, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

export interface FinalizeDeps {
  store: ObjectStore;
  mailer: Mailer;
  publisher?: EventPublisher;
  now: () => number;
  /** https://fhlostonswarm.com, for the link in the notification. */
  siteOrigin: string;
}

export type Outcome = { kind: "finished" } | { kind: "stopped" } | { kind: "failed" };

/** When the agent task ran, from the ECS task description the state machine passes on. */
export interface TaskTimes {
  pullStartedAt?: string;
  startedAt?: string;
  stoppedAt?: string;
}

const REASONS = {
  stopped: "Stopped before it finished. The report covers what ran.",
  failed:
    "The run ended because of a problem on our side. Your credit has been returned. The report covers what ran.",
} as const;

const statusFor = (
  outcome: Outcome,
  stopRequested: boolean,
): Extract<RunStatus, "complete" | "stopped" | "failed"> =>
  stopRequested || outcome.kind === "stopped"
    ? "stopped"
    : outcome.kind === "failed"
      ? "failed"
      : "complete";

const seconds = (from: string | undefined, to: string | undefined): number | null => {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
};

/**
 * Closes a run: writes the `complete` event, the report (data and HTML), the cost record and the
 * anonymised run index, settles the summary, returns the credit when the run failed on our side,
 * and tells the notification address. Every step is idempotent, so the state machine, a stop request
 * and the reaper may all call it for the same run; only the call that flips the summary to its final
 * status sends the notification.
 */
export async function finalizeRun(
  deps: FinalizeDeps,
  ids: { emailHash: string; runId: string },
  outcome: Outcome,
  task: TaskTimes = {},
): Promise<RunFile | null> {
  const { store } = deps;
  const { emailHash, runId } = ids;
  const file = await getRunFile(store, emailHash, runId);
  if (!file) return null;
  if (isTerminal(file.status)) return file;

  const input = await getRunInput(store, emailHash, runId);
  const stopRequested = (await store.get(keys.runStop(emailHash, runId))) !== null;
  const status = statusFor(outcome, stopRequested);
  const at = deps.now();
  const finishedAt = new Date(at).toISOString();
  const scope = { emailHash, runId, tier: file.tier, test: file.test };

  const sequencer = await getSequencer(store, scope);
  const state = { ...sequencer.run, status, finishedAt };
  const summary: Summary = {
    ...summarise(state),
    status,
    startedAt: file.startedAt,
    finishedAt,
    durationMs: Math.max(0, at - Date.parse(file.startedAt)),
  };

  const complete: DraftEvent = {
    type: "complete",
    agent: null,
    runId,
    ts: finishedAt,
    payload: { summary },
  };
  await appendEvents(
    store,
    scope,
    { batchId: `complete-${runId}`, events: [complete] },
    deps.publisher,
  );

  const events = await readAllEvents(store, { emailHash, runId });
  const report = buildReport({
    state: { ...sequencer.run, status, finishedAt, summary },
    events,
    summary,
    target: file.target,
    generatedAt: finishedAt,
  });
  const marker = file.test ? { test: true as const } : {};
  await putJson(store, keys.runReportData(emailHash, runId), { ...marker, ...report });
  await store.put(keys.runReportHtml(emailHash, runId), renderReportHtml(report));

  const stats = await getJson(
    store,
    keys.runEvidence(emailHash, runId, "proxy-stats"),
    proxyStatsSchema.partial(),
  );
  const proxy = stats?.value;
  const taskSeconds =
    seconds(task.pullStartedAt ?? task.startedAt, task.stoppedAt) ??
    (proxy?.uptimeSeconds !== undefined ? proxy.uptimeSeconds + 20 : 0);
  const cost = estimateCost({
    runId,
    tier: file.tier,
    test: file.test,
    startedAt: file.startedAt,
    finishedAt,
    taskSeconds,
    bytesOut: proxy?.bytesOut ?? 0,
    bytesIn: proxy?.bytesIn ?? 0,
    requests: summary.requests,
    checks: summary.checks,
  });
  await putJson(store, keys.runCost(emailHash, runId), cost);

  // Anonymised: no account, no target, no findings content. Kept after the run or account is deleted.
  await putJson(store, keys.runIndex(new Date(at), runId), {
    ...marker,
    runId,
    tier: file.tier,
    trigger: file.trigger,
    entitlement: file.entitlement,
    status,
    startedAt: file.startedAt,
    finishedAt,
    durationSeconds: cost.durationSeconds,
    checks: summary.checks,
    requests: summary.requests,
    coverage: summary.coverage,
    gaps: summary.gaps,
    findings: { total: summary.findings.total, bySeverity: summary.findings.bySeverity },
    agents: summary.agents,
    cost: {
      pricingVersion: cost.pricingVersion,
      fargateUsd: cost.fargate.usd,
      egressUsd: cost.egress.usd,
      bedrock: cost.bedrock,
      totalUsd: cost.totalUsd,
    },
  });

  let won = false;
  const settled = await updateJson(
    store,
    keys.runSummary(emailHash, runId),
    runFileSchema,
    (current) => {
      won = false;
      if (!current || isTerminal(current.status)) return undefined;
      won = true;
      return {
        ...current,
        ...summary,
        ...(status === "complete" ? {} : { reason: REASONS[status] }),
      };
    },
  );
  if (!settled) return null;

  if (status === "failed") await refundRunCredit(store, emailHash, runId, at);

  if (won && status === "complete" && input) {
    const { notify } = input.scan;
    const wanted =
      notify.confirmed &&
      (notify.on === "always" || (notify.on === "new" && summary.findings.total > 0));
    if (wanted) {
      try {
        await deps.mailer.sendReportReady({
          to: notify.email,
          target: file.target,
          tierName: tiers[file.tier].name,
          status: "complete",
          findings: summary.findings.total,
          highOrAbove: summary.findings.bySeverity.critical + summary.findings.bySeverity.high,
          link: `${deps.siteOrigin}/runs/${runId}/report`,
        });
        console.log(JSON.stringify({ msg: "report_notice_sent", runId }));
      } catch (err) {
        console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
      }
    }
  }
  return settled;
}
