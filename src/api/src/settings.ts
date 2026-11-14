import { TIER_IDS, tierIdSchema, type TierId } from "@swarm/shared";
import {
  tierLimits,
  tierLimitsConfigSchema,
  tierLimitsSchema,
  type TierLimits,
} from "@swarm/shared/server";
import { z } from "zod";
import controlsJson from "../config/controls.json" with { type: "json" };
import { writeAudit } from "./audit.js";
import { getJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * The operational controls staff change while the service runs (PLAN.md section 12): the kill
 * switch, per-depth concurrency, the depth caps, the scheduled-scan limits, the daily spend alarm and
 * the block lists. The defaults are `config/controls.json` and `limits.json`; what staff change is
 * kept in one small object in the data bucket and read at the moment it is used, so a change takes
 * effect without a deploy.
 */

const defaults = z
  .object({
    dailySpendAlarmUsd: z.number().positive().nullable(),
    scheduledScans: z.object({
      maxActivePerAccount: z.number().int().nonnegative(),
      minSpacingHours: z.number().nonnegative(),
    }),
    blockedHosts: z.array(z.string()),
    blockedEmailDomains: z.array(z.string()),
  })
  .parse(controlsJson);

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "expected a domain");
const domainList = z.array(domain).max(500);

/** The caps staff may change per depth: what a run may use, never what it is allowed to do. */
export const capsSchema = tierLimitsSchema
  .pick({
    pageCap: true,
    llmStepCap: true,
    stepCap: true,
    requestCap: true,
    requestsPerSecond: true,
    tokenCap: true,
    spendCapUsd: true,
  })
  .partial()
  .strict();
export type Caps = z.infer<typeof capsSchema>;

const scheduledScansSchema = z.object({
  maxActivePerAccount: z.number().int().min(0).max(100),
  minSpacingHours: z.number().min(0).max(8760),
});

const killSwitchSchema = z.object({
  on: z.boolean(),
  reason: z.string().max(300),
  at: z.number().optional(),
  by: z.string().optional(),
});
export type KillSwitch = z.infer<typeof killSwitchSchema>;

export const settingsSchema = z.object({
  killSwitch: killSwitchSchema,
  concurrency: z.partialRecord(tierIdSchema, z.number().int().min(1).max(50)),
  caps: z.partialRecord(tierIdSchema, capsSchema),
  dailySpendAlarmUsd: z.number().positive().nullable().optional(),
  scheduledScans: scheduledScansSchema.optional(),
  blockedHosts: domainList.optional(),
  blockedEmailDomains: domainList.optional(),
  updatedAt: z.number().optional(),
  updatedBy: z.string().optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** What staff may send to change the controls; whatever is present replaces that part. */
export const settingsPatchSchema = z
  .object({
    concurrency: settingsSchema.shape.concurrency,
    caps: settingsSchema.shape.caps,
    dailySpendAlarmUsd: z.number().positive().nullable(),
    scheduledScans: scheduledScansSchema,
    blockedHosts: domainList,
    blockedEmailDomains: domainList,
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export interface Effective {
  killSwitch: KillSwitch;
  concurrency: Record<TierId, number>;
  limits: Record<TierId, TierLimits>;
  dailySpendAlarmUsd: number | null;
  scheduledScans: { maxActivePerAccount: number; minSpacingHours: number };
  blockedHosts: string[];
  blockedEmailDomains: string[];
}

const initial: Settings = { killSwitch: { on: false, reason: "" }, concurrency: {}, caps: {} };

/** The configured defaults with the stored changes on top. Throws when the result is not a valid set of limits. */
export function applySettings(stored: Settings | null): Effective {
  const s = stored ?? initial;
  const limits = Object.fromEntries(
    TIER_IDS.map((tier) => [
      tier,
      {
        ...tierLimits[tier],
        ...s.caps[tier],
        concurrency: s.concurrency[tier] ?? tierLimits[tier].concurrency,
      },
    ]),
  ) as Record<TierId, TierLimits>;
  const checked = tierLimitsConfigSchema.parse(limits);
  return {
    killSwitch: s.killSwitch,
    concurrency: Object.fromEntries(TIER_IDS.map((t) => [t, checked[t].concurrency])) as Record<
      TierId,
      number
    >,
    limits: checked,
    dailySpendAlarmUsd:
      s.dailySpendAlarmUsd === undefined ? defaults.dailySpendAlarmUsd : s.dailySpendAlarmUsd,
    scheduledScans: s.scheduledScans ?? defaults.scheduledScans,
    blockedHosts: s.blockedHosts ?? defaults.blockedHosts,
    blockedEmailDomains: s.blockedEmailDomains ?? defaults.blockedEmailDomains,
  };
}

export async function loadSettings(store: ObjectStore): Promise<Settings | null> {
  return (await getJson(store, keys.settings, settingsSchema))?.value ?? null;
}

export async function effectiveSettings(store: ObjectStore): Promise<Effective> {
  return applySettings(await loadSettings(store));
}

/** The depth's limits as they are now: the config with staff changes applied. */
export async function effectiveLimits(store: ObjectStore, tier: TierId): Promise<TierLimits> {
  return (await effectiveSettings(store)).limits[tier];
}

/** Hours between runs of each repeating cadence, for the minimum spacing a scan's schedule must respect. */
export const HOURS_BETWEEN = { daily: 24, weekly: 168, monthly: 720, yearly: 8760 } as const;

/** True for a listed domain or any subdomain of one. */
export function isBlockedDomain(domain: string, list: readonly string[]): boolean {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.includes(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** The configured defaults, for the Controls view to show next to what is in force. */
export const settingsDefaults = {
  ...defaults,
  concurrency: Object.fromEntries(TIER_IDS.map((t) => [t, tierLimits[t].concurrency])) as Record<
    TierId,
    number
  >,
  limits: tierLimits,
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a patch to the controls and writes an audit record with what changed. The result must be a
 * valid set of limits (spend caps still rise with depth), or nothing is written and this throws.
 */
export async function updateSettings(
  store: ObjectStore,
  patch: SettingsPatch,
  by: string,
  now: number,
): Promise<Effective> {
  let before: Effective = applySettings(null);
  const written = await updateJson(store, keys.settings, settingsSchema, (current) => {
    before = applySettings(current);
    const next: Settings = {
      ...(current ?? initial),
      ...patch,
      updatedAt: now,
      updatedBy: by,
    };
    applySettings(next);
    return next;
  });
  const after = applySettings(written);
  const changed = (Object.keys(patch) as (keyof SettingsPatch)[]).filter(
    (key) => !same(before[key === "caps" ? "limits" : key], after[key === "caps" ? "limits" : key]),
  );
  await writeAudit(store, now, {
    action: "set-controls",
    by,
    changed,
    before: Object.fromEntries(changed.map((k) => [k, before[k === "caps" ? "limits" : k]])),
    after: Object.fromEntries(changed.map((k) => [k, after[k === "caps" ? "limits" : k]])),
  });
  return after;
}

/** Turns the global kill switch on or off. Returns what is now in force. */
export async function setKillSwitch(
  store: ObjectStore,
  on: boolean,
  reason: string,
  by: string,
  now: number,
): Promise<KillSwitch> {
  const written = await updateJson(store, keys.settings, settingsSchema, (current) => ({
    ...(current ?? initial),
    killSwitch: { on, reason: reason.trim(), at: now, by },
    updatedAt: now,
    updatedBy: by,
  }));
  await writeAudit(store, now, { action: on ? "kill-switch-on" : "kill-switch-off", by, reason });
  return written!.killSwitch;
}
