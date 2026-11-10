import type { AgentInput, ProxyStats } from "@swarm/shared/server";
import type { EventSink } from "./emitter.js";
import { createProxy } from "./proxy.js";
import type { RunnerResult } from "./runner.js";
import { runTask } from "./task.js";

export interface LocalRunOptions {
  input: AgentInput;
  sink: EventSink;
  /** Let the proxy reach loopback addresses (a synthetic target on this machine). Never set in a task. */
  allowPrivate?: boolean;
  /** Replaces DNS for the proxy (the local dev server points every name at loopback). */
  resolve?: (host: string) => Promise<string[]>;
  aborted?: () => boolean;
}

export interface LocalRunResult {
  result: RunnerResult;
  stats: ProxyStats;
  log: ReturnType<ReturnType<typeof createProxy>["log"]>;
}

/**
 * Runs the whole task in this process with its own scope proxy: what the container does, without
 * AWS. Used by the tests and by the local dev server.
 */
export async function runLocal(options: LocalRunOptions): Promise<LocalRunResult> {
  const { input } = options;
  const proxy = createProxy({
    scope: input.scope,
    requestsPerSecond: input.budgets.requestsPerSecond,
    requestCap: input.budgets.maxRequests,
    allowPrivate: options.allowPrivate,
    resolve: options.resolve,
  });
  const port = await proxy.listen(0);
  try {
    const result = await runTask({
      input,
      sink: options.sink,
      proxy: { host: "127.0.0.1", port },
      aborted: options.aborted,
    });
    return { result, stats: proxy.stats(), log: proxy.log() };
  } finally {
    await proxy.close();
  }
}
