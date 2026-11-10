import { AGENTS, findingSchema, type Finding } from "@swarm/shared";
import type { AgentInput } from "@swarm/shared/server";
import { corsAgent } from "./agents/cors.js";
import { tlsAgent } from "./agents/tls.js";
import { zapAgent } from "./agents/zap.js";
import { Budget, BudgetExhausted } from "./budget.js";
import type { Emitter } from "./emitter.js";
import { RequestFailed, type HttpResult, type ScopedHttp } from "./http.js";
import type { AgentModule, StepContext, StepResult } from "./types.js";

/**
 * The deterministic "headers agent" (no LLM): transport, security headers and CORS. It reports as the
 * `tls`, `zap` and `cors` roster agents so the live view animates the same agents the tier names.
 * Roster agents without a module here are reported as gaps until a later phase adds them.
 */
export const MODULES: Record<string, AgentModule> = {
  tls: tlsAgent,
  zap: zapAgent,
  cors: corsAgent,
};

export interface RunnerDeps {
  input: AgentInput;
  emitter: Emitter;
  http: ScopedHttp;
  budget: Budget;
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

export async function runAgents(deps: RunnerDeps): Promise<RunnerResult> {
  const { input, emitter, http, budget } = deps;
  const planned = AGENTS.filter((a) => input.agents.includes(a.id));
  const result: RunnerResult = { checks: 0, gaps: 0, findings: [], agentsRun: [], stoppedBy: null };

  for (const spec of planned) {
    if (MODULES[spec.id]) continue;
    emitter.gap(spec.id, `${spec.name} is not available yet, so it was not run.`, spec.area);
    result.gaps += 1;
  }

  let baseline: Promise<HttpResult> | undefined;
  const ctx: StepContext = {
    input,
    appUrl: new URL(input.target.appUrl),
    http,
    baseline: () => (baseline ??= http.request({ url: input.target.appUrl })),
  };

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
