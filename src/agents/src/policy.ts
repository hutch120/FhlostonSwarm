import { isReservedAddress, scopePorts } from "@swarm/shared/server";

/** What the proxy lets through: the declared hosts and ports, and only safe methods when read-only. */
export interface Scope {
  hosts: readonly string[];
  ports: readonly number[];
  readOnly: boolean;
}

export type Denial =
  | "host_not_in_scope"
  | "port_not_allowed"
  | "method_not_allowed"
  | "address_blocked"
  | "request_cap_reached"
  | "bad_request";

export type Decision = { allow: true } | { allow: false; reason: Denial };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const normaliseHost = (host: string): string =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * The single allow-list function (PLAN.md section 6): is this host, port and method inside the
 * customer's declared scope? Address checks come after DNS (`checkResolved`).
 */
export function decide(
  request: { method: string; host: string; port: number },
  scope: Scope,
): Decision {
  const host = normaliseHost(request.host);
  if (!host || !Number.isInteger(request.port)) return { allow: false, reason: "bad_request" };
  if (!scope.hosts.some((h) => normaliseHost(h) === host))
    return { allow: false, reason: "host_not_in_scope" };
  if (!scope.ports.includes(request.port)) return { allow: false, reason: "port_not_allowed" };
  if (scope.readOnly && request.method !== "CONNECT" && !isSafeMethod(request.method))
    return { allow: false, reason: "method_not_allowed" };
  return { allow: true };
}

/**
 * Picks the address to connect to from what DNS returned. Every address must be public: one
 * private answer refuses the host (DNS rebinding and split-horizon names), unless the caller opted
 * in for local development.
 */
export function checkResolved(
  addresses: readonly string[],
  { allowPrivate = false }: { allowPrivate?: boolean } = {},
): { ok: true; address: string } | { ok: false; reason: Denial } {
  if (addresses.length === 0) return { ok: false, reason: "address_blocked" };
  if (!allowPrivate && addresses.some((a) => isReservedAddress(a)))
    return { ok: false, reason: "address_blocked" };
  return { ok: true, address: addresses[0]! };
}

/** Ports a target's URLs name, plus 80 and 443. */
export { scopePorts };
