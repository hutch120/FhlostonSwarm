import {
  LOGIN_SLOT_IDS,
  notifyOnSchema,
  runTriggerSchema,
  summarySchema,
  tierIdSchema,
  tiers,
  type RunListItem,
  type Summary,
} from "@swarm/shared";
import { limitsFor, scopePorts, type AgentInput } from "@swarm/shared/server";
import { z } from "zod";
import { refundCredit, spendCredit } from "./credits.js";
import { reject } from "./http.js";
import { newId } from "./ids.js";
import { testMarkerFor, type Role } from "./identity.js";
import type { StoredScan } from "./scans.js";
import { deletePrefix } from "./storage/delete.js";
import { createJson, getJson, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";
import { storedTargetSchema, type StoredTarget } from "./targets.js";

/** The small `summary.json` the Dashboard lists: the shared summary plus where the run came from. */
export const runFileSchema = summarySchema.extend({
  test: z.boolean().optional(),
  target: z.string(),
  scanId: z.string(),
  trigger: runTriggerSchema,
  /** `staff` runs are internal and need no credit; they are flagged so cost analysis can split them. */
  entitlement: z.enum(["credit", "staff"]),
  /** Why a run ended other than normally (customer-safe wording). */
  reason: z.string().optional(),
});
export type RunFile = z.infer<typeof runFileSchema>;

/** The snapshot of the target and scan taken when the run was created (`input.json`). */
export const runInputSchema = z.object({
  test: z.boolean().optional(),
  runId: z.string(),
  scanId: z.string(),
  trigger: runTriggerSchema,
  entitlement: z.enum(["credit", "staff"]),
  tier: tierIdSchema,
  createdAt: z.string(),
  scan: z.object({
    name: z.string(),
    frequency: z.string(),
    timezone: z.string(),
    notify: z.object({ email: z.string(), on: notifyOnSchema, confirmed: z.boolean() }),
  }),
  target: z.object({
    id: z.string(),
    appUrl: z.string(),
    marketingUrl: z.string(),
    scopeNotes: z.string(),
    hosts: z.array(z.string()),
    logins: storedTargetSchema.shape.logins,
  }),
});
export type RunInput = z.infer<typeof runInputSchema>;

export const SWARM_VERSION = "0.1";

export interface RunOwner {
  emailHash: string;
  email: string;
  role: Role;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Starts a run from a saved scan: spends one credit of the scan's depth (staff excepted), then
 * snapshots the target and scan into `input.json` and writes a `queued` `summary.json`. Nothing is
 * written, and nothing is spent, unless a credit was available.
 */
export async function startRun(
  store: ObjectStore,
  owner: RunOwner,
  scan: StoredScan,
  target: StoredTarget,
  now: number,
): Promise<string> {
  const runId = newId("run", now);
  const staff = owner.role === "staff";
  const marker = testMarkerFor(owner.email);

  // The marker is created first and only once per run id; the ledger's compare-and-swap then
  // makes sure a credit can back at most one run, however many starts race.
  if (
    !(await createJson(store, keys.runCredit(owner.emailHash, runId), {
      ...marker,
      tier: scan.tier,
      entitlement: staff ? "staff" : "credit",
      at: now,
    }))
  )
    return reject(409, "run_exists");
  if (!staff && !(await spendCredit(store, owner.emailHash, scan.tier, now))) {
    await store.delete(keys.runCredit(owner.emailHash, runId));
    return reject(402, "no_credit");
  }

  try {
    const logins = Object.fromEntries(
      LOGIN_SLOT_IDS.filter((slot) => scan.loginSlots.includes(slot) && target.logins[slot]).map(
        (slot) => [slot, target.logins[slot]],
      ),
    );
    await putJson(store, keys.runInput(owner.emailHash, runId), {
      ...marker,
      runId,
      scanId: scan.id,
      trigger: "manual",
      entitlement: staff ? "staff" : "credit",
      tier: scan.tier,
      createdAt: iso(now),
      scan: {
        name: scan.name,
        frequency: scan.schedule.frequency,
        timezone: scan.schedule.timezone,
        notify: { email: scan.notify.email, on: scan.notify.on, confirmed: scan.notify.confirmed },
      },
      target: {
        id: target.id,
        appUrl: target.appUrl,
        marketingUrl: target.marketingUrl,
        scopeNotes: target.scopeNotes,
        hosts: target.hosts,
        logins,
      },
      acknowledgement: target.acknowledgement,
      // Reserved for target verification (PLAN.md section 6); off for now.
      targetVerification: null,
    });
    const summary: RunFile = {
      ...marker,
      runId,
      status: "queued",
      tier: scan.tier,
      startedAt: iso(now),
      durationMs: 0,
      checks: 0,
      requests: 0,
      coverage: 0,
      findings: {
        total: 0,
        verified: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      },
      gaps: 0,
      agents: { total: tiers[scan.tier].agents.length, done: 0 },
      target: target.hosts[0] ?? "",
      scanId: scan.id,
      trigger: "manual",
      entitlement: staff ? "staff" : "credit",
    };
    await putJson(store, keys.runSummary(owner.emailHash, runId), summary);
  } catch (err) {
    await deletePrefix(store, keys.runPrefix(owner.emailHash, runId));
    if (!staff) await refundCredit(store, owner.emailHash, scan.tier, now);
    throw err;
  }
  return runId;
}

export async function listRunFiles(store: ObjectStore, emailHash: string): Promise<RunFile[]> {
  // One folder per run: read each run's small summary, not everything under it (events, evidence).
  const folders = await store.folders(keys.runsPrefix(emailHash));
  const runs = await Promise.all(
    folders.map((folder) => getJson(store, `${folder}summary.json`, runFileSchema)),
  );
  return runs
    .flatMap((r) => (r ? [r.value] : []))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getRunFile(
  store: ObjectStore,
  emailHash: string,
  runId: string,
): Promise<RunFile | null> {
  return (await getJson(store, keys.runSummary(emailHash, runId), runFileSchema))?.value ?? null;
}

export async function getRunInput(
  store: ObjectStore,
  emailHash: string,
  runId: string,
): Promise<RunInput | null> {
  return (await getJson(store, keys.runInput(emailHash, runId), runInputSchema))?.value ?? null;
}

/** What an agent task needs to know, resolved from the run's snapshot and the tier config. */
export function buildAgentInput(input: RunInput): AgentInput {
  const tier = tiers[input.tier];
  const limits = limitsFor(input.tier);
  return {
    runId: input.runId,
    tier: input.tier,
    target: { appUrl: input.target.appUrl, marketingUrl: input.target.marketingUrl },
    scope: {
      hosts: input.target.hosts,
      ports: scopePorts([input.target.appUrl, input.target.marketingUrl]),
      readOnly: true,
    },
    agents: tier.agents,
    budgets: {
      wallClockSeconds: Math.round(tier.wallClockMinutes * 60),
      maxSteps: limits.stepCap,
      maxRequests: limits.requestCap,
      requestsPerSecond: limits.requestsPerSecond,
    },
    logins: input.target.logins,
    scopeNotes: input.target.scopeNotes,
    userAgent: `Swarm/${SWARM_VERSION} (+https://fhlostonswarm.com/about)`,
  };
}

const TERMINAL = new Set<RunFile["status"]>(["complete", "stopped", "failed"]);
export const isTerminal = (status: RunFile["status"]) => TERMINAL.has(status);

/**
 * Moves a queued run to running (compare-and-swap, so two starts cannot both win). Returns the
 * updated file, or null when the run was not queued.
 */
export async function claimRun(
  store: ObjectStore,
  emailHash: string,
  runId: string,
  now: number,
): Promise<RunFile | null> {
  let claimed = false;
  const updated = await updateJson(
    store,
    keys.runSummary(emailHash, runId),
    runFileSchema,
    (current) => {
      claimed = false;
      if (!current || current.status !== "queued") return undefined;
      claimed = true;
      return { ...current, status: "running" as const, startedAt: iso(now) };
    },
  );
  return claimed ? updated : null;
}

/** Puts a claimed run back to queued when its execution could not be started. */
export async function releaseRun(store: ObjectStore, emailHash: string, runId: string) {
  await updateJson(store, keys.runSummary(emailHash, runId), runFileSchema, (current) =>
    current && current.status === "running" ? { ...current, status: "queued" as const } : undefined,
  );
}

const creditMarkerSchema = z.looseObject({
  tier: tierIdSchema,
  entitlement: z.enum(["credit", "staff"]),
  refundedAt: z.number().optional(),
});

/** Gives the run's credit back, once however many times it is asked (a run that failed on our side). */
export async function refundRunCredit(
  store: ObjectStore,
  emailHash: string,
  runId: string,
  now: number,
): Promise<boolean> {
  let refund: z.infer<typeof creditMarkerSchema> | null = null;
  await updateJson(store, keys.runCredit(emailHash, runId), creditMarkerSchema, (current) => {
    refund = null;
    if (!current || current.entitlement === "staff" || current.refundedAt) return undefined;
    refund = current;
    return { ...current, refundedAt: now };
  });
  if (!refund) return false;
  await refundCredit(store, emailHash, (refund as z.infer<typeof creditMarkerSchema>).tier, now);
  return true;
}

/** The Dashboard row; `scanIds` are the scans that still exist. */
export function toListItem(run: RunFile, scanIds: ReadonlySet<string>): RunListItem {
  const summary: Summary = summarySchema.parse(run);
  return {
    summary,
    target: run.target,
    ...(scanIds.has(run.scanId) ? { scanId: run.scanId as RunListItem["scanId"] } : {}),
    trigger: run.trigger,
    ...(run.reason ? { reason: run.reason } : {}),
  };
}

/** Deletes a run and everything under it (input with logins, events, evidence, reports, cost). */
export async function deleteRun(store: ObjectStore, emailHash: string, runId: string) {
  return deletePrefix(store, keys.runPrefix(emailHash, runId));
}
