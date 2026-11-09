import {
  frequencySchema,
  loginSlotIdSchema,
  notifyOnSchema,
  runStatusSchema,
  scanStatusSchema,
  tierIdSchema,
  type RunStatus,
  type ScanInput,
  type ScanSummary,
} from "@swarm/shared";
import { z } from "zod";
import { reject } from "./http.js";
import { getJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";
import { listJson, type StoredTarget } from "./targets.js";

export const storedScanSchema = z.object({
  test: z.boolean().optional(),
  id: z.string(),
  targetId: z.string(),
  name: z.string(),
  tier: tierIdSchema,
  schedule: z.object({ frequency: frequencySchema, timezone: z.string() }),
  notify: z.object({
    email: z.string(),
    confirmed: z.boolean(),
    on: notifyOnSchema,
    /** Hash of the outstanding confirmation link, so replacing or deleting the scan can revoke it. */
    pendingTokenHash: z.string().nullable(),
  }),
  loginSlots: z.array(loginSlotIdSchema),
  status: scanStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoredScan = z.infer<typeof storedScanSchema>;

export const listScans = (store: ObjectStore, emailHash: string) =>
  listJson(store, keys.scansPrefix(emailHash), storedScanSchema);

export async function getScan(
  store: ObjectStore,
  emailHash: string,
  scanId: string,
): Promise<StoredScan | null> {
  return (await getJson(store, keys.scan(emailHash, scanId), storedScanSchema))?.value ?? null;
}

/** A scan can only use logins its target holds. */
export function checkLoginsExist(input: Pick<ScanInput, "loginSlots">, target: StoredTarget) {
  for (const slot of input.loginSlots) if (!target.logins[slot]) reject(400, "login_missing");
}

export const lastRunSchema = z.object({
  scanId: z.string(),
  runId: z.string(),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type LastRun = z.infer<typeof lastRunSchema>;

/** The Scans screen row. Carries no credentials. */
export function viewScan(
  scan: StoredScan,
  target: StoredTarget | undefined,
  lastRun: LastRun | undefined,
): ScanSummary {
  const status: RunStatus | undefined = lastRun?.status;
  return {
    id: scan.id as ScanSummary["id"],
    targetId: scan.targetId as ScanSummary["targetId"],
    name: scan.name,
    target: target?.hosts[0] ?? "(deleted target)",
    tier: scan.tier,
    frequency: scan.schedule.frequency,
    timezone: scan.schedule.timezone,
    notifyEmail: scan.notify.email,
    notifyOn: scan.notify.on,
    notifyEmailConfirmed: scan.notify.confirmed,
    loginSlots: scan.loginSlots,
    status: scan.status,
    ...(lastRun && status
      ? {
          lastRun: {
            runId: lastRun.runId,
            status,
            ...(lastRun.finishedAt ? { finishedAt: lastRun.finishedAt } : {}),
          },
        }
      : {}),
  };
}
