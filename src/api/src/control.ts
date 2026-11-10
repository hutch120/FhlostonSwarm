import { reject } from "./http.js";
import type { Mailer } from "./mailer.js";
import type { RunLauncher } from "./launcher.js";
import type { EventPublisher } from "./publisher.js";
import { finalizeRun } from "./finalize.js";
import { claimRun, getRunFile, listRunFiles, releaseRun, type RunFile } from "./runs.js";
import { createJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

export interface ControlDeps {
  store: ObjectStore;
  launcher: RunLauncher;
  mailer: Mailer;
  publisher?: EventPublisher;
  now: () => number;
  siteOrigin: string;
}

/** Begins executing a queued run. Only one caller can claim it; if the execution cannot start the run goes back to queued. */
export async function startExecution(
  deps: ControlDeps,
  emailHash: string,
  runId: string,
): Promise<RunFile> {
  const run = await getRunFile(deps.store, emailHash, runId);
  if (!run) return reject(404, "not_found");
  const claimed = await claimRun(deps.store, emailHash, runId, deps.now());
  if (!claimed) return reject(409, "already_started");
  try {
    await deps.launcher.start(emailHash, runId);
  } catch (err) {
    await releaseRun(deps.store, emailHash, runId);
    console.error(JSON.stringify({ msg: "start_failed", name: (err as Error).name }));
    return reject(503, "start_failed");
  }
  return claimed;
}

/**
 * Stops a running run: records the request (so the finaliser reports `stopped`, not `failed`),
 * terminates the execution and its tasks, and closes the run with a partial report. A run that is
 * not running is left alone and returned as is.
 */
export async function stopRun(
  deps: ControlDeps,
  ids: { emailHash: string; runId: string },
  by: string,
): Promise<RunFile> {
  const { store } = deps;
  const run = await getRunFile(store, ids.emailHash, ids.runId);
  if (!run) return reject(404, "not_found");
  if (run.status !== "running") return run;
  await createJson(store, keys.runStop(ids.emailHash, ids.runId), {
    ...(run.test ? { test: true } : {}),
    at: deps.now(),
    by,
  });
  await deps.launcher.stop(ids.emailHash, ids.runId);
  return (await finalizeRun(deps, ids, { kind: "stopped" })) ?? run;
}

/** Stops every running run of an account (before the account or a run is deleted). */
export async function stopRunningRuns(
  deps: ControlDeps,
  emailHash: string,
  by: string,
): Promise<void> {
  const runs = await listRunFiles(deps.store, emailHash);
  for (const run of runs.filter((r) => r.status === "running")) {
    await stopRun(deps, { emailHash, runId: run.runId }, by);
  }
}
