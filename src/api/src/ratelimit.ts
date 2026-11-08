import { z } from "zod";
import { ContentionError, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const counterSchema = z.object({ count: z.number().int() });

const HOUR_MS = 3_600_000;

/**
 * Coarse fixed-window counter in S3 (compare-and-swap). Counts the hit and reports whether it is
 * within the limit. API Gateway throttling is the real per-request limiter; this stops one
 * mailbox or address from being used to spam.
 */
export async function hit(
  store: ObjectStore,
  scope: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const window = String(Math.floor(now / HOUR_MS));
  try {
    const result = await updateJson(store, keys.rateLimit(scope, window), counterSchema, (c) => ({
      count: (c?.count ?? 0) + 1,
    }));
    return (result?.count ?? 1) <= limit;
  } catch (err) {
    // Fail closed: a key too hot to update is being hammered.
    if (err instanceof ContentionError) return false;
    throw err;
  }
}
