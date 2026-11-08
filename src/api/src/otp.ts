import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { AuthConfig } from "./config.js";
import { hmacHex, safeEqual, testMarkerFor } from "./identity.js";
import { ContentionError, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const challengeSchema = z.object({
  email: z.string(),
  test: z.boolean().optional(),
  codeHash: z.string(),
  linkHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  attempts: z.number().int(),
  consumed: z.boolean().default(false),
});

export type Challenge = z.infer<typeof challengeSchema>;

export interface IssuedChallenge {
  code: string;
  /** `<emailHash>.<secret>`: the magic-link token. */
  linkToken: string;
}

const codeDigest = (pepper: string, hash: string, code: string) =>
  hmacHex(pepper, `otp:${hash}:${code}`);
const linkDigest = (pepper: string, hash: string, secret: string) =>
  hmacHex(pepper, `link:${hash}:${secret}`);

/** Stores a fresh challenge for the user (replacing any previous one) and returns its secrets. */
export async function issueChallenge(
  store: ObjectStore,
  pepper: string,
  hash: string,
  email: string,
  config: AuthConfig,
  now: number,
): Promise<IssuedChallenge> {
  const code = randomInt(0, 10 ** config.otp.codeLength)
    .toString()
    .padStart(config.otp.codeLength, "0");
  const linkSecret = randomBytes(24).toString("base64url");
  const challenge: Challenge = {
    email,
    ...testMarkerFor(email),
    codeHash: codeDigest(pepper, hash, code),
    linkHash: linkDigest(pepper, hash, linkSecret),
    createdAt: now,
    expiresAt: now + config.otp.ttlMinutes * 60_000,
    attempts: 0,
    consumed: false,
  };
  await store.put(keys.otp(hash), JSON.stringify(challenge));
  return { code, linkToken: `${hash}.${linkSecret}` };
}

export type Proof = { code: string } | { linkSecret: string };

export type VerifyOutcome = { ok: true; email: string } | { ok: false };

/**
 * Checks a code or link secret. Every evaluated attempt is a successful compare-and-swap that
 * bumps `attempts` (or marks the challenge consumed), so concurrent guesses can never exceed the
 * limit and a correct proof can win only once. Expired, locked, used and missing challenges are
 * all the same `{ ok: false }`.
 */
export async function verifyChallenge(
  store: ObjectStore,
  pepper: string,
  hash: string,
  proof: Proof,
  config: AuthConfig,
  now: number,
): Promise<VerifyOutcome> {
  let outcome: VerifyOutcome = { ok: false };
  try {
    await updateJson(store, keys.otp(hash), challengeSchema, (current) => {
      outcome = { ok: false };
      if (!current || current.consumed) return undefined;
      if (now > current.expiresAt || current.attempts >= config.otp.maxAttempts) return undefined;
      const matches =
        "code" in proof
          ? safeEqual(codeDigest(pepper, hash, proof.code), current.codeHash)
          : safeEqual(linkDigest(pepper, hash, proof.linkSecret), current.linkHash);
      if (matches) outcome = { ok: true, email: current.email };
      return { ...current, attempts: current.attempts + 1, consumed: matches };
    });
  } catch (err) {
    if (err instanceof ContentionError) return { ok: false };
    throw err;
  }
  if (outcome.ok) await store.delete(keys.otp(hash));
  return outcome;
}
