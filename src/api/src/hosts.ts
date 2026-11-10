import { ipv4Octets, isReservedIpv4, isReservedIpv6 } from "@swarm/shared/server";
import { getDomain, parse } from "tldts";
import type { IntakeConfig } from "./config.js";

export type HostProblem =
  "invalid_url" | "credentials_in_url" | "private_address" | "unroutable_host" | "blocked_host";

export type ParsedTargetUrl =
  | { ok: true; hostname: string; registrableDomain: string | null }
  | { ok: false; problem: HostProblem };

const fail = (problem: HostProblem): ParsedTargetUrl => ({ ok: false, problem });

const inDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

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
