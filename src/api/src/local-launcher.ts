import {
  InternalApi,
  runLocal,
  type DriverFactory,
  type LlmClient,
  type LocalRunResult,
} from "@swarm/agents";
import { runtimeConfig } from "@swarm/shared/server";
import { finalizeRun, type FinalizeDeps } from "./finalize.js";
import { internalApp } from "./internal.js";
import type { RunLauncher } from "./launcher.js";
import { acquireRun } from "./pool.js";
import type { EventPublisher } from "./publisher.js";
import { runToken } from "./runtoken.js";
import type { Secrets } from "./sessions.js";
import { keys } from "./storage/keys.js";
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
  /** The model and the browser for the explorer (the dev server uses a scripted model). */
  llm?: () => LlmClient;
  driverFactory?: DriverFactory;
  /** How often a run waiting for a slot looks again. */
  pollMs?: number;
  /** Renders a closed run's report to PDF (a headless browser); without it no PDF is made. */
  renderPdf?: (html: string) => Promise<Uint8Array>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the agent in this process instead of a Fargate task: same internal API, same proxy, same
 * concurrency pools and the same finaliser, with no AWS. For the local dev server and the pipeline
 * tests; never deployed.
 */
export class LocalLauncher implements RunLauncher {
  private readonly runs = new Map<string, { aborted: boolean; done: Promise<void> }>();

  constructor(private readonly deps: LocalLauncherDeps) {}

  /** Resolves when the run has been closed (tests await this). */
  settled(runId: string): Promise<void> {
    return this.runs.get(runId)?.done ?? Promise.resolve();
  }

  async start(owner: string, runId: string): Promise<void> {
    if (this.runs.has(runId)) return;
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

  /** Waits for the run's depth pool to have room, like the state machine's first step. */
  private async acquire(owner: string, runId: string, state: { aborted: boolean }) {
    const now = this.deps.now ?? Date.now;
    const poll = this.deps.pollMs ?? runtimeConfig.pool.pollSeconds * 1000;
    for (;;) {
      if (state.aborted) return "aborted" as const;
      const got = await acquireRun(this.deps.store, { emailHash: owner, runId }, now());
      if (got.status !== "waiting") return got.status;
      await sleep(poll);
    }
  }

  private async execute(owner: string, runId: string, state: { aborted: boolean }) {
    const { store } = this.deps;
    const now = this.deps.now ?? Date.now;

    let slot: Awaited<ReturnType<LocalLauncher["acquire"]>>;
    try {
      slot = await this.acquire(owner, runId, state);
    } catch {
      return; // stopped while it waited: the stop request closes the run
    }
    if (slot === "aborted") return;
    if (slot === "declined") {
      await finalizeRun(this.deps.finalize, { emailHash: owner, runId }, { kind: "declined" });
      return;
    }

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
      const { stats, log, result }: LocalRunResult = await runLocal({
        input,
        sink: api,
        allowPrivate: this.deps.allowPrivate,
        resolve: this.deps.resolve,
        aborted: () => state.aborted,
        llm: this.deps.llm?.(),
        driverFactory: this.deps.driverFactory,
        // Names resolve through the dev resolver's loopback answers, so no real DNS is asked.
        dns: { records: async () => ({ ok: false, code: "ENODATA" }) },
      });
      await api.postEvidence("proxy-log", log);
      await api.postEvidence("proxy-stats", stats);
      if (result.profile) await api.postEvidence("app-profile", result.profile);
      if (result.usage) await api.postEvidence("usage", result.usage);
      if (result.explorerLog) await api.postEvidence("explorer-log", result.explorerLog);
      if (result.engagement) await api.postEvidence("engagement", result.engagement);
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
    await this.renderPdf(owner, runId);
  }

  /** What the PDF step does in the cloud, in process: render the closed run's report. Best effort. */
  private async renderPdf(owner: string, runId: string): Promise<void> {
    const render = this.deps.renderPdf;
    if (!render) return;
    try {
      const html = await this.deps.store.get(keys.runReportHtml(owner, runId));
      if (!html) return;
      await this.deps.store.putBytes(
        keys.runReportPdf(owner, runId),
        await render(html.body),
        "application/pdf",
      );
    } catch (err) {
      console.error(JSON.stringify({ msg: "local_pdf_failed", error: (err as Error).message }));
    }
  }
}
