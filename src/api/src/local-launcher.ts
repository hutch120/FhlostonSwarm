import { InternalApi, runLocal } from "@swarm/agents";
import { finalizeRun, type FinalizeDeps } from "./finalize.js";
import { internalApp } from "./internal.js";
import type { RunLauncher } from "./launcher.js";
import type { EventPublisher } from "./publisher.js";
import { runToken } from "./runtoken.js";
import type { Secrets } from "./sessions.js";
import type { ObjectStore } from "./storage/store.js";

export interface LocalLauncherDeps {
  store: ObjectStore;
  secrets: () => Promise<Secrets>;
  finalize: FinalizeDeps;
  publisher?: EventPublisher;
  now?: () => number;
  /** Let the scope proxy reach loopback (the synthetic target on this machine). */
  allowPrivate: boolean;
  /** Replaces DNS: the dev server resolves every name to loopback so no run touches the internet. */
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * Runs the agent in this process instead of a Fargate task: same internal API, same proxy and the
 * same finaliser, with no AWS. For the local dev server and the pipeline tests; never deployed.
 */
export class LocalLauncher implements RunLauncher {
  private readonly runs = new Map<string, { aborted: boolean; done: Promise<void> }>();

  constructor(private readonly deps: LocalLauncherDeps) {}

  /** Resolves when the run has been closed (tests await this). */
  settled(runId: string): Promise<void> {
    return this.runs.get(runId)?.done ?? Promise.resolve();
  }

  async start(owner: string, runId: string): Promise<void> {
    const state = { aborted: false, done: Promise.resolve() };
    state.done = this.execute(owner, runId, state).catch((err) => {
      console.error(JSON.stringify({ msg: "local_run_failed", error: (err as Error).message }));
    });
    this.runs.set(runId, state);
  }

  async stop(_owner: string, runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    state.aborted = true;
    await state.done;
  }

  private async execute(owner: string, runId: string, state: { aborted: boolean }) {
    const { store } = this.deps;
    const now = this.deps.now ?? Date.now;
    const secrets = await this.deps.secrets();
    const internal = internalApp({
      store,
      secrets: this.deps.secrets,
      publisher: this.deps.publisher,
      now,
      requireIam: false,
    });
    const api = new InternalApi(
      {
        apiBase: "http://local",
        region: "local",
        owner,
        runId,
        token: runToken(secrets, owner, runId),
      },
      (url, init) => Promise.resolve(internal.request(url, init)),
    );
    try {
      const input = await api.getInput();
      const { stats, log } = await runLocal({
        input,
        sink: api,
        allowPrivate: this.deps.allowPrivate,
        resolve: this.deps.resolve,
        aborted: () => state.aborted,
      });
      await api.postEvidence("proxy-log", log);
      await api.postEvidence("proxy-stats", stats);
    } catch (err) {
      console.error(JSON.stringify({ msg: "local_agent_failed", error: (err as Error).message }));
      await finalizeRun(this.deps.finalize, { emailHash: owner, runId }, { kind: "failed" });
      return;
    }
    await finalizeRun(
      this.deps.finalize,
      { emailHash: owner, runId },
      state.aborted ? { kind: "stopped" } : { kind: "finished" },
    );
  }
}
