import { z } from "zod";

/** Lambda environment, set by the CDK API stack. */
const envSchema = z.object({
  DATA_BUCKET: z.string().min(1),
  SITE_ORIGIN: z.url(),
  PEPPER_PARAMETER: z.string().min(1),
  JWT_PARAMETER: z.string().min(1),
  MAIL_FROM: z.email(),
  MAIL_REPLY_TO: z.email(),
  SES_CONFIGURATION_SET: z.string().min(1),
  TURNSTILE_SECRET_PARAMETER: z.string().optional(),
});

export const loadEnv = (env: NodeJS.ProcessEnv = process.env) => envSchema.parse(env);
