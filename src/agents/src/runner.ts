import {
  AGENTS,
  findingSchema,
  redactDeep,
  tiers,
  type AgentSpec,
  type Finding,
} from "@swarm/shared";
import {
  PLAN_DEPENDENT_AGENTS,
  type AgentInput,
  type DynamicResults,
  type Engagement,
} from "@swarm/shared/server";
import { authnAgent } from "./agents/authn.js";
import { authzAgent } from "./agents/authz.js";
import { bundleAgent } from "./agents/bundle.js";
import { corsAgent } from "./agents/cors.js";
import { dnsAgent } from "./agents/dns.js";
import { idorAgent } from "./agents/idor.js";
import { outputAgent } from "./agents/output.js";
import { promptAgent } from "./agents/prompt.js";
import { sessionAgent } from "./agents/session.js";
import { classifyRole } from "./agents/support.js";
import { surfaceAgent } from "./agents/surface.js";
import { tlsAgent } from "./agents/tls.js";
import { zapAgent } from "./agents/zap.js";
import { Budget, BudgetExhausted } from "./budget.js";
import type { Emitter } from "./emitter.js";
import type { Explorer } from "./explorer/explorer.js";
import { RequestFailed, type HttpResult, type ScopedHttp } from "./http.js";
import { DynamicRuntime } from "./learning/dynamic.js";
import type { LlmMeter } from "./llm/meter.js";
import type { LlmClient } from "./llm/types.js";
import {
  DYNAMIC_SELECTION,
  agentEnabled,
  planEngagement,
  stepSkipped,
  type DynamicSelection,
} from "./planner.js";
import type { AgentModule, DnsClient, StepContext, StepResult } from "./types.js";
import { verifyCandidates, type Candidate } from "./verifier.js";

/**
 * The roster agents this runtime implements. Roster agents without a module here are reported as
 * gaps. `surface` and `authn` drive the explorer (the model-driven discovery step); the plan-dependent
 * agents (`session`, `authz`, `prompt`, `output`, `idor`) run after discovery, under the engagement
 * plan; the rest are deterministic.
 */
export const MODULES: Record<string, AgentModule> = {
  dns: dnsAgent,
  surface: surfaceAgent,
  bundle: bundleAgent,
  tls: tlsAgent,
  zap: zapAgent,
  cors: corsAgent,
  authn: authnAgent,
  session: sessionAgent,
  authz: authzAgent,
  prompt: promptAgent,
  output: outputAgent,
  idor: idorAgent,
};

export interface RunnerDeps {
  input: AgentInput;
  emitter: Emitter;
  http: ScopedHttp;
  budget: Budget;
  dns: DnsClient;
  /** The explorer, or null when the run has no model or browser. */
  explorer: Explorer | null;
  /** The model and meter the planner uses (the explorer's own); null without a model. */
  llm?: LlmClient | null;
  meter?: LlmMeter | null;
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
  /** The engagement plan of a deep run; null at the shallow depths. */
  engagement: Engagement | null;
  /** What the verifier concluded (deep depths); null when it did not run. */
  verification: { confirmed: number; unconfirmed: number; notChecked: number } | null;
  /** What the run did with the dynamic layer; null when no layer was in use. */
  dynamic: DynamicResults | null;
}

/** The verifier is not a roster agent; its events carry this id. */
export const VERIFIER = "verifier";

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
    plan: null,
    shared: new Map(),
    roles() {
      return (explorer?.roleSessions ?? []).map((session) => ({
        ...session,
        kind:
          ctx.plan?.roles.find((r) => r.slot === session.slot)?.kind ??
          classifyRole(session.slot, session.description),
      }));
    },
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
  const deep = tiers[input.tier].deep;
  const planned = AGENTS.filter((a) => input.agents.includes(a.id));
  const result: RunnerResult = {
    checks: 0,
    gaps: 0,
    findings: [],
    agentsRun: [],
    stoppedBy: null,
    engagement: null,
    verification: null,
    dynamic: null,
  };
  const candidates: Candidate[] = [];
  const dyn: { runtime: DynamicRuntime | null } = { runtime: null };
  const dynamicSpecs = new Map<string, AgentSpec>();

  for (const spec of planned) {
    if (MODULES[spec.id]) continue;
    emitter.gap(spec.id, `${spec.name} is not available yet, so it was not run.`, spec.area);
    result.gaps += 1;
  }

  const ctx = stepContext(deps);

  /** What must never reach an event or a report: the supplied passwords and the sessions' cookie values. */
  const secrets = (): string[] => [
    ...Object.values(input.logins).map((l) => l.password),
    ...(deps.explorer?.roleSessions ?? []).flatMap((s) =>
      s.cookie.split("; ").map((pair) => pair.slice(pair.indexOf("=") + 1)),
    ),
  ];

  const planOnce = async () => {
    if (ctx.plan || !deep) return;
    ctx.plan = await planEngagement({
      ctx,
      llm: deps.llm ?? null,
      meter: deps.meter ?? null,
      aborted: deps.aborted,
    });
    result.engagement = ctx.plan;
  };

  /** Runs one agent's checks under the plan. Returns true when the run was cut short and nothing more should run. */
  const runSpec = async (spec: AgentSpec, module: AgentModule): Promise<boolean> => {
    if (deep && !ctx.plan && (PLAN_DEPENDENT_AGENTS as readonly string[]).includes(spec.id)) {
      await planOnce();
    }

    result.agentsRun.push(spec.id);
    emitter.dispatch(spec.id, module.task, dynamicSpecs.get(spec.id));
    if (!agentEnabled(ctx.plan, spec.id)) {
      const reason = ctx.plan?.agents.find((a) => a.id === spec.id)?.reason;
      emitter.agentDone(spec.id, `Not applicable: ${reason ?? "nothing to test."}`);
      return false;
    }

    let agentChecks = 0;
    let agentFindings = 0;
    let agentGaps = 0;

    for (const step of spec.steps) {
      if (deps.aborted?.()) {
        result.stoppedBy = "aborted";
        return true;
      }
      if (stepSkipped(ctx.plan, spec.id, step.id)) continue;
      const implementation = module.steps[step.id];
      if (!implementation) throw new Error(`agent ${spec.id} has no step ${step.id}`);

      try {
        budget.useStep();
      } catch (err) {
        if (!(err instanceof BudgetExhausted)) throw err;
        emitter.gap(spec.id, err.reason, spec.area);
        result.gaps += 1;
        result.stoppedBy = err.kind;
        return true;
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
          const { replay, ...draft } = outcome.finding;
          const finding = findingSchema.parse({
            id: idOf(result.findings.length + 1),
            ...redactDeep(draft, { secrets: secrets() }),
            area: spec.area,
            agent: spec.id,
            verified: false,
            status: "unverified",
          });
          result.findings.push(finding);
          candidates.push({ finding, stepId: step.id, replay });
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
        return true;
      }
    }

    emitter.agentDone(
      spec.id,
      module.doneSummary({ checks: agentChecks, findings: agentFindings, gaps: agentGaps }),
    );
    return false;
  };

  /** The agents in roster order, then the learned ones. Returns true when the run was cut short. */
  const runAgentLoop = async (): Promise<boolean> => {
    for (const spec of planned) {
      const module = MODULES[spec.id];
      if (module && (await runSpec(spec, module))) return true;
    }
    if (!deep) return false;

    // The dynamic layer (PLAN.md section 9): promoted agents run like any other; candidates only observe.
    await planOnce();
    const selection = ctx.shared.get(DYNAMIC_SELECTION) as DynamicSelection | undefined;
    const dynamic = new DynamicRuntime(
      input.dynamic?.version ?? null,
      selection?.items ?? [],
      selection?.agents ?? [],
    );
    dyn.runtime = dynamic;
    for (const { spec, module } of dynamic.active()) {
      dynamicSpecs.set(spec.id, spec);
      if (await runSpec(spec, module)) return true;
    }
    await dynamic.runShadow(ctx, {
      useStep: () => budget.useStep(),
      aborted: deps.aborted,
    });
    return false;
  };

  const finish = (): RunnerResult => {
    result.dynamic = dyn.runtime?.results() ?? null;
    return result;
  };

  const stopped = await runAgentLoop();
  if (stopped) return finish();

  // Verification: every candidate of a deep depth is re-tested independently.
  if (deep && candidates.length > 0 && !deps.aborted?.()) {
    result.verification = await verifyCandidates(candidates, {
      emitter,
      verifier: VERIFIER,
      modules: { ...MODULES, ...(dyn.runtime?.verifierModules() ?? {}) },
      freshContext: () => stepContext({ ...deps }),
      redact: (text) => redactDeep(text, { secrets: secrets() }),
      aborted: deps.aborted,
      onVerdict: (id, verified) => {
        const found = result.findings.find((f) => f.id === id);
        if (found) {
          found.verified = verified;
          found.status = verified ? "open" : "unconfirmed";
          if (!verified) dyn.runtime?.noteUnconfirmed(found.agent);
        }
      },
    });
    if (result.verification.notChecked > 0) {
      emitter.gap(
        null,
        "Some findings were not independently re-tested because the run reached its limits, so they stay unverified.",
      );
      result.gaps += 1;
    }
  }
  return finish();
}
