import { describe, expect, it } from "vitest";
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  NOTIFY_ON_LABELS,
  isRecurring,
  notifyOnSchema,
  scanSettingsSchema,
  scanSummarySchema,
} from "./index.js";

const settings = {
  tier: "sweep",
  frequency: "weekly",
  notifyEmail: "security@example.com",
  notifyOn: "new",
};

describe("scan settings", () => {
  it("accepts every tier and frequency", () => {
    for (const tier of ["scout", "sweep", "probe", "siege"]) {
      for (const frequency of FREQUENCIES) {
        expect(scanSettingsSchema.safeParse({ ...settings, tier, frequency }).success).toBe(true);
      }
    }
  });

  it("offers one-off, daily, weekly, monthly and yearly", () => {
    expect(FREQUENCIES).toEqual(["once", "daily", "weekly", "monthly", "yearly"]);
    expect(Object.keys(FREQUENCY_LABELS)).toEqual([...FREQUENCIES]);
    expect(Object.keys(NOTIFY_ON_LABELS)).toEqual(notifyOnSchema.options);
    expect(FREQUENCIES.filter(isRecurring)).toEqual(["daily", "weekly", "monthly", "yearly"]);
  });

  it("rejects unknown tiers and cadences and bad emails", () => {
    expect(scanSettingsSchema.safeParse({ ...settings, tier: "platinum" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, frequency: "hourly" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, notifyEmail: "nope" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, notifyEmail: "" }).success).toBe(false);
  });
});

describe("scan summary", () => {
  const summary = {
    ...settings,
    id: "scan_abcd1234",
    name: "Staging, weekly",
    target: "staging.example.com",
    status: "active",
    notifyEmailConfirmed: true,
  };

  it("parses with or without a last run", () => {
    expect(scanSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      scanSummarySchema.safeParse({
        ...summary,
        lastRun: {
          runId: "run_abcd1234",
          status: "complete",
          finishedAt: "2026-11-09T01:00:00.000Z",
        },
        nextRunAt: "2026-11-16T01:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("carries no credentials", () => {
    expect(Object.keys(scanSummarySchema.shape)).not.toEqual(
      expect.arrayContaining(["password", "logins"]),
    );
    expect(scanSummarySchema.safeParse({ ...summary, id: "run_abcd1234" }).success).toBe(false);
  });
});
