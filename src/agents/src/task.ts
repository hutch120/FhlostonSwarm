import net from "node:net";
import type { AppProfile } from "@swarm/shared";
import type { AgentInput, LlmUsage } from "@swarm/shared/server";
import { Budget } from "./budget.js";
import { systemDns } from "./agents/dns.js";
import { Emitter, type EventSink } from "./emitter.js";
import type { BlockedRequest, DriverFactory } from "./explorer/driver.js";
import { Explorer } from "./explorer/explorer.js";
import { ScopedHttp } from "./http.js";
import { LlmMeter } from "./llm/meter.js";
import type { LlmClient } from "./llm/types.js";
import { runAgents, type RunnerResult } from "./runner.js";
import type { DnsClient } from "./types.js";

export interface TaskOptions {
  input: AgentInput;
  sink: EventSink;
  proxy: { host: string; port: number; loginKey?: string };
  now?: () => number;
  aborted?: () => boolean;
  /** Replaces the emitter's retry pause (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** The model and the browser for the explorer; without both, the run has no explorer. */
  llm?: LlmClient;
  driverFactory?: DriverFactory;
  dns?: DnsClient;
  /** Told after every model call (the task posts it as evidence, so a killed task still has its usage). */
  onUsage?: (usage: LlmUsage) => void;
}

/** What the task learned beyond its events: the profile, the model usage and the explorer's log. */
export interface TaskResult extends RunnerResult {
  profile: AppProfile | null;
  usage: LlmUsage | null;
  explorerLog: {
    pages: string[];
    signIns: { slot: string; ok: boolean }[];
    blocked: BlockedRequest[];
  } | null;
}

/** Waits until something accepts connections on the proxy port (the sidecar starts alongside). */
export async function waitForProxy(
  proxy: { host: string; port: number },
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(proxy.port, proxy.host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("The scope proxy did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Runs one agent task for the run described by `input`, emitting events to `sink`. */
export async function runTask(options: TaskOptions): Promise<TaskResult> {
  const { input } = options;
  const now = options.now ?? Date.now;
  const emitter = new Emitter({
    runId: input.runId,
    sink: options.sink,
    now,
    sleep: options.sleep,
  });
  const budget = new Budget(
    {
      maxSteps: input.budgets.maxSteps,
      maxRequests: input.budgets.maxRequests,
      deadline: now() + input.budgets.wallClockSeconds * 1000,
    },
    now,
  );
  const http = new ScopedHttp(options.proxy, input.userAgent, budget);

  const meter = new LlmMeter({ ...input.budgets.llm });
  meter.onRecord = options.onUsage;
  const explorer =
    options.llm && options.driverFactory
      ? new Explorer({
          input,
          llm: options.llm,
          meter,
          driverFactory: options.driverFactory,
          proxy: options.proxy,
          budget,
          aborted: options.aborted,
        })
      : null;

  const result = await runAgents({
    input,
    emitter,
    http,
    budget,
    dns: options.dns ?? systemDns(),
    explorer,
    llm: explorer ? options.llm : null,
    meter: explorer ? meter : null,
    aborted: options.aborted,
  });
  await emitter.flush();
  if (emitter.failure) throw emitter.failure;
  return {
    ...result,
    profile: explorer?.profile ?? null,
    usage: explorer ? meter.usage() : null,
    explorerLog: explorer
      ? {
          pages: [...new Set(explorer.pages.map((p) => new URL(p.url).pathname))],
          signIns: explorer.signIns.map(({ slot, ok }) => ({ slot, ok })),
          blocked: [...explorer.blocked],
        }
      : null,
  };
}
