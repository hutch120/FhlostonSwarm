import { randomUUID } from "node:crypto";
import { appProfileSchema, runReportSchema } from "@swarm/shared";
import {
  dynamicResultsSchema,
  engagementSchema,
  layerRoot,
  learnerCostSchema,
  pinLayer,
  pinnedLayerSchema,
  readActive,
  runCostSchema,
  withLearnerCost,
  type PinnedLayer,
} from "@swarm/shared/server";
import {
  runLearningPass,
  type FetchLike,
  type LearnResult,
  type LlmClient,
  type RunData,
} from "@swarm/agents/learning";
import { z } from "zod";
import { getRunFile, getRunInput } from "./runs.js";
import type { Mailer } from "./mailer.js";
import { addSpend } from "./spend.js";
import { createJson, getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * The dynamic layer as the API uses it (PLAN.md section 9): a run is pinned to one version of the
 * layer when its task first asks for its input, and the learning pass reviews the run once it has
 * closed. The layer itself (versions, pointer, stats, lock, log) is in `@swarm/shared`; the pass is
 * in `@swarm/agents/learning`.
 */

const pinSchema = z.object({ layer: pinnedLayerSchema.nullable() });

/**
 * The layer the run uses, fixed the first time the task asks for its input (so a retry of the task
 * gets the same one, and `engagement.json` can say which version the run used). Test accounts use
 * their own layer. Null when the layer is off.
 */
export async function pinDynamic(
  store: ObjectStore,
  emailHash: string,
  runId: string,
  test: boolean,
  now: number,
): Promise<PinnedLayer | null> {
  const at = keys.runDynamic(emailHash, runId);
  const existing = await getJson(store, at, pinSchema);
  if (existing) return existing.value.layer;
  const active = await readActive(store, layerRoot(test), new Date(now));
  const layer = active ? pinLayer(active.snapshot, active.stats) : null;
  await createJson(store, at, { ...(test ? { test: true } : {}), layer });
  // Two task starts may race; the first write wins and both use it.
  return (await getJson(store, at, pinSchema))?.value.layer ?? layer;
}

const explorerLogSchema = z.object({ pages: z.array(z.string()).default([]) });

const evidence = async <S extends z.ZodType>(
  store: ObjectStore,
  emailHash: string,
  runId: string,
  name: string,
  schema: S,
): Promise<z.infer<S> | null> =>
  (await getJson(store, keys.runEvidence(emailHash, runId, name), schema).catch(() => null))
    ?.value ?? null;

/** What the learning pass reads of a closed run, from that run's own prefix only. */
export async function loadRunData(
  store: ObjectStore,
  emailHash: string,
  runId: string,
): Promise<RunData | null> {
  const file = await getRunFile(store, emailHash, runId);
  const input = await getRunInput(store, emailHash, runId);
  const report = (
    await getJson(store, keys.runReportData(emailHash, runId), runReportSchema).catch(() => null)
  )?.value;
  if (!file || !input || !report) return null;
  const profile = await evidence(store, emailHash, runId, "app-profile", appProfileSchema);
  return {
    runId,
    tier: file.tier,
    test: file.test === true,
    report,
    engagement: await evidence(store, emailHash, runId, "engagement", engagementSchema),
    profile,
    results: await evidence(store, emailHash, runId, "dynamic-results", dynamicResultsSchema),
    input: {
      hosts: input.target.hosts,
      urls: [input.target.appUrl, input.target.marketingUrl].filter(Boolean),
      logins: Object.values(input.target.logins).map((l) => ({
        username: l.username,
        password: l.password,
        description: l.description,
        notes: l.notes ?? "",
      })),
      scopeNotes: input.target.scopeNotes,
    },
    pages:
      (await evidence(store, emailHash, runId, "explorer-log", explorerLogSchema))?.pages ?? [],
  };
}

export interface LearnDeps {
  store: ObjectStore;
  /** The learner model, and the one to try if it cannot be invoked. */
  llm: LlmClient | null;
  fallbackLlm?: LlmClient | null;
  fetch: FetchLike;
  now: () => number;
  /** For the daily spend alarm, which the learner's own cost can also trip. */
  mailer?: Mailer;
  alertTo?: string;
}

const indexRecordSchema = z.record(z.string(), z.unknown());

/**
 * The state machine's `Learn` step: reviews the closed run, applies what the learner proposes and
 * records the learner's own cost next to the run's. Runs that did not complete are not learned
 * from (a failure on our side says nothing about the target). Never throws for the run's sake.
 */
export async function learnFromRun(
  deps: LearnDeps,
  ids: { emailHash: string; runId: string },
): Promise<LearnResult | { outcome: "skipped"; note: string }> {
  const { store } = deps;
  const run = await loadRunData(store, ids.emailHash, ids.runId);
  if (!run) return { outcome: "skipped", note: "The run has no report to review." };
  if (run.report.status !== "complete") {
    return { outcome: "skipped", note: "Only completed runs are reviewed." };
  }

  const result = await runLearningPass({
    storage: store,
    root: layerRoot(run.test),
    llm: deps.llm,
    fallbackLlm: deps.fallbackLlm,
    fetch: deps.fetch,
    now: () => new Date(deps.now()),
    holder: `learn-${randomUUID().slice(0, 8)}`,
    trigger: "run",
    apply: true,
    run,
  });

  if (result.cost) {
    const learner = learnerCostSchema.parse(result.cost);
    const cost = await getJson(store, keys.runCost(ids.emailHash, ids.runId), runCostSchema).catch(
      () => null,
    );
    if (cost) {
      const next = withLearnerCost(cost.value, learner);
      await putJson(store, keys.runCost(ids.emailHash, ids.runId), next);
      // The anonymised index keeps the learner as its own line, too (it outlives the run).
      const indexKey = keys.runIndex(new Date(next.finishedAt), ids.runId);
      const index = await getJson(store, indexKey, indexRecordSchema).catch(() => null);
      if (index) {
        await putJson(store, indexKey, {
          ...index.value,
          learner: {
            modelId: learner.modelId,
            calls: learner.calls,
            inputTokens: learner.inputTokens,
            outputTokens: learner.outputTokens,
            usd: learner.usd,
            seconds: learner.seconds,
          },
        });
      }
      await addSpend(
        { store, mailer: deps.mailer, alertTo: deps.alertTo },
        deps.now(),
        learner.usd,
      );
    }
  }
  return result;
}
