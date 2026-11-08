import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "./config.js";

export type Role = "customer" | "staff";

export interface ParsedEmail {
  /** The address as typed, trimmed and lowercased: where mail is sent. */
  address: string;
  /** Canonical form used for hashing: no +tag, and Gmail dots collapsed. */
  normalised: string;
  local: string;
  domain: string;
}

const EMAIL_PATTERN =
  /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Returns null for anything that is not a plain ASCII mailbox address. */
export function parseEmail(raw: string): ParsedEmail | null {
  const address = raw.trim().toLowerCase();
  if (address.length > 254 || !EMAIL_PATTERN.test(address)) return null;
  const at = address.lastIndexOf("@");
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  if (local.length === 0) return null;
  return { address, normalised: `${local}@${domain}`, local, domain };
}

/**
 * Marks records for identities that are plainly test data (`swarm-test-*` mailboxes, the SES
 * simulator), so `swarm test-cleanup` can find and remove them. Spread it into stored records.
 */
export const testMarker = (email: ParsedEmail): { test?: true } =>
  email.local.startsWith("swarm-test-") || email.domain === "simulator.amazonses.com"
    ? { test: true }
    : {};

/** `testMarker` for an address as typed; nothing for an unparseable one. */
export const testMarkerFor = (address: string): { test?: true } => {
  const email = parseEmail(address);
  return email ? testMarker(email) : {};
};

/** HMAC-SHA256 with the pepper; deterministic, and not reversible without the pepper. */
export function hmacHex(pepper: string, value: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export const emailHash = (pepper: string, email: ParsedEmail): string =>
  hmacHex(pepper, `email:${email.normalised}`);

export const ipHash = (pepper: string, ip: string): string => hmacHex(pepper, `ip:${ip}`);

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True for a listed domain or any subdomain of one. */
export function isDisposable(domain: string, config: AuthConfig): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (config.disposableDomains.includes(labels.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Staff = the exact staff domain (no subdomains or look-alikes) and a personal, not shared or role,
 * local part. The OTP proves control of the mailbox; shared addresses may be read by many people.
 */
export function deriveRole(email: ParsedEmail, config: AuthConfig): Role {
  if (email.domain !== config.staffDomain) return "customer";
  return config.reservedStaffLocalParts.includes(email.local) ? "customer" : "staff";
}
