import type { AgentModule, StepContext, StepResult } from "../types.js";

const MAX_SCRIPTS = 10;

/** Scripts served by the application itself (a third party's bundle is not ours to report on). */
const ownScripts = async (ctx: StepContext): Promise<string[]> => {
  const { external } = await ctx.pageScripts();
  return external
    .filter((url) => new URL(url).hostname === ctx.appUrl.hostname)
    .slice(0, MAX_SCRIPTS);
};

async function download(ctx: StepContext): Promise<StepResult> {
  const scripts = await ownScripts(ctx);
  if (scripts.length === 0) {
    return {
      outcome: "info",
      note: "The pages load no JavaScript from the application's own host.",
    };
  }
  let bytes = 0;
  let fetched = 0;
  for (const url of scripts) {
    const body = await ctx.scriptBody(url);
    if (body !== null) {
      fetched += 1;
      bytes += body.length;
    }
  }
  return {
    outcome: "info",
    note: `Downloaded ${fetched} of ${scripts.length} script ${scripts.length === 1 ? "file" : "files"} (${Math.round(bytes / 1024)} KB).`,
  };
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Stripe live secret key", pattern: /\bsk_live_[0-9a-zA-Z]{20,}\b/g },
];

/** The first characters only: enough to find it, not enough to use it. */
const mask = (value: string) =>
  `${value.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(0, value.length - 4)))}`;

async function secrets(ctx: StepContext): Promise<StepResult> {
  const { inline } = await ctx.pageScripts();
  const bodies: { where: string; code: string }[] = inline.map((code) => ({
    where: "an inline script",
    code,
  }));
  for (const url of await ownScripts(ctx)) {
    const code = await ctx.scriptBody(url);
    if (code) bodies.push({ where: new URL(url).pathname, code });
  }
  const hits: string[] = [];
  const where = new Set<string>();
  for (const { where: at, code } of bodies) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      for (const m of code.matchAll(pattern)) {
        hits.push(`${name} (${mask(m[0])}) in ${at}`);
        where.add(at);
      }
    }
  }
  if (hits.length === 0) return { outcome: "clear" };
  const unique = [...new Set(hits)];
  return {
    outcome: "finding",
    finding: {
      title: "Secrets are exposed in public JavaScript",
      severity: "high",
      component: [...where].map((w) => `GET ${w}`).join(", "),
      description: `Credentials are embedded in files anyone can download: ${unique.join("; ")}. Treat them as compromised, because a bundle is public the moment it is deployed.`,
      remediation:
        "Revoke and rotate each credential now, move it to a server-side service, and keep only public, restricted keys in client code.",
      mapping: "OWASP A02:2021 Cryptographic Failures",
    },
  };
}

async function sourcemaps(ctx: StepContext): Promise<StepResult> {
  const exposed: string[] = [];
  for (const url of await ownScripts(ctx)) {
    const code = await ctx.scriptBody(url);
    if (code === null) continue;
    const declared = /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(code)?.[1];
    if (!declared || declared.startsWith("data:")) continue;
    const mapUrl = new URL(declared, url).toString();
    if (new URL(mapUrl).hostname !== ctx.appUrl.hostname) continue;
    const res = await ctx.http.request({ url: mapUrl, maxRedirects: 0 });
    if (res.status === 200 && /"sources"\s*:/.test(res.body) && /"version"\s*:/.test(res.body)) {
      exposed.push(new URL(mapUrl).pathname);
    }
  }
  if (exposed.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Source maps are publicly available",
      severity: "medium",
      component: exposed.map((e) => `GET ${e}`).join(", "),
      description: `The production build serves its source maps (${exposed.join(", ")}). They let anyone read the original source, comments and internal paths, which makes finding other weaknesses much easier.`,
      remediation:
        "Do not deploy source maps to production, or upload them only to your error-tracking service and block them at the web server.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

export const bundleAgent: AgentModule = {
  id: "bundle",
  task: "Download the JavaScript and look for secrets and source maps",
  steps: { download, secrets, sourcemaps },
  doneSummary: ({ checks, findings }) =>
    `Bundle review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
