import { streamAuthEnvSchema } from "./env.js";
import { ssmSecrets } from "./secrets.js";
import { authorizeAppSync, type AppSyncAuthEvent } from "./stream.js";

const env = streamAuthEnvSchema.parse(process.env);

const secrets = ssmSecrets({ pepper: env.PEPPER_PARAMETER, jwtKey: env.JWT_PARAMETER });

/** Lambda authorizer for the AppSync Events live channel: one run's token opens that run's channel, read-only. */
export const handler = async (event: AppSyncAuthEvent) => authorizeAppSync(await secrets(), event);
