import type { Severity } from "@swarm/shared";
import type { AgentInput } from "@swarm/shared/server";
import type { HttpResult, ScopedHttp } from "./http.js";

export interface FindingDraft {
  title: string;
  severity: Severity;
  /** What is affected, e.g. `GET /` or `https://host:443`. */
  component: string;
  description: string;
  remediation: string;
  /** OWASP / LLM Top 10 mapping, when there is one. */
  mapping?: string;
}

export type StepResult =
  | { outcome: "clear" }
  | { outcome: "info"; note: string }
  | { outcome: "finding"; finding: FindingDraft }
  | { outcome: "gap"; reason: string };

/** What a check can use. It cannot reach the network except through `http` (the scope proxy). */
export interface StepContext {
  input: AgentInput;
  /** The application URL the customer gave. */
  appUrl: URL;
  http: ScopedHttp;
  /** GET of the application URL, fetched once and shared by the checks that need the page. */
  baseline(): Promise<HttpResult>;
}

export type Step = (ctx: StepContext) => Promise<StepResult>;

/** A roster agent the runtime can run: its id and one implementation per roster step. */
export interface AgentModule {
  id: string;
  /** What the dispatch event says it is about to do. */
  task: string;
  steps: Record<string, Step>;
  /** The line shown when the agent finishes. */
  doneSummary(counts: { checks: number; findings: number; gaps: number }): string;
}
