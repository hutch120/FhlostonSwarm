import { headerValues } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

const gap = (reason: string): StepResult => ({ outcome: "gap", reason });

async function login(ctx: StepContext): Promise<StepResult> {
  if (Object.keys(ctx.input.logins).length === 0) {
    return gap("No login was supplied, so the signed-in side was not reviewed.");
  }
  if (!ctx.explorer)
    return gap("The explorer is not available in this run, so no sign-in was attempted.");
  const result = await ctx.explorer.exploreSignedIn();
  const attempts = ctx.explorer.signIns;
  const worked = attempts.filter((a) => a.ok);
  if (worked.length === 0) {
    return gap(
      result.reason ??
        "The sign-in did not succeed with the supplied login, so the signed-in side was not explored.",
    );
  }

  const issues: string[] = [];
  const https = (url: string) => url.startsWith("https:");
  if (worked.some((w) => w.insecureTransport)) {
    issues.push("the sign-in form sends credentials over unencrypted HTTP");
  }
  const weak = new Set<string>();
  for (const attempt of worked) {
    for (const cookie of attempt.cookies) {
      const lacks = [
        ...(cookie.httpOnly ? [] : ["HttpOnly"]),
        ...(cookie.secure || !https(ctx.appUrl.toString()) ? [] : ["Secure"]),
      ];
      if (lacks.length > 0 && /sess|sid|token|auth|jwt/i.test(cookie.name)) {
        weak.add(`${cookie.name} (no ${lacks.join(", ")})`);
      }
    }
  }
  if (weak.size > 0) {
    issues.push(
      `the session cookie set at sign-in lacks protective attributes: ${[...weak].join(", ")}`,
    );
  }

  const extra = result.end !== "done" && result.reason ? [result.reason] : [];
  if (issues.length === 0) {
    return extra.length > 0
      ? {
          outcome: "info",
          note: `Signed in as ${worked.map((w) => w.description).join(", ")}.`,
          gaps: extra,
        }
      : { outcome: "clear" };
  }
  const plainHttp = worked.some((w) => w.insecureTransport);
  return {
    outcome: "finding",
    finding: {
      title: "Sign-in handling has weaknesses",
      severity: plainHttp ? "high" : "medium",
      component: `Sign-in at ${ctx.appUrl.origin}`,
      description: `Signing in worked, and it showed that ${issues.join("; and ")}. Credentials and session tokens are the keys to every account, so they need the strongest protection.`,
      remediation:
        "Serve the whole application over HTTPS only (redirect HTTP and set HSTS), and set HttpOnly, Secure and SameSite on the session cookie.",
      mapping: "OWASP A07:2021 Identification and Authentication Failures",
      evidence: issues.map((i) => i.charAt(0).toUpperCase() + i.slice(1) + "."),
      // Independent look: a fresh request for the page the sign-in form is on, and its cookies.
      replay: async () => {
        const page = await ctx.http.request({ url: ctx.appUrl.toString(), maxRedirects: 0 });
        const cookies = headerValues(page, "set-cookie").filter((c) =>
          /sess|sid|token|auth|jwt/i.test(c.split("=")[0] ?? ""),
        );
        const unflagged = cookies.filter((c) => !/;\s*httponly/i.test(c));
        const plain =
          plainHttp && ctx.appUrl.protocol === "http:" && /type=["']?password/i.test(page.body);
        return {
          confirmed: plain || unflagged.length > 0,
          note: `Fetched the sign-in page again: ${plain ? "it still has a password form served over plain HTTP; " : ""}${unflagged.length} of ${cookies.length} session-like cookies it sets lack HttpOnly.`,
        };
      },
    },
  };
}

async function lockout(): Promise<StepResult> {
  return gap(
    "Brute-force and lockout behaviour needs repeated sign-in attempts, which a read-only scan does not make, so it was not tested.",
  );
}

const RESET = /forgot|reset|recover/i;

async function reset(ctx: StepContext): Promise<StepResult> {
  const pages = ctx.explorer?.pages ?? [];
  if (pages.length === 0)
    return gap("No page was explored, so the password reset flow was not looked for.");
  const found = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      if (RESET.test(link.text) || RESET.test(new URL(link.href).pathname)) {
        found.add(new URL(link.href).pathname);
      }
    }
    for (const form of page.forms) {
      const path = new URL(form.action).pathname;
      if (RESET.test(path)) found.add(path);
    }
  }
  return found.size > 0
    ? {
        outcome: "info",
        note: `A password reset flow is offered (${[...found].join(", ")}). It was not exercised, because a reset sends email and changes state.`,
      }
    : { outcome: "info", note: "No password reset link was found on the pages explored." };
}

const SECOND_FACTOR = /verification code|authenticator|one-time|two-factor|2fa|mfa|security code/i;

async function mfa(ctx: StepContext): Promise<StepResult> {
  const worked = (ctx.explorer?.signIns ?? []).filter((a) => a.ok);
  if (worked.length === 0)
    return gap("No sign-in succeeded, so multi-factor behaviour was not observed.");
  const landing = ctx.explorer!.pages.find(
    (p) => new URL(p.url).pathname === worked[0]!.landedPath,
  );
  if (landing && SECOND_FACTOR.test(landing.text)) {
    return { outcome: "info", note: "The sign-in asked for a second factor." };
  }
  return {
    outcome: "info",
    note: "The sign-in did not ask for a second factor. Whether multi-factor authentication is available as an option cannot be seen from outside.",
  };
}

export const authnAgent: AgentModule = {
  id: "authn",
  task: "Sign in with the supplied login and review how it behaves",
  steps: { login, lockout, reset, mfa },
  doneSummary: ({ checks, findings }) =>
    `Sign-in review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
