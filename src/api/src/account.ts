import { revokeConfirmation } from "./notify.js";
import { listScans } from "./scans.js";
import { deletePrefix } from "./storage/delete.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * Removes everything held for an account: profile, targets (with saved logins), scans, runs,
 * credit ledger and sessions, plus its pending sign-in code, notification links and rate-limit
 * counters. Sessions go last, so a deletion that fails part-way can be retried while signed in.
 * Kept on purpose: the SES suppression entry (a bounced address stays suppressed) and, from
 * Phase 5, the anonymised cost records under `admin/`.
 */
export async function deleteAccountData(store: ObjectStore, emailHash: string): Promise<void> {
  const scans = await listScans(store, emailHash);
  await Promise.all(scans.map((scan) => revokeConfirmation(store, scan.notify.pendingTokenHash)));

  const sessions = keys.sessionsPrefix(emailHash);
  const owned = (await store.list(keys.userPrefix(emailHash))).filter(
    (k) => !k.startsWith(sessions),
  );
  for (let i = 0; i < owned.length; i += 25) {
    await Promise.all(owned.slice(i, i + 25).map((key) => store.delete(key)));
  }
  await store.delete(keys.otp(emailHash));
  await deletePrefix(store, keys.emailRateLimits(emailHash));
  await deletePrefix(store, sessions);
}
