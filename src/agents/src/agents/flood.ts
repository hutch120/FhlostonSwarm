import { RequestFailed } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

/** Requests fired at once per step. Kept small: this still has to fit the run's request budget. */
const RATE_BURST = 15;
const LOAD_BURST = 30;
/** Share of a load burst that must fail before it counts as degraded, not just a little noise. */
const DEGRADED_SHARE = 0.2;

/** Fires `count` concurrent GETs at the application URL; a blocked one (budget, scope) is `null`. */
async function burst(ctx: StepContext, count: number): Promise<(number | null)[]> {
  const url = ctx.appUrl.toString();
  return Promise.all(
    Array.from({ length: count }, async () => {
      try {
        const res = await ctx.http.request({ url, maxRedirects: 0 });
        return res.status;
      } catch (err) {
        if (err instanceof RequestFailed) return null;
        throw err;
      }
    }),
  );
}

async function rateLimit(ctx: StepContext): Promise<StepResult> {
  const statuses = await burst(ctx, RATE_BURST);
  const answered = statuses.filter((s): s is number => s !== null);
  if (answered.length === 0) {
    return {
      outcome: "gap",
      reason: "A burst of concurrent requests got no answer, so rate limiting could not be observed.",
    };
  }
  const throttled = answered.filter((s) => s === 429 || s === 503).length;
  if (throttled > 0) {
    return {
      outcome: "info",
      note: `${throttled} of ${answered.length} concurrent requests were throttled (429/503): the application limits request bursts.`,
    };
  }
  return {
    outcome: "finding",
    finding: {
      title: "No rate limiting observed under a concurrent request burst",
      severity: "low",
      component: `GET ${ctx.appUrl.pathname || "/"}`,
      description: `${answered.length} concurrent requests all answered normally; none were refused with 429 or 503. Without a rate limit, a single client can send unlimited traffic, which makes resource-exhaustion attacks cheaper to run.`,
      remediation:
        "Add request-rate limiting (per IP, per session or per API key) at the application or edge layer, with a 429 response once the limit is reached.",
      mapping: "OWASP API4:2023 Unrestricted Resource Consumption",
    },
  };
}

async function availability(ctx: StepContext): Promise<StepResult> {
  const statuses = await burst(ctx, LOAD_BURST);
  const answered = statuses.filter((s): s is number => s !== null);
  if (answered.length === 0) {
    return {
      outcome: "gap",
      reason: "A larger burst of concurrent requests got no answer, so availability under load could not be observed.",
    };
  }
  const failed = answered.filter((s) => s >= 500).length;
  const dropped = statuses.length - answered.length;
  const hurt = failed + dropped;
  if (hurt === 0) return { outcome: "clear" };
  if (hurt / statuses.length < DEGRADED_SHARE) {
    return {
      outcome: "info",
      note: `${hurt} of ${statuses.length} requests under a concurrent burst failed, errored or got no answer; most still answered normally.`,
    };
  }
  return {
    outcome: "finding",
    finding: {
      title: "The application degrades under a moderate concurrent load",
      severity: "medium",
      component: `GET ${ctx.appUrl.pathname || "/"}`,
      description: `${hurt} of ${statuses.length} concurrent requests failed, returned a server error or got no answer at all. The application has little headroom against a burst of legitimate-looking traffic, let alone a deliberate one.`,
      remediation:
        "Add capacity (autoscaling, caching, a CDN) and backpressure (queueing, circuit breaking, graceful shedding) so a burst of traffic degrades gracefully instead of failing outright.",
      mapping: "OWASP API4:2023 Unrestricted Resource Consumption",
    },
  };
}

export const floodAgent: AgentModule = {
  id: "flood",
  task: "Send concurrent request bursts to test rate limiting and availability under load",
  steps: { rateLimit, availability },
  doneSummary: ({ checks, findings }) =>
    `Load test finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
