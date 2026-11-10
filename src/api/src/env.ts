import { z } from "zod";

/**
 * The environment each Lambda needs, set by the CDK API stack. Kept in one file so the infra tests
 * can check every function is deployed with every variable it reads at start-up.
 */

const common = {
  DATA_BUCKET: z.string().min(1),
  PEPPER_PARAMETER: z.string().min(1),
  JWT_PARAMETER: z.string().min(1),
};

/** The web-facing API. */
const apiEnvSchema = z.object({
  ...common,
  SITE_ORIGIN: z.url(),
  MAIL_FROM: z.email(),
  MAIL_REPLY_TO: z.email(),
  SES_CONFIGURATION_SET: z.string().min(1),
  TURNSTILE_SECRET_PARAMETER: z.string().optional(),
  STATE_MACHINE_ARN: z.string().min(1),
  ECS_CLUSTER: z.string().min(1),
  /** `<apiId>.appsync-api.<region>.amazonaws.com` and its realtime counterpart. */
  EVENTS_HTTP_DOMAIN: z.string().min(1),
  EVENTS_REALTIME_DOMAIN: z.string().min(1),
  AWS_REGION: z.string().min(1),
});

/** The agent tasks' API. */
const internalEnvSchema = z.object({
  ...common,
  AWS_REGION: z.string().min(1),
  EVENTS_HTTP_DOMAIN: z.string().min(1),
});

/** The live channel's authorizer. */
const streamAuthEnvSchema = z.object({
  PEPPER_PARAMETER: z.string().min(1),
  JWT_PARAMETER: z.string().min(1),
});

/** The orchestration Lambdas: prepare, finalize and the reaper. */
const orchestratorEnvSchema = z.object({
  ...common,
  SITE_ORIGIN: z.url(),
  MAIL_FROM: z.email(),
  MAIL_REPLY_TO: z.email(),
  SES_CONFIGURATION_SET: z.string().min(1),
  AWS_REGION: z.string().min(1),
  EVENTS_HTTP_DOMAIN: z.string().min(1),
  /** Base URL of the internal API that agent tasks call. */
  INTERNAL_API_BASE: z.string().min(1),
  ECS_CLUSTER: z.string().min(1),
  AGENT_FAMILY: z.string().min(1),
  STATE_MACHINE_ARN: z.string().min(1),
});

export const lambdaEnvSchemas = {
  api: apiEnvSchema,
  internal: internalEnvSchema,
  streamAuth: streamAuthEnvSchema,
  orchestrator: orchestratorEnvSchema,
} as const;

export { apiEnvSchema, internalEnvSchema, orchestratorEnvSchema, streamAuthEnvSchema };

export const loadEnv = (env: NodeJS.ProcessEnv = process.env) => apiEnvSchema.parse(env);
