import { reject } from "./http.js";
import type { Mailer } from "./mailer.js";
import type { RunLauncher } from "./launcher.js";
import type { EventPublisher } from "./publisher.js";
import { finalizeRun } from "./finalize.js";
import { getRunFile, listRunFiles, type RunFile } from "./runs.js";
import { effectiveSettings } from "./settings.js";
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

/**
 * Hands a queued run to the launcher. The run stays queued until its depth's pool has a free slot
 * (the execution's first step takes the slot and moves it to running), so this returns at once.
 * Starting twice is harmless: the execution is named by the run id.
 */
export async function startExecution(
  deps: ControlDeps,
  emailHash: string,
  runId: string,
): Promise<RunFile> {
  const run = await getRunFile(deps.store, emailHash, runId);
  if (!run) return reject(404, "not_found");
  if (run.status !== "queued") return reject(409, "already_started");
  if ((await effectiveSettings(deps.store)).killSwitch.on) return reject(503, "service_paused");
  try {
    await deps.launcher.start(emailHash, runId);
  } catch (err) {
    console.error(JSON.stringify({ msg: "start_failed", name: (err as Error).name }));
    return reject(503, "start_failed");
  }
  return run;
}

/**
 * Stops a run that is running or still waiting for a slot: records the request (so the finaliser
 * reports `stopped`, not `failed`), terminates the execution and its tasks, and closes the run with a
 * partial report. A run that waited and never started gets its credit back. A finished run is left
 * alone and returned as is.
 */
export async function stopRun(
  deps: ControlDeps,
  ids: { emailHash: string; runId: string },
  by: string,
  options: { cancelQueued?: boolean } = {},
): Promise<RunFile> {
  const { store } = deps;
  const run = await getRunFile(store, ids.emailHash, ids.runId);
  if (!run) return reject(404, "not_found");
  if (run.status === "queued" && !options.cancelQueued) {
    // About to be deleted: just make sure a waiting execution does not outlive the run.
    await deps.launcher.stop(ids.emailHash, ids.runId);
    return run;
  }
  if (run.status !== "running" && run.status !== "queued") return run;
  await createJson(store, keys.runStop(ids.emailHash, ids.runId), {
    ...(run.test ? { test: true } : {}),
    at: deps.now(),
    by,
  });
  await deps.launcher.stop(ids.emailHash, ids.runId);
  return (
    (await finalizeRun(
      deps,
      ids,
      run.status === "queued" ? { kind: "cancelled" } : { kind: "stopped" },
    )) ?? run
  );
}

/** Stops every running run of an account (before the account or a run is deleted). */
export async function stopRunningRuns(
  deps: ControlDeps,
  emailHash: string,
  by: string,
): Promise<void> {
  const runs = await listRunFiles(deps.store, emailHash);
  for (const run of runs.filter((r) => r.status === "running" || r.status === "queued")) {
    await stopRun(deps, { emailHash, runId: run.runId }, by);
  }
}
