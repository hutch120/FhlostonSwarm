import { z } from "zod";
import { runStatusSchema, tierIdSchema } from "./events.js";

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

/** The part of a scan a customer configures besides the target: depth, cadence and notification. */
export const scanSettingsSchema = z.object({
  tier: tierIdSchema,
  frequency: frequencySchema,
  notifyEmail: z.email(),
  notifyOn: notifyOnSchema,
});
export type ScanSettings = z.infer<typeof scanSettingsSchema>;

/** What the Scans screen lists. Never carries credentials. */
export const scanSummarySchema = scanSettingsSchema.extend({
  id: scanIdSchema,
  name: z.string().min(1),
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

export const isRecurring = (frequency: Frequency): boolean => frequency !== "once";
