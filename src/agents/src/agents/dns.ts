import { Resolver } from "node:dns/promises";
import net from "node:net";
import { getDomain } from "tldts";
import type { AgentModule, DnsAnswer, DnsClient, StepContext, StepResult } from "../types.js";

/** Name lookups through the platform resolver: asks for records only and connects to nothing. */
export const systemDns = (): DnsClient => {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  return {
    async records(host, type): Promise<DnsAnswer> {
      try {
        switch (type) {
          case "A":
            return { ok: true, values: await resolver.resolve4(host) };
          case "AAAA":
            return { ok: true, values: await resolver.resolve6(host) };
          case "CNAME":
            return { ok: true, values: await resolver.resolveCname(host) };
          case "NS":
            return { ok: true, values: await resolver.resolveNs(host) };
          case "MX":
            return {
              ok: true,
              values: (await resolver.resolveMx(host)).map((m) => `${m.priority} ${m.exchange}`),
            };
          case "TXT":
            return {
              ok: true,
              values: (await resolver.resolveTxt(host)).map((chunks) => chunks.join("")),
            };
          case "CAA":
            return {
              ok: true,
              values: (await resolver.resolveCaa(host)).map((c) => JSON.stringify(c)),
            };
        }
      } catch (err) {
        return { ok: false, code: (err as { code?: string }).code ?? "ERROR" };
      }
    },
  };
};

/** The declared hosts that have DNS names (an IP address or `localhost` has no records to check). */
const nameHosts = (ctx: StepContext): string[] =>
  ctx.input.scope.hosts.filter(
    (h) => net.isIP(h) === 0 && h !== "localhost" && !h.endsWith(".localhost"),
  );

const NOT_THERE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function records(ctx: StepContext): Promise<StepResult> {
  const hosts = nameHosts(ctx);
  if (hosts.length === 0) {
    return {
      outcome: "info",
      note: "The target is an IP address, so it has no DNS records to check.",
    };
  }
  const apexes = new Set(hosts.map((h) => getDomain(h) ?? h));
  const problems: string[] = [];
  const found: string[] = [];
  for (const apex of apexes) {
    const [mx, txt, dmarc] = await Promise.all([
      ctx.dns.records(apex, "MX"),
      ctx.dns.records(apex, "TXT"),
      ctx.dns.records(`_dmarc.${apex}`, "TXT"),
    ]);
    const sendsMail = mx.ok && mx.values.length > 0;
    const spf = txt.ok && txt.values.some((v) => /^v=spf1\b/i.test(v));
    const hasDmarc = dmarc.ok && dmarc.values.some((v) => /^v=DMARC1\b/i.test(v));
    found.push(`${apex}: ${sendsMail ? "mail enabled" : "no mail records"}`);
    if (sendsMail && !spf) problems.push(`${apex} has mail records but no SPF record`);
    if (sendsMail && !hasDmarc) problems.push(`${apex} has mail records but no DMARC policy`);
  }
  if (problems.length === 0) {
    return { outcome: "info", note: `DNS records reviewed (${found.join("; ")}).` };
  }
  return {
    outcome: "finding",
    finding: {
      title: "Email spoofing protections are missing from DNS",
      severity: "low",
      component: [...apexes].map((a) => `DNS ${a}`).join(", "),
      description: `${problems.join("; ")}. Without SPF and DMARC, anyone can send email that appears to come from the domain.`,
      remediation:
        "Publish an SPF record listing the servers that send your mail, and a DMARC policy (start with p=none and reporting, then move to quarantine or reject).",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

async function takeover(ctx: StepContext): Promise<StepResult> {
  const hosts = nameHosts(ctx);
  if (hosts.length === 0) return { outcome: "clear" };
  const dangling: string[] = [];
  for (const host of hosts) {
    const cname = await ctx.dns.records(host, "CNAME");
    if (!cname.ok || cname.values.length === 0) continue;
    for (const target of cname.values) {
      const resolved = await ctx.dns.records(target, "A");
      if (!resolved.ok && NOT_THERE.has(resolved.code)) {
        dangling.push(`${host} -> ${target}`);
      }
    }
  }
  if (dangling.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Dangling DNS alias could allow a subdomain takeover",
      severity: "high",
      component: dangling.map((d) => `DNS ${d.split(" ")[0]}`).join(", "),
      description: `These names point at a target that no longer exists: ${dangling.join("; ")}. If the target is a hosted service name, someone else may be able to claim it and serve content on your domain.`,
      remediation:
        "Delete the alias or point it at a live resource. Review DNS for other records that outlived their service.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

const EXTERNAL = (what: string) => async (): Promise<StepResult> => ({
  outcome: "gap",
  reason: `${what} come from an outside registry service, which scans do not contact yet, so this was not checked.`,
});

export const dnsAgent: AgentModule = {
  id: "dns",
  task: "Review DNS records and aliases",
  steps: {
    records,
    whois: EXTERNAL("Registrar details and the registry lock"),
    ct: EXTERNAL("Certificate transparency logs"),
    takeover,
  },
  doneSummary: ({ checks, findings }) =>
    `DNS review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
