import { readFileSync } from "node:fs";
import { z } from "zod";

const googleWorkspaceSchema = z.object({
  mx: z.array(z.object({ priority: z.number().int(), host: z.string() })).min(1),
  spf: z.string().min(1),
  siteVerification: z.string().min(1),
  dkim: z.string().min(1),
});

const apiSchema = z.object({
  /** SSM SecureStrings (created by `swarm init-secrets`, never in git). */
  pepperParameter: z.string().startsWith("/swarm/"),
  jwtKeyParameter: z.string().startsWith("/swarm/"),
  /** Optional Turnstile secret parameter; null leaves the bot check off. */
  turnstileSecretParameter: z.string().startsWith("/swarm/").nullable(),
  mailFrom: z.email(),
  mailReplyTo: z.email(),
  /** API Gateway throttling (requests per second / burst). */
  throttle: z.object({
    rateLimit: z.number().int().positive(),
    burstLimit: z.number().int().positive(),
  }),
});

export const configSchema = z.object({
  account: z.string().regex(/^\d{12}$/),
  region: z.string().min(1),
  domainName: z.string().min(1),
  hostedZoneId: z.string().min(1),
  cloudfrontCertificateArn: z
    .string()
    .regex(/^arn:aws:acm:us-east-1:\d{12}:certificate\/.+$/)
    .nullable(),
  alertEmail: z.email(),
  idleBudgetUsd: z.number().positive(),
  logRetentionDays: z.literal(30),
  dmarc: z.object({
    policy: z.enum(["none", "quarantine", "reject"]),
    reportEmail: z.email(),
  }),
  // Null while the Workspace records are managed by hand (see PREREQUISITES.md section 5).
  googleWorkspace: googleWorkspaceSchema.nullable(),
  api: apiSchema,
});

export type SwarmConfig = z.infer<typeof configSchema>;

export const CONFIG_PATH = new URL("../config/swarm.json", import.meta.url);

export function parseConfig(raw: unknown): SwarmConfig {
  return configSchema.parse(raw);
}

export function loadConfig(): SwarmConfig {
  return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}
