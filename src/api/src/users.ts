import { z } from "zod";
import { testMarkerFor, type Role } from "./identity.js";
import { createJson, getJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const profileSchema = z.object({
  email: z.string(),
  test: z.boolean().optional(),
  role: z.enum(["customer", "staff"]),
  createdAt: z.number(),
  lastLoginAt: z.number(),
});

export type Profile = z.infer<typeof profileSchema>;

/** Creates the profile on first sign-in, otherwise records the login. The plain email lives only here. */
export async function recordLogin(
  store: ObjectStore,
  emailHash: string,
  email: string,
  role: Role,
  now: number,
): Promise<Profile> {
  const created: Profile = {
    email,
    role,
    createdAt: now,
    lastLoginAt: now,
    ...testMarkerFor(email),
  };
  if (await createJson(store, keys.profile(emailHash), created)) return created;
  const updated = await updateJson(store, keys.profile(emailHash), profileSchema, (current) =>
    current ? { ...current, role, lastLoginAt: now } : created,
  );
  return updated ?? created;
}

export async function getProfile(store: ObjectStore, emailHash: string): Promise<Profile | null> {
  return (await getJson(store, keys.profile(emailHash), profileSchema))?.value ?? null;
}

/**
 * The free-report claim. Created with `If-None-Match: *`, so of any number of concurrent
 * claims exactly one wins. The marker holds no personal data and outlives account deletion.
 */
export async function claimFreeReport(
  store: ObjectStore,
  emailHash: string,
  now: number,
  marker: { test?: true } = {},
): Promise<"claimed" | "already-claimed"> {
  const won = await createJson(store, keys.freeClaim(emailHash), { claimedAt: now, ...marker });
  return won ? "claimed" : "already-claimed";
}

export async function hasClaimedFreeReport(
  store: ObjectStore,
  emailHash: string,
): Promise<boolean> {
  return (await store.get(keys.freeClaim(emailHash))) !== null;
}

/** Written by the SES feedback handler; the OTP sender skips suppressed addresses. */
export async function isSuppressed(store: ObjectStore, emailHash: string): Promise<boolean> {
  return (await store.get(keys.suppression(emailHash))) !== null;
}
