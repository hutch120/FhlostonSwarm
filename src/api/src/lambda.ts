import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { authConfig } from "./config.js";
import { loadEnv } from "./env.js";
import { AwsLauncher } from "./launcher.js";
import { SesMailer } from "./mailer.js";
import { s3Presigner } from "./presign.js";
import { AppSyncPublisher } from "./publisher.js";
import { CloudWatchMetrics } from "./staff/health.js";
import { ssmSecrets } from "./secrets.js";
import { S3ObjectStore } from "./storage/store.js";
import { turnstileVerifier } from "./turnstile.js";

const env = loadEnv();

/** Lambda entry point: the whole API behind API Gateway (HTTP API, payload v2). */
export const handler = handle(
  createApp({
    store: new S3ObjectStore(env.DATA_BUCKET),
    secrets: ssmSecrets({ pepper: env.PEPPER_PARAMETER, jwtKey: env.JWT_PARAMETER }),
    mailer: new SesMailer({
      from: env.MAIL_FROM,
      replyTo: env.MAIL_REPLY_TO,
      configurationSet: env.SES_CONFIGURATION_SET,
    }),
    config: authConfig,
    siteOrigin: env.SITE_ORIGIN,
    cookieSecure: true,
    verifyHuman: env.TURNSTILE_SECRET_PARAMETER
      ? turnstileVerifier(env.TURNSTILE_SECRET_PARAMETER)
      : undefined,
    launcher: new AwsLauncher({ stateMachineArn: env.STATE_MACHINE_ARN, cluster: env.ECS_CLUSTER }),
    publisher: new AppSyncPublisher({ httpDomain: env.EVENTS_HTTP_DOMAIN, region: env.AWS_REGION }),
    presign: s3Presigner(env.DATA_BUCKET),
    stream: { realtimeDomain: env.EVENTS_REALTIME_DOMAIN, httpDomain: env.EVENTS_HTTP_DOMAIN },
    metrics: new CloudWatchMetrics(),
  }),
);
