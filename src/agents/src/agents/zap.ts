import { RequestFailed, header, headerValues } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

const missing = (names: string[]) => names.join(", ");

async function headers(ctx: StepContext): Promise<StepResult> {
  const page = await ctx.baseline();
  const csp = header(page, "content-security-policy");
  const absent: string[] = [];
  if (!csp) absent.push("Content-Security-Policy");
  if (!/nosniff/i.test(header(page, "x-content-type-options") ?? ""))
    absent.push("X-Content-Type-Options");
  const framing =
    header(page, "x-frame-options") || /frame-ancestors/i.test(csp ?? "")
      ? null
      : "X-Frame-Options (or CSP frame-ancestors)";
  if (framing) absent.push(framing);
  if (!header(page, "referrer-policy")) absent.push("Referrer-Policy");
  if (!header(page, "permissions-policy")) absent.push("Permissions-Policy");
  if (absent.length === 0) return { outcome: "clear" };
  const important = !csp || framing !== null;
  return {
    outcome: "finding",
    finding: {
      title: `Security headers missing: ${missing(absent)}`,
      severity: important ? "medium" : "low",
      component: `GET ${new URL(page.url).pathname}`,
      description: `The response does not send ${missing(absent)}. These headers are a cheap second line of defence against XSS, clickjacking and content sniffing.`,
      remediation:
        "Add the missing headers at the web server or CDN: a restrictive Content-Security-Policy, X-Content-Type-Options: nosniff, frame-ancestors (or X-Frame-Options), Referrer-Policy and Permissions-Policy.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

interface Probe {
  path: string;
  /** The response must look like this to count; guards against catch-all pages returning 200. */
  looksLike: (body: string, contentType: string) => boolean;
  what: string;
}

const SENSITIVE_PATHS: Probe[] = [
  {
    path: "/.git/HEAD",
    looksLike: (b) => /^ref: refs\//.test(b.trim()),
    what: "Git repository metadata",
  },
  {
    path: "/.git/config",
    looksLike: (b) => /^\[core\]/m.test(b),
    what: "Git repository configuration",
  },
  {
    path: "/.env",
    looksLike: (b, type) => !/html/i.test(type) && /^[A-Z][A-Z0-9_]*=.+$/m.test(b),
    what: "Environment file",
  },
];

async function passive(ctx: StepContext): Promise<StepResult> {
  const exposed: string[] = [];
  for (const probe of SENSITIVE_PATHS) {
    const res = await ctx.http.request({
      url: new URL(probe.path, ctx.appUrl).toString(),
      maxRedirects: 0,
    });
    if (res.status === 200 && probe.looksLike(res.body, header(res, "content-type") ?? "")) {
      exposed.push(`${probe.path} (${probe.what})`);
    }
  }
  if (exposed.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: `Sensitive files exposed: ${exposed.map((e) => e.split(" ")[0]).join(", ")}`,
      severity: "high",
      component: exposed.map((e) => `GET ${e.split(" ")[0]}`).join(", "),
      description: `The web server serves files that should never be public: ${exposed.join("; ")}. Source code history, configuration and secrets can often be recovered from them.`,
      remediation:
        "Remove these files from the web root, deny access to dot-directories at the web server, and rotate any secret that may have been exposed.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

interface CookieFlags {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: boolean;
}

function parseCookie(line: string): CookieFlags {
  const [pair = "", ...attributes] = line.split(";").map((p) => p.trim().toLowerCase());
  return {
    name: pair.split("=")[0] ?? "",
    httpOnly: attributes.includes("httponly"),
    secure: attributes.includes("secure"),
    sameSite: attributes.some((a) => a.startsWith("samesite=")),
  };
}

async function cookies(ctx: StepContext): Promise<StepResult> {
  const page = await ctx.baseline();
  const lines = headerValues(page, "set-cookie");
  if (lines.length === 0) return { outcome: "info", note: "The page sets no cookies." };
  const https = new URL(page.url).protocol === "https:";
  const problems: string[] = [];
  let sessionLike = false;
  for (const cookie of lines.map(parseCookie)) {
    const lacks = [
      ...(cookie.httpOnly ? [] : ["HttpOnly"]),
      ...(cookie.secure || !https ? [] : ["Secure"]),
      ...(cookie.sameSite ? [] : ["SameSite"]),
    ];
    if (lacks.length === 0) continue;
    problems.push(`${cookie.name} (no ${lacks.join(", ")})`);
    if (/sess|sid|token|auth|jwt/i.test(cookie.name)) sessionLike = true;
  }
  if (problems.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Cookies are missing security attributes",
      severity: sessionLike ? "medium" : "low",
      component: `Set-Cookie on GET ${new URL(page.url).pathname}`,
      description: `These cookies lack protective attributes: ${problems.join("; ")}. Without HttpOnly a script can read them; without Secure they travel over HTTP; without SameSite they are sent on cross-site requests.`,
      remediation:
        "Set HttpOnly, Secure and SameSite=Lax (or Strict) on every cookie that is not meant for scripts.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

const LEAKS: RegExp[] = [
  /\bat\s+[\w$.<>[\] ]+\s+\((?:file:\/\/)?[^)\n]*:\d+:\d+\)/,
  /Traceback \(most recent call last\)/,
  /\bat [\w.$]+\([\w$]+\.java:\d+\)/,
  /Exception in thread/,
  /SQLSTATE\[|ORA-\d{5}|syntax error at or near/i,
  /node_modules[\\/]/,
];

async function errors(ctx: StepContext): Promise<StepResult> {
  const probes = ["/%", "/swarm-probe-not-found"];
  const leaking: string[] = [];
  for (const path of probes) {
    try {
      const res = await ctx.http.request({
        url: new URL(path, ctx.appUrl).toString(),
        maxRedirects: 0,
      });
      if (res.status >= 400 && LEAKS.some((pattern) => pattern.test(res.body))) {
        leaking.push(`${path} (${res.status})`);
      }
    } catch (err) {
      if (!(err instanceof RequestFailed)) throw err;
    }
  }
  if (leaking.length === 0) return { outcome: "clear" };
  return {
    outcome: "finding",
    finding: {
      title: "Error pages reveal internal details",
      severity: "medium",
      component: leaking.map((l) => `GET ${l.split(" ")[0]}`).join(", "),
      description: `Provoked errors return stack traces or internal paths (${leaking.join(", ")}). These help an attacker map the framework, file layout and versions.`,
      remediation:
        "Return a generic error page in production and log details server-side. Turn off debug and development error handlers.",
      mapping: "OWASP A05:2021 Security Misconfiguration",
    },
  };
}

export const zapAgent: AgentModule = {
  id: "zap",
  task: "Audit headers, cookies, exposed files and error handling",
  steps: { headers, passive, cookies, errors },
  doneSummary: ({ checks, findings }) =>
    `Scanner pass finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
