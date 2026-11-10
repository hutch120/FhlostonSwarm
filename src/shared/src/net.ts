/**
 * Address checks shared by the intake (which looks at the URL text) and the scope proxy (which
 * looks at the addresses it is about to connect to), so both apply the same rule.
 */

export function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Loopback, private, link-local (cloud metadata), CGNAT, documentation, multicast and reserved ranges. */
export function isReservedIpv4([a, b, c]: number[]): boolean {
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

/** Unspecified, loopback, unique-local, link-local, multicast, documentation, 6to4, NAT64 and mapped private IPv4. */
export function isReservedIpv6(address: string): boolean {
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

/** True when `address` (an IPv4 or IPv6 literal, no brackets) is one the swarm must never reach. */
export function isReservedAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  return v4 ? isReservedIpv4(v4) : isReservedIpv6(address);
}

/** The ports a target's URLs name, plus 80 and 443: what the scope proxy may connect to. */
export function scopePorts(urls: readonly string[]): number[] {
  const ports = new Set([80, 443]);
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      ports.add(Number(url.port) || (url.protocol === "https:" ? 443 : 80));
    } catch {
      // An unparsable URL cannot widen the scope.
    }
  }
  return [...ports].sort((a, b) => a - b);
}
