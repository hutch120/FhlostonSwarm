import { AGENTS, findingSchema, type Finding } from "@swarm/shared";
import type { AgentInput } from "@swarm/shared/server";
import { authnAgent } from "./agents/authn.js";
import { bundleAgent } from "./agents/bundle.js";
import { corsAgent } from "./agents/cors.js";
import { dnsAgent } from "./agents/dns.js";
import { surfaceAgent } from "./agents/surface.js";
import { tlsAgent } from "./agents/tls.js";
import { zapAgent } from "./agents/zap.js";
import { Budget, BudgetExhausted } from "./budget.js";
import type { Emitter } from "./emitter.js";
import type { Explorer } from "./explorer/explorer.js";
import { RequestFailed, type HttpResult, type ScopedHttp } from "./http.js";
import type { AgentModule, DnsClient, StepContext, StepResult } from "./types.js";

/**
 * The roster agents this runtime implements. Roster agents without a module here are reported as
 * gaps until a later phase adds them. `surface` and `authn` drive the explorer (the model-driven
 * discovery step); the rest are deterministic.
 */
export const MODULES: Record<string, AgentModule> = {
  dns: dnsAgent,
  surface: surfaceAgent,
  bundle: bundleAgent,
  tls: tlsAgent,
  zap: zapAgent,
  cors: corsAgent,
  authn: authnAgent,
};

export interface RunnerDeps {
  input: AgentInput;
  emitter: Emitter;
  http: ScopedHttp;
  budget: Budget;
  dns: DnsClient;
  /** The explorer, or null when the run has no model or browser. */
  explorer: Explorer | null;
  /** Set by the entrypoint on SIGTERM: stop between checks. */
  aborted?: () => boolean;
}

export interface RunnerResult {
  checks: number;
  gaps: number;
  findings: Finding[];
  agentsRun: string[];
  /** The budget that ended the run early, if one did. */
  stoppedBy: BudgetExhausted["kind"] | "aborted" | null;
}

const idOf = (n: number) => `F-${String(n).padStart(2, "0")}`;

const SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** The agents' shared helpers: one fetch of the home page, one fetch of each script. */
function stepContext(deps: RunnerDeps): StepContext {
  const { input, http, explorer, dns } = deps;
  const appUrl = new URL(input.target.appUrl);
  let baseline: Promise<HttpResult> | undefined;
  const scripts = new Map<string, Promise<string | null>>();

  const ctx: StepContext = {
    input,
    appUrl,
    http,
    dns,
    explorer,
    baseline: () => (baseline ??= http.request({ url: input.target.appUrl })),
    async pageScripts() {
      const pages = explorer?.pages ?? [];
      if (pages.length > 0) {
        return {
          external: [...new Set(pages.flatMap((p) => p.scripts))],
          inline: pages.flatMap((p) => p.inlineScripts),
        };
      }
      const page = await ctx.baseline();
      return {
        external: [
          ...new Set(
            [...page.body.matchAll(SCRIPT_SRC)].map((m) => new URL(m[1]!, page.url).toString()),
          ),
        ],
        inline: [...page.body.matchAll(INLINE_SCRIPT)].map((m) => m[1]!.slice(0, 4000)),
      };
    },
    scriptBody(url) {
      if (new URL(url).hostname !== appUrl.hostname) return Promise.resolve(null);
      let body = scripts.get(url);
      if (!body) {
        body = http.request({ url, maxRedirects: 0 }).then(
          (res) => (res.status === 200 ? res.body : null),
          (err) => {
            if (err instanceof RequestFailed) return null;
            throw err;
          },
        );
        scripts.set(url, body);
      }
      return body;
    },
  };
  return ctx;
}

/** Runs the planned agents, then lets the explorer write its profile if no phase got to. */
export async function runAgents(deps: RunnerDeps): Promise<RunnerResult> {
  try {
    return await runPlanned(deps);
  } finally {
    await deps.explorer?.ensureProfile();
  }
}

async function runPlanned(deps: RunnerDeps): Promise<RunnerResult> {
  const { input, emitter, budget } = deps;
  const planned = AGENTS.filter((a) => input.agents.includes(a.id));
  const result: RunnerResult = { checks: 0, gaps: 0, findings: [], agentsRun: [], stoppedBy: null };

  for (const spec of planned) {
    if (MODULES[spec.id]) continue;
    emitter.gap(spec.id, `${spec.name} is not available yet, so it was not run.`, spec.area);
    result.gaps += 1;
  }

  const ctx = stepContext(deps);

  for (const spec of planned) {
    const module = MODULES[spec.id];
    if (!module) continue;
    result.agentsRun.push(spec.id);
    emitter.dispatch(spec.id, module.task);
    let agentChecks = 0;
    let agentFindings = 0;
    let agentGaps = 0;

    for (const step of spec.steps) {
      if (deps.aborted?.()) {
        result.stoppedBy = "aborted";
        return result;
      }
      const implementation = module.steps[step.id];
      if (!implementation) throw new Error(`agent ${spec.id} has no step ${step.id}`);

      try {
        budget.useStep();
      } catch (err) {
        if (!(err instanceof BudgetExhausted)) throw err;
        emitter.gap(spec.id, err.reason, spec.area);
        result.gaps += 1;
        result.stoppedBy = err.kind;
        return result;
      }

      emitter.start(spec.id, step.id, step.label);
      const requestsBefore = budget.requests;
      let outcome: StepResult;
      let exhausted: BudgetExhausted | null = null;
      try {
        outcome = await implementation(ctx);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          exhausted = err;
          outcome = { outcome: "gap", reason: err.reason };
        } else if (err instanceof RequestFailed) {
          outcome = {
            outcome: "gap",
            reason: err.blocked
              ? `The scope guard refused a request this check needed (${err.reason}).`
              : `The target did not answer this check (${err.reason}).`,
          };
        } else {
          console.error(JSON.stringify({ msg: "step_failed", agent: spec.id, step: step.id }));
          outcome = { outcome: "gap", reason: "This check failed unexpectedly and was skipped." };
        }
      }

      const requests = budget.requests - requestsBefore;
      switch (outcome.outcome) {
        case "finding": {
          const finding = findingSchema.parse({
            id: idOf(result.findings.length + 1),
            ...outcome.finding,
            area: spec.area,
            agent: spec.id,
            verified: false,
            status: "unverified",
          });
          result.findings.push(finding);
          agentFindings += 1;
          emitter.finish(spec.id, step.id, step.label, requests, { outcome: "finding", finding });
          break;
        }
        case "gap":
          emitter.finish(spec.id, step.id, step.label, requests, outcome);
          emitter.gap(spec.id, outcome.reason, spec.area);
          result.gaps += 1;
          agentGaps += 1;
          break;
        default:
          emitter.finish(spec.id, step.id, step.label, requests, outcome);
          if (outcome.outcome === "info") {
            for (const reason of outcome.gaps ?? []) {
              emitter.gap(spec.id, reason, spec.area);
              result.gaps += 1;
              agentGaps += 1;
            }
          }
      }
      if (outcome.outcome !== "gap") {
        result.checks += 1;
        agentChecks += 1;
      }

      if (exhausted) {
        result.stoppedBy = exhausted.kind;
        return result;
      }
    }

    emitter.agentDone(
      spec.id,
      module.doneSummary({ checks: agentChecks, findings: agentFindings, gaps: agentGaps }),
    );
  }
  return result;
}
