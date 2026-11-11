import { randomInt } from "node:crypto";
import { z } from "zod";
import type { AuthConfig } from "./config.js";
import { hmacHex, safeEqual } from "./identity.js";
import { getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/** Lowercase letters and digits without the look-alikes i, l, o, 0 and 1. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 4;
const LENGTH = GROUPS * GROUP_LENGTH;

const passcodeSchema = z.object({
  email: z.string(),
  codeHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const testPasscodeLifetimeSchema = z.enum(["hour", "day", "week", "month"]);
export type TestPasscodeLifetime = z.infer<typeof testPasscodeLifetimeSchema>;

export interface IssuedTestPasscode {
  /** `xxxx-xxxx-xxxx-xxxx`, shown once. */
  code: string;
  expiresAt: number;
}

/** Drops case, dashes and spaces, so a pasted passcode matches however it was typed. */
export const normalisePasscode = (raw: string): string => raw.toLowerCase().replace(/[\s-]/g, "");

/** True when `raw` has the shape of a test passcode (never all digits, so never a normal code). */
export const looksLikePasscode = (raw: string): boolean =>
  new RegExp(`^[${ALPHABET}]{${LENGTH}}$`).test(normalisePasscode(raw));

const digest = (pepper: string, hash: string, code: string) =>
  hmacHex(pepper, `testpass:${hash}:${normalisePasscode(code)}`);

/**
 * A long-lived, reusable sign-in code for hands-on testing, so a tester need not read a mailbox.
 * Long and random (about 79 bits) because, unlike an emailed code, it is not single-use; one per
 * account, and issuing another replaces it.
 */
export async function issueTestPasscode(
  store: ObjectStore,
  pepper: string,
  hash: string,
  email: string,
  lifetime: TestPasscodeLifetime,
  config: AuthConfig,
  now: number,
): Promise<IssuedTestPasscode> {
  const raw = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const code = raw.match(new RegExp(`.{${GROUP_LENGTH}}`, "g"))!.join("-");
  const expiresAt = now + config.testPasscode.lifetimeMinutes[lifetime] * 60_000;
  await putJson(store, keys.testPasscode(hash), {
    email,
    codeHash: digest(pepper, hash, code),
    createdAt: now,
    expiresAt,
  });
  return { code, expiresAt };
}

/** The account's email when `code` is its live test passcode. Expiry is checked on every use. */
export async function verifyTestPasscode(
  store: ObjectStore,
  pepper: string,
  hash: string,
  code: string,
  now: number,
): Promise<{ ok: true; email: string } | { ok: false }> {
  const found = await getJson(store, keys.testPasscode(hash), passcodeSchema);
  if (!found || now > found.value.expiresAt) return { ok: false };
  return safeEqual(digest(pepper, hash, code), found.value.codeHash)
    ? { ok: true, email: found.value.email }
    : { ok: false };
}
