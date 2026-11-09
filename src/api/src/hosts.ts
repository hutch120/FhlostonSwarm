import { getDomain, parse } from "tldts";
import type { IntakeConfig } from "./config.js";

export type HostProblem =
  "invalid_url" | "credentials_in_url" | "private_address" | "unroutable_host" | "blocked_host";

export type ParsedTargetUrl =
  | { ok: true; hostname: string; registrableDomain: string | null }
  | { ok: false; problem: HostProblem };

const fail = (problem: HostProblem): ParsedTargetUrl => ({ ok: false, problem });

const inDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Loopback, private, link-local (cloud metadata), CGNAT, documentation, multicast and reserved ranges. */
function isReservedIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

/** Expands an IPv6 literal (no brackets) into eight 16-bit groups; null if malformed. */
function ipv6Groups(address: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(address)) return null;
  const sides = address.split("::");
  if (sides.length > 2) return null;
  const toGroups = (side: string) => (side === "" ? [] : side.split(":"));
  const head = toGroups(sides[0]!);
  const tail = sides.length === 2 ? toGroups(sides[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (sides.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(sides.length === 2 ? missing : 0).fill("0"), ...tail];
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

function isReservedIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  return (
    g.every((x) => x === 0) ||
    (g.slice(0, 7).every((x) => x === 0) && g7 === 1) ||
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address.
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
      ? isReservedIpv4(embeddedV4)
      : false) ||
    (g0 === 0x64 && g1 === 0xff9b) ||
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xff00) === 0xff00 ||
    g0 === 0x2002 ||
    (g0 === 0x2001 && g1 === 0x0db8)
  );
}

/**
 * Checks a customer-supplied URL before it becomes a scan target: http(s) only, no embedded
 * credentials, no private or metadata addresses, no internal-only names, and none of the blocked
 * domains (our own, other well-known services, public-sector suffixes). The hostname is lowercased.
 * DNS is not resolved here; the egress proxy enforces the same rule on the addresses it connects to.
 */
export function parseTargetUrl(raw: string, config: IntakeConfig): ParsedTargetUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("invalid_url");
  if (url.username || url.password) return fail("credentials_in_url");

  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    return isReservedIpv6(host.slice(1, -1))
      ? fail("private_address")
      : { ok: true, hostname: host, registrableDomain: null };
  }
  const v4 = ipv4Octets(host);
  if (v4) {
    return isReservedIpv4(v4)
      ? fail("private_address")
      : { ok: true, hostname: host, registrableDomain: null };
  }

  const { unroutable, domains, suffixes } = config.blockedHosts;
  const trimmed = host.replace(/\.$/, "");
  if (!trimmed.includes(".") || unroutable.some((s) => inDomain(trimmed, s)))
    return fail("unroutable_host");
  const registrable = getDomain(trimmed);
  if (!registrable || parse(trimmed).isIp) return fail("invalid_url");
  if (domains.some((d) => inDomain(trimmed, d)) || suffixes.some((s) => inDomain(trimmed, s)))
    return fail("blocked_host");
  return { ok: true, hostname: trimmed, registrableDomain: registrable };
}
