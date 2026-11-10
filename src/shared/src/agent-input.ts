import { z } from "zod";
import { agentIdSchema, tierIdSchema } from "./events.js";
import { loginInputSchema, loginSlotIdSchema } from "./scans.js";

/**
 * What an agent task is told about its run: the scope the proxy enforces, the budgets, and the
 * logins it may use. Server-to-agent only (budgets are cost controls), so it lives behind the
 * `@swarm/shared/server` entry point.
 */
export const agentInputSchema = z.object({
  runId: z.string().min(1),
  tier: tierIdSchema,
  target: z.object({ appUrl: z.string().min(1), marketingUrl: z.string() }),
  scope: z.object({
    /** Hostnames the swarm may reach (the proxy's allow-list). */
    hosts: z.array(z.string().min(1)).min(1),
    /** Ports it may reach on those hosts: 80, 443 and any port named in the URLs. */
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
    /** Only safe methods (GET, HEAD, OPTIONS) leave the proxy. */
    readOnly: z.boolean(),
    /** Sign-in submissions (POST) the proxy lets through even when read-only; 0 at Scout depth. */
    loginSubmissions: z.number().int().nonnegative(),
  }),
  /** The roster ids this run plans to cover (the tier's agent group). */
  agents: z.array(agentIdSchema).min(1),
  budgets: z.object({
    wallClockSeconds: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
    maxRequests: z.number().int().positive(),
    requestsPerSecond: z.number().positive(),
    /** Pages the explorer may open; null leaves it to the agent budgets. */
    maxPages: z.number().int().positive().nullable(),
    llm: z.object({
      modelId: z.string().min(1),
      maxCalls: z.number().int().positive().nullable(),
      /** Calls one explorer phase may use. */
      phaseCalls: z.number().int().positive().nullable(),
      maxInputTokens: z.number().int().positive().nullable(),
      maxOutputTokens: z.number().int().positive().nullable(),
      spendCapUsd: z.number().positive(),
    }),
  }),
  logins: z.partialRecord(
    loginSlotIdSchema,
    loginInputSchema.required({ password: true }).extend({ notes: z.string() }),
  ),
  scopeNotes: z.string(),
  userAgent: z.string().min(1),
});
export type AgentInput = z.infer<typeof agentInputSchema>;

/** The proxy's own accounting, posted as evidence when it stops. */
export const proxyStatsSchema = z.object({
  uptimeSeconds: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
});
export type ProxyStats = z.infer<typeof proxyStatsSchema>;

export const proxyLogEntrySchema = z.object({
  ts: z.iso.datetime(),
  method: z.string(),
  host: z.string(),
  port: z.number().int(),
  /** Path without the query string. */
  path: z.string(),
  decision: z.enum(["allowed", "blocked"]),
  reason: z.string().optional(),
  status: z.number().int().optional(),
});
export type ProxyLogEntry = z.infer<typeof proxyLogEntrySchema>;
