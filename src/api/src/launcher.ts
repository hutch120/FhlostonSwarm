import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  ExecutionAlreadyExists,
  ExecutionDoesNotExist,
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";

/** Starts and stops the execution that runs one run's agents. */
export interface RunLauncher {
  start(owner: string, runId: string): Promise<void>;
  /** Stops the run's execution and any task still running for it. Safe to call twice. */
  stop(owner: string, runId: string): Promise<void>;
}

/** Env var the orchestrator puts on a task so it can be matched to its run. */
export const RUN_ID_ENV = "SWARM_RUN_ID";

export interface AwsLauncherOptions {
  stateMachineArn: string;
  cluster: string;
  sfn?: SFNClient;
  ecs?: ECSClient;
}

/** The run id a task was started for, from its container overrides. */
export const taskRunId = (task: Task): string | undefined =>
  task.overrides?.containerOverrides
    ?.flatMap((c) => c.environment ?? [])
    .find((e) => e.name === RUN_ID_ENV)?.value;

export const taskEnv = (task: Task, name: string): string | undefined =>
  task.overrides?.containerOverrides
    ?.flatMap((c) => c.environment ?? [])
    .find((e) => e.name === name)?.value;

export async function describeRunningTasks(
  ecs: ECSClient,
  cluster: string,
  family?: string,
): Promise<Task[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ecs.send(
      new ListTasksCommand({ cluster, desiredStatus: "RUNNING", family, nextToken }),
    );
    arns.push(...(res.taskArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  const tasks: Task[] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const res = await ecs.send(
      new DescribeTasksCommand({ cluster, tasks: arns.slice(i, i + 100) }),
    );
    tasks.push(...(res.tasks ?? []));
  }
  return tasks;
}

export async function stopTask(ecs: ECSClient, cluster: string, task: Task, reason: string) {
  if (!task.taskArn) return;
  await ecs.send(new StopTaskCommand({ cluster, task: task.taskArn, reason }));
}

export class AwsLauncher implements RunLauncher {
  private readonly sfn: SFNClient;
  private readonly ecs: ECSClient;

  constructor(private readonly options: AwsLauncherOptions) {
    this.sfn = options.sfn ?? new SFNClient({});
    this.ecs = options.ecs ?? new ECSClient({});
  }

  private executionArn(runId: string): string {
    return `${this.options.stateMachineArn.replace(":stateMachine:", ":execution:")}:${runId}`;
  }

  async start(owner: string, runId: string): Promise<void> {
    try {
      await this.sfn.send(
        new StartExecutionCommand({
          stateMachineArn: this.options.stateMachineArn,
          // The execution name is the run id, so starting twice cannot run it twice.
          name: runId,
          input: JSON.stringify({ owner, runId }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ExecutionAlreadyExists)) throw err;
    }
  }

  async stop(_owner: string, runId: string): Promise<void> {
    try {
      await this.sfn.send(
        new StopExecutionCommand({
          executionArn: this.executionArn(runId),
          cause: "Stopped by the customer or staff",
        }),
      );
    } catch (err) {
      if (!(err instanceof ExecutionDoesNotExist)) throw err;
    }
    const tasks = await describeRunningTasks(this.ecs, this.options.cluster);
    for (const task of tasks.filter((t) => taskRunId(t) === runId)) {
      await stopTask(this.ecs, this.options.cluster, task, "Run stopped");
    }
  }
}

/** Records calls instead of running anything (unit tests). */
export class FakeLauncher implements RunLauncher {
  readonly started: { owner: string; runId: string }[] = [];
  readonly stopped: { owner: string; runId: string }[] = [];
  failStart = false;

  async start(owner: string, runId: string): Promise<void> {
    if (this.failStart) throw new Error("launcher down");
    this.started.push({ owner, runId });
  }
  async stop(owner: string, runId: string): Promise<void> {
    this.stopped.push({ owner, runId });
  }
}
