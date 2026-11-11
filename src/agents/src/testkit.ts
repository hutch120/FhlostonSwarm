import type { AddressInfo } from "node:net";
import { stampEvent, tiers, type RunEvent, type TierId } from "@swarm/shared";
import { limitsFor, type AgentInput } from "@swarm/shared/server";
import {
  createTarget,
  USERS,
  type TargetOptions,
  type TargetServer,
} from "@swarm/synthetic-target";
import { afterAll, beforeAll } from "vitest";
import type { MemorySink } from "./emitter.js";
import { PlaywrightDriver, chromiumAvailable } from "./explorer/playwright.js";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse } from "./llm/types.js";
import type { DnsClient } from "./types.js";

/** True when a Chromium is installed here; the explorer tests skip without one. */
export const browserAvailable = await chromiumAvailable();

export const fakeDns: DnsClient = { records: async () => ({ ok: false, code: "ENODATA" }) };

export const launch = (options: Parameters<typeof PlaywrightDriver.launch>[0]) =>
  PlaywrightDriver.launch(options);

export interface Fixture {
  target: () => TargetServer;
  port: () => number;
}

/** Starts a synthetic target for the file's tests and stops it afterwards. */
export function useTarget(options?: TargetOptions): Fixture {
  let server: TargetServer;
  let port = 0;
  beforeAll(async () => {
    server = createTarget(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { target: () => server, port: () => port };
}

const userFor = (slot: "admin" | "user1" | "user2") =>
  USERS.find((u) => u.username === `swarm-test-${slot}`)!;

const loginsFor = (slots: readonly ("admin" | "user1" | "user2")[]): AgentInput["logins"] =>
  Object.fromEntries(
    slots.map((slot) => [
      slot,
      {
        username: userFor(slot).username,
        password: userFor(slot).password,
        description: slot === "admin" ? "Administrator" : `Customer ${slot.slice(-1)}`,
        notes: "",
      },
    ]),
  );

/** An agent input for a depth, with its limits from the real config. */
export function inputFor(
  port: number,
  tier: TierId,
  overrides: {
    logins?: boolean;
    /** Which logins the run holds (default: the administrator only). */
    slots?: readonly ("admin" | "user1" | "user2")[];
    budgets?: Partial<AgentInput["budgets"]>;
  } = {},
): AgentInput {
  const limits = limitsFor(tier);
  const withLogin = overrides.logins ?? tiers[tier].logins > 0;
  const slots = overrides.slots ?? ["admin"];
  return {
    runId: "run_test0001",
    tier,
    target: { appUrl: `http://127.0.0.1:${port}/`, marketingUrl: "" },
    scope: {
      hosts: ["127.0.0.1"],
      ports: [80, 443, port],
      readOnly: true,
      loginSubmissions: withLogin ? 2 * slots.length : 0,
    },
    agents: tiers[tier].agents,
    budgets: {
      wallClockSeconds: tiers[tier].wallClockMinutes * 60,
      maxSteps: limits.stepCap,
      maxRequests: limits.requestCap,
      // The rate limit is a real-world politeness setting; tests run flat out.
      requestsPerSecond: 500,
      maxPages: limits.pageCap,
      llm: {
        modelId: limits.modelId,
        maxCalls: limits.llmStepCap,
        phaseCalls: limits.explorerPhaseCalls,
        maxInputTokens: limits.tokenCap?.input ?? null,
        maxOutputTokens: limits.tokenCap?.output ?? null,
        spendCapUsd: limits.spendCapUsd,
      },
      ...overrides.budgets,
    },
    logins: withLogin ? loginsFor(slots) : {},
    scopeNotes: "",
    userAgent: "Swarm/0.1 (+https://fhlostonswarm.com/about)",
  };
}

/** What the events API does: give each agent event its seq, in arrival order. */
export const stamped = (sink: MemorySink): RunEvent[] =>
  sink.events.map((event, i) => stampEvent(event, i + 1));

/** A model that does what a test scripts, and records every request it was sent. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: (turn: number, request: LlmRequest) => ContentBlock[],
    private readonly options: {
      usage?: { inputTokens: number; outputTokens: number };
      delayMs?: number;
      modelId?: string;
    } = {},
  ) {}

  get modelId(): string {
    return this.options.modelId ?? "au.anthropic.claude-haiku-4-5-20251001-v1:0";
  }

  async converse(request: LlmRequest): Promise<LlmResponse> {
    const turn = this.requests.length;
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
    return {
      message: { role: "assistant", content: this.script(turn, request) },
      stopReason: "tool_use",
      usage: this.options.usage ?? { inputTokens: 1500, outputTokens: 60 },
    };
  }
}

export const call = (id: number, name: string, input: unknown): ContentBlock => ({
  type: "toolUse",
  id: `t${id}`,
  name,
  input,
});

/** The text of every tool result in the last message of a request. */
export const lastResult = (request: LlmRequest): string =>
  (request.messages.at(-1)?.content ?? [])
    .map((b) => (b.type === "toolResult" ? b.text : ""))
    .join("\n");

/** A minimal valid profile, for scripts that just want to finish. */
export const tinyProfile = {
  purpose: "A test application.",
  areas: [],
  roles: [],
  flows: [],
  technologies: [],
};
