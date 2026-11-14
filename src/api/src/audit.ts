import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * Staff actions that change something: credit grants, controls, price tables, account and run
 * deletions. One small object per action under `admin/audit/`, kept after an account is deleted, so
 * the record names the account by hash and never by email. `by` is the staff principal: a staff
 * email from the dashboard, an AWS principal from the CLI.
 */
export interface AuditRecord {
  action: string;
  by: string;
  /** Set for records about test data, so `swarm test-cleanup` can find them. */
  test?: true;
  [detail: string]: unknown;
}

const auditSchema = z.looseObject({ at: z.string(), action: z.string(), by: z.string() });
export type StoredAudit = z.infer<typeof auditSchema>;

export async function writeAudit(
  store: ObjectStore,
  at: number,
  record: AuditRecord,
): Promise<string> {
  const id = `${at}-${randomBytes(4).toString("hex")}`;
  await putJson(store, keys.audit(new Date(at), id), { ...record, at: new Date(at).toISOString() });
  return id;
}

/** The newest records, newest first. */
export async function readAudit(store: ObjectStore, limit = 50): Promise<StoredAudit[]> {
  const all = (await store.list(keys.auditPrefix)).sort().reverse().slice(0, limit);
  const records = await Promise.all(all.map((key) => getJson(store, key, auditSchema)));
  return records.flatMap((r) => (r ? [r.value] : []));
}
