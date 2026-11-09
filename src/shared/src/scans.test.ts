import { describe, expect, it } from "vitest";
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  NOTIFY_ON_LABELS,
  isRecurring,
  notifyOnSchema,
  runListItemSchema,
  scanInputSchema,
  scanSettingsSchema,
  scanSummarySchema,
  targetInputSchema,
  targetViewSchema,
} from "./index.js";

const settings = {
  tier: "sweep",
  frequency: "weekly",
  timezone: "Australia/Sydney",
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

  it("rejects unknown tiers, cadences and zones, and bad emails", () => {
    expect(scanSettingsSchema.safeParse({ ...settings, tier: "platinum" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, frequency: "hourly" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, notifyEmail: "nope" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, notifyEmail: "" }).success).toBe(false);
    expect(scanSettingsSchema.safeParse({ ...settings, timezone: "Mars/Olympus" }).success).toBe(
      false,
    );
    expect(scanSettingsSchema.safeParse({ ...settings, timezone: "UTC" }).success).toBe(true);
  });
});

describe("scan input", () => {
  const input = {
    ...settings,
    targetId: "tgt_abcd1234",
    name: "Staging, weekly",
    loginSlots: ["user1"],
  };
  const parse = (over: Record<string, unknown>) =>
    scanInputSchema.safeParse({ ...input, ...over }).success;

  it("fits the logins to the depth: Scout 0, Sweep 1, Probe 2, Siege 4", () => {
    expect(parse({ tier: "scout", loginSlots: [] })).toBe(true);
    expect(parse({ tier: "scout", loginSlots: ["user1"] })).toBe(false);
    expect(parse({ tier: "sweep", loginSlots: [] })).toBe(false);
    expect(parse({ tier: "sweep", loginSlots: ["user1"] })).toBe(true);
    expect(parse({ tier: "sweep", loginSlots: ["user1", "admin"] })).toBe(false);
    expect(parse({ tier: "probe", loginSlots: ["user1", "admin"] })).toBe(true);
    expect(parse({ tier: "probe", loginSlots: ["user1", "admin", "other"] })).toBe(false);
    expect(parse({ tier: "siege", loginSlots: ["admin", "user1", "user2", "other"] })).toBe(true);
    expect(parse({ tier: "siege", loginSlots: [] })).toBe(false);
  });

  it("rejects duplicate or unknown slots, a missing name and a malformed target id", () => {
    expect(parse({ tier: "probe", loginSlots: ["admin", "admin"] })).toBe(false);
    expect(parse({ loginSlots: ["root"] })).toBe(false);
    expect(parse({ name: " " })).toBe(false);
    expect(parse({ targetId: "scan_abcd1234" })).toBe(false);
  });
});

describe("target input and view", () => {
  const input = {
    appUrl: "https://staging.example.com",
    logins: { user1: { username: "u", password: "p", description: "Standard" } },
    acknowledged: true,
  };
  const parse = (over: Record<string, unknown>) =>
    targetInputSchema.safeParse({ ...input, ...over }).success;

  it("requires the acknowledgement and defaults the optional fields", () => {
    expect(targetInputSchema.parse(input)).toMatchObject({
      marketingUrl: "",
      scopeNotes: "",
      logins: { user1: { notes: "" } },
    });
    expect(parse({ acknowledged: false })).toBe(false);
    expect(targetInputSchema.safeParse({ appUrl: input.appUrl }).success).toBe(false);
  });

  it("lets an update leave out a saved password, but not a description or an unknown slot", () => {
    expect(parse({ logins: { user1: { username: "u", description: "Standard" } } })).toBe(true);
    expect(parse({ logins: { user1: { username: "u", password: "p" } } })).toBe(false);
    expect(parse({ logins: { root: { username: "u", description: "d" } } })).toBe(false);
  });

  it("the browser's view of a target drops any password it is handed", () => {
    const view = targetViewSchema.parse({
      id: "tgt_abcd1234",
      appUrl: "https://staging.example.com",
      marketingUrl: "",
      scopeNotes: "",
      hosts: ["staging.example.com"],
      logins: {
        user1: {
          username: "u",
          description: "d",
          notes: "",
          passwordSaved: true,
          password: "leaked",
        },
      },
      acknowledgedAt: "2026-11-10T00:00:00.000Z",
      scans: [],
    });
    expect(JSON.stringify(view)).not.toContain("leaked");
  });
});

describe("scan summary", () => {
  const summary = {
    ...settings,
    id: "scan_abcd1234",
    targetId: "tgt_abcd1234",
    loginSlots: ["user1"],
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

describe("run list item", () => {
  it("needs a summary, a target host and a trigger", () => {
    expect(runListItemSchema.safeParse({}).success).toBe(false);
  });
});
