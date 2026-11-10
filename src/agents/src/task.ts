import net from "node:net";
import type { AgentInput } from "@swarm/shared/server";
import { Budget } from "./budget.js";
import { Emitter, type EventSink } from "./emitter.js";
import { ScopedHttp } from "./http.js";
import { runAgents, type RunnerResult } from "./runner.js";

export interface TaskOptions {
  input: AgentInput;
  sink: EventSink;
  proxy: { host: string; port: number };
  now?: () => number;
  aborted?: () => boolean;
  /** Replaces the emitter's retry pause (tests). */
  sleep?: (ms: number) => Promise<void>;
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
export async function runTask(options: TaskOptions): Promise<RunnerResult> {
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
  const result = await runAgents({ input, emitter, http, budget, aborted: options.aborted });
  await emitter.flush();
  if (emitter.failure) throw emitter.failure;
  return result;
}
