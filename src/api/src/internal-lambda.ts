import { handle } from "hono/aws-lambda";
import { internalEnvSchema } from "./env.js";
import { internalApp } from "./internal.js";
import { AppSyncPublisher } from "./publisher.js";
import { ssmSecrets } from "./secrets.js";
import { S3ObjectStore } from "./storage/store.js";

const env = internalEnvSchema.parse(process.env);

/** The agent tasks' API behind API Gateway with IAM auth: events, evidence and the run's input. */
export const handler = handle(
  internalApp({
    store: new S3ObjectStore(env.DATA_BUCKET),
    secrets: ssmSecrets({ pepper: env.PEPPER_PARAMETER, jwtKey: env.JWT_PARAMETER }),
    publisher: new AppSyncPublisher({ httpDomain: env.EVENTS_HTTP_DOMAIN, region: env.AWS_REGION }),
    now: Date.now,
    requireIam: true,
  }),
);
