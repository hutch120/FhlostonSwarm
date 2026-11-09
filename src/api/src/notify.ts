import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { IntakeConfig } from "./config.js";
import { hmacHex, parseEmail, safeEqual, testMarkerFor } from "./identity.js";
import type { Mailer } from "./mailer.js";
import { hit } from "./ratelimit.js";
import { ContentionError, putJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";
import type { Secrets } from "./sessions.js";
import { storedScanSchema, type StoredScan } from "./scans.js";

/**
 * A notification address other than the account email must confirm a link before it gets any
 * report notice, so a scan cannot be used to email-bomb a third party (PLAN.md section 13).
 */
export interface NotifyDeps {
  store: ObjectStore;
  mailer: Mailer;
  secrets: () => Promise<Secrets>;
  intake: IntakeConfig;
  siteOrigin: string;
  now: () => number;
}

const confirmationSchema = z.object({
  test: z.boolean().optional(),
  emailHash: z.string(),
  scanId: z.string(),
  /** The address being confirmed. */
  email: z.string(),
  expiresAt: z.number(),
  consumed: z.boolean(),
});

const tokenDigest = (pepper: string, token: string) => hmacHex(pepper, `notify:${token}`);

export const sameMailbox = (a: string, b: string): boolean => {
  const left = parseEmail(a);
  const right = parseEmail(b);
  return left !== null && right !== null && left.normalised === right.normalised;
};

/**
 * Mails a fresh single-use link for the scan's notification address. Returns the hash that
 * identifies it, or null when the per-scan or per-account limit says to wait.
 */
export async function sendConfirmation(
  deps: NotifyDeps,
  owner: { emailHash: string },
  scan: Pick<StoredScan, "id" | "notify">,
): Promise<string | null> {
  const { store, intake } = deps;
  const now = deps.now();
  const { pepper } = await deps.secrets();
  const { perScanPerHour, perAccountPerHour, ttlHours } = intake.notifyConfirm;
  if (
    !(await hit(store, `email-${owner.emailHash}-notify-${scan.id}`, perScanPerHour, now)) ||
    !(await hit(store, `email-${owner.emailHash}-notify`, perAccountPerHour, now))
  )
    return null;

  const token = randomBytes(24).toString("base64url");
  const tokenHash = tokenDigest(pepper, token);
  await putJson(store, keys.notifyConfirm(tokenHash), {
    ...testMarkerFor(scan.notify.email),
    emailHash: owner.emailHash,
    scanId: scan.id,
    email: scan.notify.email,
    expiresAt: now + ttlHours * 3_600_000,
    consumed: false,
  } satisfies z.infer<typeof confirmationSchema>);
  try {
    await deps.mailer.sendNotifyConfirmation({
      to: scan.notify.email,
      link: `${deps.siteOrigin}/notify/confirm?token=${encodeURIComponent(token)}`,
      expiresHours: ttlHours,
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
  }
  return tokenHash;
}

/** Revokes an outstanding confirmation link. */
export const revokeConfirmation = (store: ObjectStore, tokenHash: string | null) =>
  tokenHash ? store.delete(keys.notifyConfirm(tokenHash)) : Promise.resolve();

/**
 * Decides whether the scan's notification address is confirmed and, if it still needs to be and
 * no link is outstanding, mails one. `previous` is the stored scan being replaced, if any.
 */
export async function settleNotification(
  deps: NotifyDeps,
  owner: { emailHash: string; email: string },
  next: StoredScan,
  previous: StoredScan | null,
): Promise<StoredScan> {
  const email = next.notify.email;
  const kept = previous !== null && previous.notify.email === email ? previous : null;
  const confirmed = sameMailbox(email, owner.email) || (kept?.notify.confirmed ?? false);
  let pending = kept?.notify.pendingTokenHash ?? null;
  if (previous && !kept) await revokeConfirmation(deps.store, previous.notify.pendingTokenHash);
  if (confirmed) {
    await revokeConfirmation(deps.store, pending);
    pending = null;
  } else if (next.notify.on !== "never" && !pending) {
    pending = await sendConfirmation(deps, owner, next);
  }
  return { ...next, notify: { ...next.notify, confirmed, pendingTokenHash: pending } };
}

/** Consumes a confirmation link once. False for a link that is unknown, used, expired or stale. */
export async function confirmNotification(deps: NotifyDeps, token: string): Promise<boolean> {
  const { store } = deps;
  const { pepper } = await deps.secrets();
  const tokenHash = tokenDigest(pepper, token);
  const key = keys.notifyConfirm(tokenHash);
  const now = deps.now();

  let claimed: z.infer<typeof confirmationSchema> | null = null;
  try {
    await updateJson(store, key, confirmationSchema, (current) => {
      claimed = null;
      if (!current || current.consumed || now > current.expiresAt) return undefined;
      claimed = current;
      return { ...current, consumed: true };
    });
  } catch (err) {
    if (err instanceof ContentionError) return false;
    throw err;
  }
  const link = claimed as z.infer<typeof confirmationSchema> | null;
  if (!link) return false;
  await store.delete(key);

  let applied = false;
  await updateJson(store, keys.scan(link.emailHash, link.scanId), storedScanSchema, (scan) => {
    applied = false;
    if (
      !scan ||
      scan.notify.pendingTokenHash === null ||
      !safeEqual(scan.notify.pendingTokenHash, tokenHash) ||
      scan.notify.email !== link.email
    )
      return undefined;
    applied = true;
    return { ...scan, notify: { ...scan.notify, confirmed: true, pendingTokenHash: null } };
  });
  return applied;
}
