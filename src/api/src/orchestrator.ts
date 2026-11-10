import { ECSClient } from "@aws-sdk/client-ecs";
import {
  DescribeExecutionCommand,
  ListExecutionsCommand,
  SFNClient,
  StopExecutionCommand,
  type ExecutionStatus,
} from "@aws-sdk/client-sfn";
import { tiers } from "@swarm/shared";
import { runtimeConfig } from "@swarm/shared/server";
import { z } from "zod";
import { orchestratorEnvSchema } from "./env.js";
import { finalizeRun, type FinalizeDeps, type Outcome, type TaskTimes } from "./finalize.js";
import { describeRunningTasks, stopTask, taskEnv, taskRunId } from "./launcher.js";
import { SesMailer } from "./mailer.js";
import { acquireRun } from "./pool.js";
import { AppSyncPublisher } from "./publisher.js";
import { runToken } from "./runtoken.js";
import { getRunFile, getRunInput, isTerminal } from "./runs.js";
import { ssmSecrets } from "./secrets.js";
import { S3ObjectStore } from "./storage/store.js";

let cached:
  | {
      env: z.infer<typeof orchestratorEnvSchema>;
      deps: FinalizeDeps;
      secrets: ReturnType<typeof ssmSecrets>;
    }
  | undefined;

function services() {
  if (cached) return cached;
  const env = orchestratorEnvSchema.parse(process.env);
  const store = new S3ObjectStore(env.DATA_BUCKET);
  cached = {
    env,
    secrets: ssmSecrets({ pepper: env.PEPPER_PARAMETER, jwtKey: env.JWT_PARAMETER }),
    deps: {
      store,
      mailer: new SesMailer({
        from: env.MAIL_FROM,
        replyTo: env.MAIL_REPLY_TO,
        configurationSet: env.SES_CONFIGURATION_SET,
      }),
      publisher: new AppSyncPublisher({
        httpDomain: env.EVENTS_HTTP_DOMAIN,
        region: env.AWS_REGION,
      }),
      now: Date.now,
      siteOrigin: env.SITE_ORIGIN,
    },
  };
  return cached;
}

const taskInput = z.object({ owner: z.string().regex(/^[0-9a-f]{64}$/), runId: z.string().min(1) });

/**
 * State machine step 1: takes the run's place in its depth's pool (it keeps waiting, a poll at a
 * time, while the pool is full), then mints the run token. The token and the hard time limit go to
 * the agent task through the container environment.
 */
export async function prepare(event: unknown) {
  const { owner, runId } = taskInput.parse(event);
  const { deps, secrets, env } = services();
  const run = await getRunFile(deps.store, owner, runId);
  const input = await getRunInput(deps.store, owner, runId);
  if (!run || !input) throw new Error("run_not_found");
  if (isTerminal(run.status)) throw new Error("run_not_running");
  if (run.status === "queued") {
    const got = await acquireRun(deps.store, { emailHash: owner, runId }, deps.now());
    if (got.status === "waiting") return { owner, runId, waiting: true as const };
    if (got.status === "declined") throw new Error("queue_timeout");
  }
  const maxSeconds =
    Math.round(tiers[input.tier].wallClockMinutes * 60) + runtimeConfig.taskTimeoutMarginSeconds;
  return {
    owner,
    runId,
    waiting: false as const,
    token: runToken(await secrets(), owner, runId),
    maxSeconds,
    apiBase: env.INTERNAL_API_BASE,
  };
}

/**
 * An ECS task timestamp as the state machine passes it on: an ISO string, or epoch seconds or
 * milliseconds as a number. Always returned as ISO.
 */
const taskTime = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  });

export const finalizeInput = taskInput.extend({
  task: z.object({ pullStartedAt: taskTime, startedAt: taskTime, stoppedAt: taskTime }).optional(),
  /** Present when the agent task (or an earlier step) failed. */
  error: z.unknown().optional(),
});

/** A wait that ran out is a decline (the credit goes back); any other error is a failure on our side. */
const outcomeOf = (error: unknown): Outcome =>
  error === undefined || error === null
    ? { kind: "finished" }
    : JSON.stringify(error).includes("queue_timeout")
      ? { kind: "declined" }
      : { kind: "failed" };

/** State machine last step: closes the run (report, cost, index, notice). */
export async function finalize(event: unknown) {
  const input = finalizeInput.parse(event);
  const { deps } = services();
  const run = await finalizeRun(
    deps,
    { emailHash: input.owner, runId: input.runId },
    outcomeOf(input.error),
    (input.task ?? {}) as TaskTimes,
  );
  return { runId: input.runId, status: run?.status ?? "missing" };
}

const reaperInput = z.object({ maxRuntimeSeconds: z.number().positive().optional() }).optional();
const STUCK_STATUSES: ExecutionStatus[] = ["TIMED_OUT", "FAILED", "ABORTED"];

/**
 * Safety net, run on a schedule: stops any agent task that has outlived its run's time limit or
 * belongs to a run that has already ended, and closes runs whose execution died without finalising.
 */
export async function reaper(event: unknown) {
  const options = reaperInput.parse(event);
  const { deps, env } = services();
  const ecs = new ECSClient({});
  const sfn = new SFNClient({});
  const graceSeconds = runtimeConfig.reaper.graceMinutes * 60;
  const now = Date.now();
  const report = { tasksStopped: 0, runsClosed: 0, executionsStopped: 0 };

  for (const task of await describeRunningTasks(ecs, env.ECS_CLUSTER, env.AGENT_FAMILY)) {
    const runId = taskRunId(task);
    const owner = taskEnv(task, "SWARM_OWNER");
    const started = (task.startedAt ?? task.createdAt)?.getTime() ?? now;
    const maxSeconds =
      options?.maxRuntimeSeconds ?? Number(taskEnv(task, "SWARM_MAX_SECONDS") ?? 0);
    const tooOld =
      maxSeconds > 0 && now - started > (maxSeconds + (options ? 0 : graceSeconds)) * 1000;
    const run = runId && owner ? await getRunFile(deps.store, owner, runId) : null;
    const orphan = !run || isTerminal(run.status);
    if (tooOld || (orphan && now - started > 60_000)) {
      await stopTask(
        ecs,
        env.ECS_CLUSTER,
        task,
        tooOld ? "Reaper: over its time limit" : "Reaper: run has ended",
      );
      report.tasksStopped += 1;
      if (tooOld && runId && owner) {
        await finalizeRun(deps, { emailHash: owner, runId }, { kind: "failed" });
        report.runsClosed += 1;
      }
    }
  }

  const executions = await Promise.all(
    [...STUCK_STATUSES, "RUNNING" as const].map(async (status) => ({
      status,
      list:
        (
          await sfn.send(
            new ListExecutionsCommand({
              stateMachineArn: env.STATE_MACHINE_ARN,
              statusFilter: status,
              maxResults: 25,
            }),
          )
        ).executions ?? [],
    })),
  );
  for (const { status, list } of executions) {
    for (const execution of list) {
      const runId = execution.name;
      if (!runId) continue;
      if (status === "RUNNING") {
        const age = now - (execution.startDate?.getTime() ?? now);
        if (age <= 2 * 3600 * 1000 + graceSeconds * 1000) continue;
        await sfn.send(
          new StopExecutionCommand({
            executionArn: execution.executionArn,
            cause: "Reaper: stuck",
          }),
        );
        report.executionsStopped += 1;
      }
      // The execution input is {owner, runId}; read it back from the run id's owner via the listing.
      const owner = await ownerOf(sfn, execution.executionArn);
      if (!owner) continue;
      const run = await getRunFile(deps.store, owner, runId);
      if (run && (run.status === "running" || run.status === "queued")) {
        await finalizeRun(deps, { emailHash: owner, runId }, { kind: "failed" });
        report.runsClosed += 1;
      }
    }
  }
  return report;
}

async function ownerOf(sfn: SFNClient, executionArn: string | undefined): Promise<string | null> {
  if (!executionArn) return null;
  const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  try {
    return taskInput.parse(JSON.parse(described.input ?? "{}")).owner;
  } catch {
    return null;
  }
}
