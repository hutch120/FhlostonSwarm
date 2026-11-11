import { z } from "zod";
import authJson from "../config/auth.json" with { type: "json" };
import intakeJson from "../config/intake.json" with { type: "json" };

/** Auth behaviour is data, not code: edit config/auth.json to tune it. */
export const authConfigSchema = z.object({
  staffDomain: z.string().min(1),
  reservedStaffLocalParts: z.array(z.string().min(1)),
  otp: z.object({
    codeLength: z.number().int().min(4).max(10),
    ttlMinutes: z.number().positive(),
    maxAttempts: z.number().int().positive(),
  }),
  /** Reusable sign-in codes an account holder generates for testing, by chosen lifetime. */
  testPasscode: z.object({
    lifetimeMinutes: z.object({
      hour: z.number().positive(),
      day: z.number().positive(),
      week: z.number().positive(),
      month: z.number().positive(),
    }),
  }),
  rateLimits: z.object({
    requestPerEmailPerHour: z.number().int().positive(),
    requestPerIpPerHour: z.number().int().positive(),
    verifyPerIpPerHour: z.number().int().positive(),
  }),
  session: z.object({
    accessTtlMinutes: z.number().positive(),
    refreshTtlDays: z.number().positive(),
  }),
  /** Minimum duration of /auth/request, so blocked and sent requests look alike. */
  minRequestMs: z.number().int().nonnegative(),
  disposableDomains: z.array(z.string().min(1)),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export const authConfig: AuthConfig = authConfigSchema.parse(authJson);

const hostList = z.array(z.string().regex(/^[a-z0-9.-]+$/, "lowercase hostname suffix"));

/** Intake behaviour is data, not code: edit config/intake.json to tune it. */
export const intakeConfigSchema = z.object({
  quotas: z.object({
    maxTargets: z.number().int().positive(),
    maxScans: z.number().int().positive(),
  }),
  /** Confirmation links for notification addresses other than the account email. */
  notifyConfirm: z.object({
    ttlHours: z.number().positive(),
    perScanPerHour: z.number().int().positive(),
    perAccountPerHour: z.number().int().positive(),
  }),
  blockedHosts: z.object({
    /** Our own domains and well-known third-party services: the domain and its subdomains. */
    domains: hostList,
    /** Public-sector and similar suffixes, e.g. `gov.au`. */
    suffixes: hostList,
    /** Names that only resolve inside a private network. */
    unroutable: hostList,
  }),
});

export type IntakeConfig = z.infer<typeof intakeConfigSchema>;

export const intakeConfig: IntakeConfig = intakeConfigSchema.parse(intakeJson);
