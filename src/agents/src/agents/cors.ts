import { header } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

const PROBE_ORIGIN = "https://swarm-probe.invalid";
const STATE_CHANGING = /\b(PUT|DELETE|PATCH)\b/i;

const origin = (ctx: StepContext, value: string) =>
  ctx.http.request({
    url: ctx.appUrl.toString(),
    headers: { origin: value },
    maxRedirects: 0,
  });

async function preflight(ctx: StepContext): Promise<StepResult> {
  const res = await ctx.http.request({
    url: ctx.appUrl.toString(),
    method: "OPTIONS",
    headers: {
      origin: PROBE_ORIGIN,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "authorization,content-type",
    },
    maxRedirects: 0,
  });
  const allowed = header(res, "access-control-allow-origin");
  const methods = header(res, "access-control-allow-methods") ?? "";
  if ((allowed === PROBE_ORIGIN || allowed === "*") && STATE_CHANGING.test(methods)) {
    return {
      outcome: "finding",
      finding: {
        title: "Preflight allows state-changing methods from any origin",
        severity: "medium",
        component: `OPTIONS ${ctx.appUrl.pathname}`,
        description: `A preflight from an unrelated origin was answered with Access-Control-Allow-Origin: ${allowed} and Access-Control-Allow-Methods: ${methods}, so any website may be allowed to send PUT, PATCH or DELETE requests from a visitor's browser.`,
        remediation:
          "Answer preflights only for an explicit allow-list of trusted origins, and list only the methods those origins need.",
        mapping: "OWASP A05:2021 Security Misconfiguration",
      },
    };
  }
  return { outcome: "clear" };
}

async function reflected(ctx: StepContext): Promise<StepResult> {
  const res = await origin(ctx, PROBE_ORIGIN);
  const allowed = header(res, "access-control-allow-origin");
  if (allowed === PROBE_ORIGIN) {
    return {
      outcome: "finding",
      finding: {
        title: "CORS reflects any Origin",
        severity: "medium",
        component: `GET ${ctx.appUrl.pathname}`,
        description: `A request with Origin: ${PROBE_ORIGIN} was answered with Access-Control-Allow-Origin set to the same value, so the server trusts every origin that asks.`,
        remediation:
          "Compare the Origin header with an explicit allow-list and never echo it back blindly.",
        mapping: "OWASP A05:2021 Security Misconfiguration",
      },
    };
  }
  const nullOrigin = header(await origin(ctx, "null"), "access-control-allow-origin");
  if (nullOrigin === "null") {
    return {
      outcome: "finding",
      finding: {
        title: "CORS accepts the null origin",
        severity: "medium",
        component: `GET ${ctx.appUrl.pathname}`,
        description:
          "The server allows Origin: null, which sandboxed iframes and local files can send, so it can be used to bypass an origin allow-list.",
        remediation: "Do not allow the null origin.",
        mapping: "OWASP A05:2021 Security Misconfiguration",
      },
    };
  }
  if (allowed === "*") {
    return {
      outcome: "info",
      note: "The server allows any origin with a wildcard. That is fine for public data but must never be used with credentials.",
    };
  }
  return { outcome: "clear" };
}

async function credentials(ctx: StepContext): Promise<StepResult> {
  const res = await origin(ctx, PROBE_ORIGIN);
  const allowed = header(res, "access-control-allow-origin");
  const withCredentials = header(res, "access-control-allow-credentials")?.toLowerCase() === "true";
  if (allowed === PROBE_ORIGIN && withCredentials) {
    return {
      outcome: "finding",
      finding: {
        title: "Credentialed cross-origin access from any origin",
        severity: "high",
        component: `GET ${ctx.appUrl.pathname}`,
        description:
          "The server reflects any Origin and sets Access-Control-Allow-Credentials: true. A malicious website can make authenticated requests as a signed-in visitor and read the responses.",
        remediation:
          "Never combine a reflected origin with Access-Control-Allow-Credentials. Allow credentials only for explicitly trusted origins.",
        mapping: "OWASP A01:2021 Broken Access Control",
      },
    };
  }
  return { outcome: "clear" };
}

export const corsAgent: AgentModule = {
  id: "cors",
  task: "Probe cross-origin resource sharing policy",
  steps: { preflight, origin: reflected, credentials },
  doneSummary: ({ checks, findings }) =>
    `CORS review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
