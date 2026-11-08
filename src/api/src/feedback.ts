import type { SNSEvent } from "aws-lambda";
import { z } from "zod";
import { loadEnv } from "./env.js";
import { emailHash, parseEmail, testMarker } from "./identity.js";
import { ssmSecrets } from "./secrets.js";
import { createJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { S3ObjectStore, type ObjectStore } from "./storage/store.js";

const feedbackSchema = z.object({
  eventType: z.string(),
  bounce: z
    .object({
      bounceType: z.string(),
      bouncedRecipients: z.array(z.object({ emailAddress: z.string() })),
    })
    .optional(),
  complaint: z
    .object({ complainedRecipients: z.array(z.object({ emailAddress: z.string() })) })
    .optional(),
});

/**
 * Turns an SES bounce/complaint event into `suppression/{emailHash}.json` entries. Permanent
 * bounces and complaints suppress; transient bounces do not. Only the hash is stored.
 */
export async function recordFeedback(
  store: ObjectStore,
  pepper: string,
  message: unknown,
  now: number,
): Promise<number> {
  const parsed = feedbackSchema.safeParse(message);
  if (!parsed.success) return 0;
  const event = parsed.data;
  let reason: "bounce" | "complaint" | null = null;
  let recipients: string[] = [];
  if (event.eventType === "Bounce" && event.bounce?.bounceType === "Permanent") {
    reason = "bounce";
    recipients = event.bounce.bouncedRecipients.map((r) => r.emailAddress);
  } else if (event.eventType === "Complaint" && event.complaint) {
    reason = "complaint";
    recipients = event.complaint.complainedRecipients.map((r) => r.emailAddress);
  }
  if (!reason) return 0;
  let written = 0;
  for (const address of recipients) {
    const email = parseEmail(address);
    if (!email) continue;
    const key = keys.suppression(emailHash(pepper, email));
    await createJson(store, key, { reason, at: now, ...testMarker(email) });
    written++;
  }
  return written;
}

const env = () => loadEnv();
let cached: { store: ObjectStore; secrets: ReturnType<typeof ssmSecrets> } | undefined;

/** SNS subscriber for the SES feedback topic. */
export async function handler(event: SNSEvent): Promise<void> {
  cached ??= {
    store: new S3ObjectStore(env().DATA_BUCKET),
    secrets: ssmSecrets({ pepper: env().PEPPER_PARAMETER, jwtKey: env().JWT_PARAMETER }),
  };
  const { pepper } = await cached.secrets();
  for (const record of event.Records) {
    let message: unknown;
    try {
      message = JSON.parse(record.Sns.Message);
    } catch {
      continue;
    }
    await recordFeedback(cached.store, pepper, message, Date.now());
  }
}
