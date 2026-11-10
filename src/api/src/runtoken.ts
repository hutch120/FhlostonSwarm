import { createHmac, timingSafeEqual } from "node:crypto";
import type { Secrets } from "./sessions.js";

/**
 * The token that binds an agent task to one run. All tasks share one IAM role, so IAM alone cannot
 * stop one run's task from posting into another run; this token (derived from a server secret, the
 * owner and the run id) can.
 */
export function runToken(secrets: Secrets, emailHash: string, runId: string): string {
  return createHmac("sha256", secrets.jwtKey)
    .update(`run-token:${emailHash}:${runId}`)
    .digest("hex");
}

export function checkRunToken(
  secrets: Secrets,
  emailHash: string,
  runId: string,
  given: string | undefined,
): boolean {
  if (!given) return false;
  const expected = Buffer.from(runToken(secrets, emailHash, runId));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
