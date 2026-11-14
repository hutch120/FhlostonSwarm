import { AREAS, type AgentSpec } from "@swarm/shared";
import {
  type DynamicAgent,
  type DynamicCheck,
  type DynamicResults,
  type KnowledgeItem,
  type Matcher,
  type SelectedAgent,
  type SelectedItem,
} from "@swarm/shared/server";
import { BudgetExhausted } from "../budget.js";
import { RequestFailed, header, type HttpResult } from "../http.js";
import type { AgentModule, Step, StepContext, StepResult } from "../types.js";

/**
 * The dynamic agent runtime (PLAN.md section 9): a generic agent that executes the checks of a
 * learned spec. A spec is data built from three read-only primitives, so a check can only send a
 * safe request through the scope proxy (counted against the run's request budget and rate), look at
 * a header, or search the scripts the pages already load. It has no tool of its own, no host and no
 * way to write, and each check is one step of the depth's step budget.
 */

const hostPath = (ctx: StepContext, path: string): string => new URL(path, ctx.appUrl).toString();

/** True when every condition of the matcher holds for the response. */
export function matches(res: HttpResult, matcher: Matcher): boolean {
  if (matcher.status && !matcher.status.includes(res.status)) return false;
  for (const name of matcher.headerPresent ?? []) if (header(res, name) === undefined) return false;
  for (const { name, value } of matcher.headerIncludes ?? []) {
    if (!(header(res, name) ?? "").toLowerCase().includes(value.toLowerCase())) return false;
  }
  const body = res.body.toLowerCase();
  for (const needle of matcher.bodyIncludes ?? [])
    if (!body.includes(needle.toLowerCase())) return false;
  return true;
}

export interface Counters {
  checks: number;
  fired: number;
  errors: number;
  outOfScope: number;
  unconfirmed: number;
}

const finding = (check: DynamicCheck, component: string, evidence: string[]): StepResult => ({
  outcome: "finding",
  finding: {
    title: check.finding.title,
    severity: check.finding.severity,
    component,
    description: check.finding.description,
    remediation: check.finding.remediation,
    ...(check.finding.mapping ? { mapping: check.finding.mapping } : {}),
    evidence,
  },
});

async function runCheck(
  check: DynamicCheck,
  ctx: StepContext,
  counters: Counters,
): Promise<StepResult> {
  if (check.kind === "probe") {
    for (const path of check.paths) {
      let res: HttpResult;
      try {
        res = await ctx.http.request({
          url: hostPath(ctx, path),
          method: check.method,
          maxRedirects: 0,
        });
      } catch (err) {
        if (!(err instanceof RequestFailed)) throw err;
        if (err.blocked) counters.outOfScope += 1;
        continue;
      }
      if (matches(res, check.match)) {
        return finding(check, `${check.method} ${path}`, [
          `${check.method} ${path} answered ${res.status}`,
        ]);
      }
    }
    return { outcome: "clear" };
  }

  if (check.kind === "header") {
    let res: HttpResult;
    try {
      res = await ctx.http.request({
        url: hostPath(ctx, check.path),
        maxRedirects: 0,
      });
    } catch (err) {
      if (!(err instanceof RequestFailed)) throw err;
      if (err.blocked) counters.outOfScope += 1;
      return { outcome: "clear" };
    }
    const value = header(res, check.header);
    const wanted = (check.value ?? "").toLowerCase();
    const raise =
      check.raiseWhen === "present"
        ? value !== undefined
        : check.raiseWhen === "absent"
          ? value === undefined
          : check.raiseWhen === "includes"
            ? value !== undefined && value.toLowerCase().includes(wanted)
            : value !== undefined && !value.toLowerCase().includes(wanted);
    return raise
      ? finding(check, `GET ${check.path}`, [
          `GET ${check.path} answered ${res.status}; header ${check.header} ${value === undefined ? "is missing" : "is set"}`,
        ])
      : { outcome: "clear" };
  }

  const { external, inline } = await ctx.pageScripts();
  const bodies = [...inline];
  for (const url of external.slice(0, 6)) {
    const body = await ctx.scriptBody(url);
    if (body) bodies.push(body);
  }
  const text = bodies.join("\n").toLowerCase();
  const hit = check.includes.find((needle) => text.includes(needle.toLowerCase()));
  return hit
    ? finding(check, "Scripts the application loads", [
        `The application's scripts contain "${hit}"`,
      ])
    : { outcome: "clear" };
}

const step =
  (check: DynamicCheck, counters: Counters): Step =>
  async (ctx) => {
    counters.checks += 1;
    try {
      const result = await runCheck(check, ctx, counters);
      if (result.outcome === "finding") counters.fired += 1;
      return result;
    } catch (err) {
      if (!(err instanceof BudgetExhausted) && !(err instanceof RequestFailed))
        counters.errors += 1;
      throw err;
    }
  };

const colourOf = (area: string): string => AREAS.find((a) => a.id === area)?.colour ?? "#94a3b8";

/** The roster-style spec of a dynamic agent: its checks are its steps; the colour comes from its area. */
export const specOf = (agent: DynamicAgent): AgentSpec => ({
  id: agent.id,
  name: agent.title,
  area: agent.area,
  colour: colourOf(agent.area),
  face: "hex",
  steps: agent.checks.map((c) => ({ id: c.id, label: c.label })),
});

const buildModule = (agent: DynamicAgent, counters: Counters): AgentModule => ({
  id: agent.id,
  task: agent.objective,
  steps: Object.fromEntries(agent.checks.map((c) => [c.id, step(c, counters)])),
  doneSummary: ({ checks, findings }) =>
    `${agent.title} finished: ${checks} ${checks === 1 ? "check" : "checks"}, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
});

/** What one run uses of the dynamic layer, and what it did with it. */
export class DynamicRuntime {
  readonly counters = new Map<string, Counters>();
  readonly wouldRaise: DynamicResults["wouldRaise"] = [];
  private readonly modules = new Map<string, AgentModule>();

  constructor(
    readonly version: number | null,
    readonly items: readonly SelectedItem[],
    readonly agents: readonly SelectedAgent[],
  ) {
    for (const { agent } of agents) {
      const counters: Counters = { checks: 0, fired: 0, errors: 0, outOfScope: 0, unconfirmed: 0 };
      this.counters.set(agent.id, counters);
      this.modules.set(agent.id, buildModule(agent, counters));
    }
  }

  /** The agents that raise findings (promoted entries), with the module to run them. */
  active(): { agent: DynamicAgent; spec: AgentSpec; module: AgentModule }[] {
    return this.agents
      .filter((a) => a.mode === "active")
      .map(({ agent }) => ({ agent, spec: specOf(agent), module: this.modules.get(agent.id)! }));
  }

  /** Modules for the verifier's re-runs: same checks, counters nobody reads, so a re-test is not counted twice. */
  verifierModules(): Record<string, AgentModule> {
    return Object.fromEntries(
      this.agents.map(({ agent }) => [
        agent.id,
        buildModule(agent, { checks: 0, fired: 0, errors: 0, outOfScope: 0, unconfirmed: 0 }),
      ]),
    );
  }

  /** Candidates run in shadow: observations only, no events and no findings. */
  async runShadow(
    ctx: StepContext,
    options: { useStep(): void; aborted?: () => boolean },
  ): Promise<BudgetExhausted | null> {
    for (const { agent, mode } of this.agents) {
      if (mode !== "shadow") continue;
      for (const check of agent.checks) {
        if (options.aborted?.()) return null;
        try {
          options.useStep();
          const result = await this.modules.get(agent.id)!.steps[check.id]!(ctx);
          if (result.outcome === "finding") {
            this.wouldRaise.push({
              agent: agent.id,
              check: check.id,
              title: result.finding.title,
              component: result.finding.component,
            });
          }
        } catch (err) {
          if (err instanceof BudgetExhausted) return err;
          // Errors are already counted by the step; a refused request too.
          if (!(err instanceof RequestFailed)) {
            console.error(JSON.stringify({ msg: "dynamic_shadow_failed", agent: agent.id }));
          }
        }
      }
    }
    return null;
  }

  noteUnconfirmed(agentId: string): void {
    const counters = this.counters.get(agentId);
    if (counters) counters.unconfirmed += 1;
  }

  /** The evidence the learning pass reads; null when no layer was in use. */
  results(): DynamicResults | null {
    if (this.version === null) return null;
    return {
      version: this.version,
      items: this.items.map(
        ({ item, mode }: { item: KnowledgeItem; mode: "active" | "shadow" }) => ({
          id: item.id,
          mode,
        }),
      ),
      agents: this.agents.map(({ agent, mode }) => ({
        id: agent.id,
        mode,
        ...this.counters.get(agent.id)!,
      })),
      wouldRaise: this.wouldRaise.slice(0, 40),
    };
  }
}
