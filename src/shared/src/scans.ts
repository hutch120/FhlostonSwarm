import { z } from "zod";
import { runStatusSchema, summarySchema, tierIdSchema } from "./events.js";
import { tiers } from "./tiers.js";

/** Bump when the terms or privacy text changes; stored with each acknowledgement. */
export const TERMS_VERSION = "2026-11-10";

/**
 * Saved scans (PLAN.md section 13). A scan is a saved configuration: which application (target and
 * logins), how deep (tier), when (frequency) and who is told (notification email). Every run is
 * started from a scan, so re-running never means configuring from scratch.
 */

export const frequencySchema = z.enum(["once", "daily", "weekly", "monthly", "yearly"]);
export type Frequency = z.infer<typeof frequencySchema>;
export const FREQUENCIES = frequencySchema.options;

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  once: "One-off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** When a notification email is sent: after every run, only when findings are new, or never. */
export const notifyOnSchema = z.enum(["always", "new", "never"]);
export type NotifyOn = z.infer<typeof notifyOnSchema>;
export const NOTIFY_ON_LABELS: Record<NotifyOn, string> = {
  always: "After every run",
  new: "Only when there are new findings",
  never: "Never (I will check the dashboard)",
};

export const scanStatusSchema = z.enum(["active", "paused"]);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

export const scanIdSchema = z.string().regex(/^scan_[0-9a-z]{8,}$/, "expected scan_<id>");
export const targetIdSchema = z.string().regex(/^tgt_[0-9a-z]{8,}$/, "expected tgt_<id>");

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone such as `Australia/Sydney`. */
export const timezoneSchema = z.string().max(64).refine(isTimeZone, "Unknown time zone");

/** The part of a scan a customer configures besides the target: depth, cadence and notification. */
export const scanSettingsSchema = z.object({
  tier: tierIdSchema,
  frequency: frequencySchema,
  timezone: timezoneSchema,
  notifyEmail: z.email().max(254),
  notifyOn: notifyOnSchema,
});
export type ScanSettings = z.infer<typeof scanSettingsSchema>;

/** The four fixed login slots a target can hold. */
export const loginSlotIdSchema = z.enum(["admin", "user1", "user2", "other"]);
export type LoginSlotId = z.infer<typeof loginSlotIdSchema>;
export const LOGIN_SLOT_IDS = loginSlotIdSchema.options;

/** A saved scan: its settings, name, target and which of the target's logins it uses. */
export const scanInputSchema = scanSettingsSchema
  .extend({
    targetId: targetIdSchema,
    name: z.string().trim().min(1).max(80),
    loginSlots: z.array(loginSlotIdSchema).max(LOGIN_SLOT_IDS.length),
  })
  .superRefine((scan, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message, path: ["loginSlots"] });
    const allowed = tiers[scan.tier].logins;
    if (new Set(scan.loginSlots).size !== scan.loginSlots.length) issue("duplicate login");
    else if (scan.loginSlots.length > allowed) issue(`${scan.tier} uses at most ${allowed} logins`);
    else if (allowed > 0 && scan.loginSlots.length === 0)
      issue(`${scan.tier} needs at least one login`);
  });
export type ScanInput = z.infer<typeof scanInputSchema>;

/** A test login as the customer submits it. Omit `password` on an update to keep the saved one. */
export const loginInputSchema = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(512).optional(),
  description: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(500).default(""),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/** The application under test: URLs, scope notes, logins and the authorisation acknowledgement. */
export const targetInputSchema = z.object({
  appUrl: z.string().trim().min(1).max(2048),
  marketingUrl: z.string().trim().max(2048).default(""),
  scopeNotes: z.string().trim().max(2000).default(""),
  logins: z.partialRecord(loginSlotIdSchema, loginInputSchema).default({}),
  acknowledged: z.literal(true),
});
export type TargetInput = z.infer<typeof targetInputSchema>;

/** A saved target as the browser sees it: never carries a password, only that one is saved. */
export const targetViewSchema = z.object({
  id: targetIdSchema,
  appUrl: z.string(),
  marketingUrl: z.string(),
  scopeNotes: z.string(),
  /** Hostnames the swarm may reach for this target. */
  hosts: z.array(z.string()),
  logins: z.partialRecord(
    loginSlotIdSchema,
    z.object({
      username: z.string(),
      description: z.string(),
      notes: z.string(),
      passwordSaved: z.literal(true),
    }),
  ),
  acknowledgedAt: z.iso.datetime(),
  /** Scans that use this target; they are deleted with it. */
  scans: z.array(z.object({ id: scanIdSchema, name: z.string() })),
});
export type TargetView = z.infer<typeof targetViewSchema>;

/** What the Scans screen lists. Never carries credentials. */
export const scanSummarySchema = scanSettingsSchema.extend({
  id: scanIdSchema,
  targetId: targetIdSchema,
  name: z.string().min(1),
  /** The slots (not the credentials) of the target's logins that this scan signs in with. */
  loginSlots: z.array(loginSlotIdSchema),
  /** Hostname of the application URL. */
  target: z.string().min(1),
  status: scanStatusSchema,
  /** A notification address other than the account email must confirm before it receives mail. */
  notifyEmailConfirmed: z.boolean(),
  lastRun: z
    .object({
      runId: z.string().min(1),
      status: runStatusSchema,
      finishedAt: z.iso.datetime().optional(),
    })
    .optional(),
  /** Absent for one-off scans and paused scans. */
  nextRunAt: z.iso.datetime().optional(),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const runTriggerSchema = z.enum(["manual", "scheduled"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** One row of the Dashboard: a run's summary, its target host and the scan it came from. */
export const runListItemSchema = z.object({
  summary: summarySchema,
  /** Hostname of the application URL. */
  target: z.string().min(1),
  /** Absent once the scan has been deleted, so there is nothing to run again. */
  scanId: scanIdSchema.optional(),
  trigger: runTriggerSchema,
});
export type RunListItem = z.infer<typeof runListItemSchema>;

export const isRecurring = (frequency: Frequency): boolean => frequency !== "once";
