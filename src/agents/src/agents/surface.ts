import { header } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

const asGap = (reason: string): StepResult => ({ outcome: "gap", reason });

async function crawl(ctx: StepContext): Promise<StepResult> {
  if (!ctx.explorer)
    return asGap("The explorer is not available in this run, so pages were not crawled.");
  const result = await ctx.explorer.crawlPublic();
  const pages = ctx.explorer.pages;
  if (pages.length === 0) {
    return asGap(result.reason ?? "The explorer did not reach any page of the application.");
  }
  const paths = [...new Set(pages.map((p) => new URL(p.url).pathname))];
  return {
    outcome: "info",
    note: `Explored ${paths.length} ${paths.length === 1 ? "page" : "pages"}: ${paths.slice(0, 15).join(", ")}${paths.length > 15 ? ", and more" : ""}.`,
    ...(result.end !== "done" && result.reason ? { gaps: [result.reason] } : {}),
  };
}

const VERSIONED = /\d+\.\d+/;

async function fingerprint(ctx: StepContext): Promise<StepResult> {
  const page = await ctx.baseline();
  const seen: string[] = [];
  for (const name of ["server", "x-powered-by", "x-aspnet-version", "x-generator"]) {
    const value = header(page, name);
    if (value) seen.push(`${name}: ${value}`);
  }
  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(
    page.body,
  )?.[1];
  if (generator) seen.push(`generator: ${generator}`);
  if (seen.length === 0) return { outcome: "clear" };
  if (!seen.some((s) => VERSIONED.test(s))) {
    return {
      outcome: "info",
      note: `The response names its software (${seen.join("; ")}) but not a version.`,
    };
  }
  return {
    outcome: "finding",
    finding: {
      title: "Server software and version are disclosed",
      severity: "low",
      component: `Response headers of GET ${new URL(page.url).pathname}`,
      description: `The response tells every visitor what it runs and which version (${seen.join("; ")}). Attackers use this to pick known vulnerabilities for that exact version.`,
      remediation:
        "Remove or genericise the Server, X-Powered-By and similar headers at the web server or CDN, and keep the software patched either way.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

const SENSITIVE_HINT =
  /admin|internal|backup|private|secret|staging|debug|config|\.git|dump|export/i;

async function robots(ctx: StepContext): Promise<StepResult> {
  const robotsRes = await ctx.http.request({
    url: new URL("/robots.txt", ctx.appUrl).toString(),
    maxRedirects: 0,
  });
  const hasRobots =
    robotsRes.status === 200 && /^\s*(user-agent|disallow|sitemap)\s*:/im.test(robotsRes.body);
  const disallowed = hasRobots
    ? [...robotsRes.body.matchAll(/^\s*disallow\s*:\s*(\S+)/gim)].map((m) => m[1]!)
    : [];
  const sitemapRes = await ctx.http.request({
    url: new URL("/sitemap.xml", ctx.appUrl).toString(),
    maxRedirects: 0,
  });
  const hasSitemap = sitemapRes.status === 200 && /<urlset|<sitemapindex/i.test(sitemapRes.body);
  if (!hasRobots && !hasSitemap) return { outcome: "clear" };
  const hints = disallowed.filter((p) => SENSITIVE_HINT.test(p));
  const parts = [
    hasRobots
      ? `robots.txt lists ${disallowed.length} disallowed ${disallowed.length === 1 ? "path" : "paths"}`
      : "",
    hasSitemap ? "a sitemap is published" : "",
  ].filter(Boolean);
  return {
    outcome: "info",
    note: `${parts.join(" and ")}${hints.length > 0 ? `. Paths that hint at sensitive areas: ${hints.join(", ")}. A disallow line also tells attackers where to look, so it is no substitute for access control` : ""}.`,
  };
}

const API_PATH = /["'`](\/(?:api|graphql|v\d+)\/[A-Za-z0-9_\-/{}:.]*)["'`]/g;

async function endpoints(ctx: StepContext): Promise<StepResult> {
  const found = new Set<string>();
  const add = (text: string) => {
    for (const m of text.matchAll(API_PATH)) found.add(m[1]!);
  };
  for (const page of ctx.explorer?.pages ?? []) {
    for (const form of page.forms) {
      const path = new URL(form.action).pathname;
      if (/^\/(api|graphql|v\d+)\b/.test(path)) found.add(`${form.method.toUpperCase()} ${path}`);
    }
    for (const link of page.links) {
      const path = new URL(link.href).pathname;
      if (/^\/(api|graphql|v\d+)\b/.test(path)) found.add(path);
    }
  }
  const { external, inline } = await ctx.pageScripts();
  for (const code of inline) add(code);
  for (const url of external.slice(0, 8)) {
    const body = await ctx.scriptBody(url);
    if (body) add(body);
  }
  if (found.size === 0) return { outcome: "clear" };
  const list = [...found].sort();
  return {
    outcome: "info",
    note: `Found ${list.length} API ${list.length === 1 ? "endpoint" : "endpoints"} referenced by the pages: ${list.slice(0, 12).join(", ")}${list.length > 12 ? ", and more" : ""}.`,
  };
}

export const surfaceAgent: AgentModule = {
  id: "surface",
  task: "Crawl the public pages and map what they expose",
  steps: { crawl, fingerprint, robots, endpoints },
  doneSummary: ({ checks, findings }) =>
    `Surface mapping finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
