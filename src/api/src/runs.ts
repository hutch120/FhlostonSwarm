import {
  LOGIN_SLOT_IDS,
  runTriggerSchema,
  summarySchema,
  tiers,
  type RunListItem,
  type Summary,
} from "@swarm/shared";
import { z } from "zod";
import { refundCredit, spendCredit } from "./credits.js";
import { reject } from "./http.js";
import { newId } from "./ids.js";
import { testMarkerFor, type Role } from "./identity.js";
import type { StoredScan } from "./scans.js";
import { deletePrefix } from "./storage/delete.js";
import { createJson, getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";
import type { StoredTarget } from "./targets.js";

/** The small `summary.json` the Dashboard lists: the shared summary plus where the run came from. */
export const runFileSchema = summarySchema.extend({
  test: z.boolean().optional(),
  target: z.string(),
  scanId: z.string(),
  trigger: runTriggerSchema,
  /** `staff` runs are internal and need no credit; they are flagged so cost analysis can split them. */
  entitlement: z.enum(["credit", "staff"]),
});
export type RunFile = z.infer<typeof runFileSchema>;

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

const SUMMARY_FILE = /^runs\/[^/]+\/summary\.json$/;

export async function listRunFiles(store: ObjectStore, emailHash: string): Promise<RunFile[]> {
  const prefix = keys.userPrefix(emailHash);
  const found = (await store.list(keys.runsPrefix(emailHash))).filter((key) =>
    SUMMARY_FILE.test(key.slice(prefix.length)),
  );
  const runs = await Promise.all(found.map((key) => getJson(store, key, runFileSchema)));
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

/** The Dashboard row; `scanIds` are the scans that still exist. */
export function toListItem(run: RunFile, scanIds: ReadonlySet<string>): RunListItem {
  const summary: Summary = summarySchema.parse(run);
  return {
    summary,
    target: run.target,
    ...(scanIds.has(run.scanId) ? { scanId: run.scanId as RunListItem["scanId"] } : {}),
    trigger: run.trigger,
  };
}

/** Deletes a run and everything under it (input with logins, events, evidence, reports, cost). */
export async function deleteRun(store: ObjectStore, emailHash: string, runId: string) {
  return deletePrefix(store, keys.runPrefix(emailHash, runId));
}
