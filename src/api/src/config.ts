import { z } from "zod";
import authJson from "../config/auth.json" with { type: "json" };

/** Auth behaviour is data, not code: edit config/auth.json to tune it. */
export const authConfigSchema = z.object({
  staffDomain: z.string().min(1),
  reservedStaffLocalParts: z.array(z.string().min(1)),
  otp: z.object({
    codeLength: z.number().int().min(4).max(10),
    ttlMinutes: z.number().positive(),
    maxAttempts: z.number().int().positive(),
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
