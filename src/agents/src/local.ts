import { randomUUID } from "node:crypto";
import type { AgentInput, ProxyStats } from "@swarm/shared/server";
import type { EventSink } from "./emitter.js";
import type { DriverFactory } from "./explorer/driver.js";
import type { LlmClient } from "./llm/types.js";
import { createProxy } from "./proxy.js";
import { runTask, type TaskResult } from "./task.js";
import type { DnsClient } from "./types.js";

export interface LocalRunOptions {
  input: AgentInput;
  sink: EventSink;
  /** Let the proxy reach loopback addresses (a synthetic target on this machine). Never set in a task. */
  allowPrivate?: boolean;
  /** Replaces DNS for the proxy (the local dev server points every name at loopback). */
  resolve?: (host: string) => Promise<string[]>;
  aborted?: () => boolean;
  llm?: LlmClient;
  driverFactory?: DriverFactory;
  dns?: DnsClient;
}

export interface LocalRunResult {
  result: TaskResult;
  stats: ProxyStats;
  log: ReturnType<ReturnType<typeof createProxy>["log"]>;
}

/**
 * Runs the whole task in this process with its own scope proxy: what the container does, without
 * AWS. Used by the tests and by the local dev server.
 */
export async function runLocal(options: LocalRunOptions): Promise<LocalRunResult> {
  const { input } = options;
  const loginKey = randomUUID();
  const proxy = createProxy({
    scope: input.scope,
    requestsPerSecond: input.budgets.requestsPerSecond,
    requestCap: input.budgets.maxRequests,
    loginSubmissions: input.scope.loginSubmissions,
    loginKey,
    allowPrivate: options.allowPrivate,
    resolve: options.resolve,
  });
  const port = await proxy.listen(0);
  try {
    const result = await runTask({
      input,
      sink: options.sink,
      proxy: { host: "127.0.0.1", port, loginKey },
      aborted: options.aborted,
      llm: options.llm,
      driverFactory: options.driverFactory,
      dns: options.dns,
    });
    return { result, stats: proxy.stats(), log: proxy.log() };
  } finally {
    await proxy.close();
  }
}
