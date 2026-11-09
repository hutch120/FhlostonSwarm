import {
  LOGIN_SLOT_IDS,
  loginSlotIdSchema,
  type TargetInput,
  type TargetView,
} from "@swarm/shared";
import { z } from "zod";
import type { IntakeConfig } from "./config.js";
import { parseTargetUrl } from "./hosts.js";
import { reject } from "./http.js";
import { getJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const storedLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  description: z.string(),
  notes: z.string(),
});

export const storedTargetSchema = z.object({
  test: z.boolean().optional(),
  id: z.string(),
  appUrl: z.string(),
  marketingUrl: z.string(),
  scopeNotes: z.string(),
  hosts: z.array(z.string()),
  logins: z.partialRecord(loginSlotIdSchema, storedLoginSchema),
  acknowledgement: z.object({ at: z.number(), ip: z.string(), termsVersion: z.string() }),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoredTarget = z.infer<typeof storedTargetSchema>;
export type StoredLogins = StoredTarget["logins"];

/** Reads every `.json` object directly under a prefix. */
export async function listJson<S extends z.ZodType>(
  store: ObjectStore,
  prefix: string,
  schema: S,
): Promise<z.infer<S>[]> {
  const found = (await store.list(prefix)).filter(
    (key) => key.endsWith(".json") && !key.slice(prefix.length).includes("/"),
  );
  const records = await Promise.all(found.map((key) => getJson(store, key, schema)));
  return records.flatMap((r) => (r ? [r.value] : []));
}

export const listTargets = (store: ObjectStore, emailHash: string) =>
  listJson(store, keys.targetsPrefix(emailHash), storedTargetSchema);

export async function getTarget(
  store: ObjectStore,
  emailHash: string,
  targetId: string,
): Promise<StoredTarget | null> {
  return (
    (await getJson(store, keys.target(emailHash, targetId), storedTargetSchema))?.value ?? null
  );
}

/** Validates both URLs and returns the hostnames that become the run's scope. */
export function scopeHosts(
  input: Pick<TargetInput, "appUrl" | "marketingUrl">,
  config: IntakeConfig,
): string[] {
  const app = parseTargetUrl(input.appUrl, config);
  if (!app.ok) return reject(400, `app_url_${app.problem}`);
  const hosts = [app.hostname];
  if (input.marketingUrl) {
    const marketing = parseTargetUrl(input.marketingUrl, config);
    if (!marketing.ok) return reject(400, `marketing_url_${marketing.problem}`);
    if (!hosts.includes(marketing.hostname)) hosts.push(marketing.hostname);
  }
  return hosts;
}

/**
 * The logins after an update: only the slots sent are kept, and a slot sent without a password
 * keeps its saved one (a new slot must come with a password).
 */
export function mergeLogins(
  existing: StoredLogins | undefined,
  given: TargetInput["logins"],
): StoredLogins {
  const merged: StoredLogins = {};
  for (const slot of LOGIN_SLOT_IDS) {
    const login = given[slot];
    if (!login) continue;
    const password = login.password ?? existing?.[slot]?.password;
    if (!password) return reject(400, "password_required");
    merged[slot] = { ...login, password, notes: login.notes ?? "" };
  }
  return merged;
}

/** The browser's view of a target. Passwords are never included. */
export function viewTarget(
  target: StoredTarget,
  scans: { id: string; name: string }[],
): TargetView {
  const logins: TargetView["logins"] = {};
  for (const slot of LOGIN_SLOT_IDS) {
    const login = target.logins[slot];
    if (login) {
      logins[slot] = {
        username: login.username,
        description: login.description,
        notes: login.notes,
        passwordSaved: true,
      };
    }
  }
  return {
    id: target.id as TargetView["id"],
    appUrl: target.appUrl,
    marketingUrl: target.marketingUrl,
    scopeNotes: target.scopeNotes,
    hosts: target.hosts,
    logins,
    acknowledgedAt: new Date(target.acknowledgement.at).toISOString(),
    scans: scans as TargetView["scans"],
  };
}
