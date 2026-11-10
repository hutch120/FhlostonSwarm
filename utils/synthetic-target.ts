import { REGION, aws, awsJson } from "./aws.js";

/** Fixed names from src/infra/src/names.ts (the CLI does not import the CDK app). */
export const RUN_CLUSTER = "swarm-runs";
export const SYNTHETIC_TARGET_FAMILY = "swarm-test-synthetic-target";
export const SYNTHETIC_TARGET_PORT = 8080;
const RUNS_STACK = "SwarmRuns";

export interface TargetNetwork {
  subnets: string[];
  securityGroup: string;
}

/** The subnets and security group the runs stack exports for the synthetic target. */
export function parseNetwork(outputs: { OutputKey: string; OutputValue: string }[]): TargetNetwork {
  const value = (key: string) => outputs.find((o) => o.OutputKey.startsWith(key))?.OutputValue;
  const subnets = value("SyntheticTargetSubnets")?.split(",").filter(Boolean);
  const securityGroup = value("SyntheticTargetSecurityGroupId");
  if (!subnets?.length || !securityGroup) {
    throw new Error(
      `The ${RUNS_STACK} stack has no synthetic target outputs. Deploy it first (swarm deploy).`,
    );
  }
  return { subnets, securityGroup };
}

/** `aws ecs run-task` arguments: a public-IP Fargate task, tagged as test data with the run id. */
export function runTaskArgs(network: TargetNetwork, testRunId: string): string[] {
  return [
    "ecs",
    "run-task",
    "--cluster",
    RUN_CLUSTER,
    "--task-definition",
    SYNTHETIC_TARGET_FAMILY,
    "--launch-type",
    "FARGATE",
    "--network-configuration",
    `awsvpcConfiguration={subnets=[${network.subnets.join(",")}],securityGroups=[${network.securityGroup}],assignPublicIp=ENABLED}`,
    "--tags",
    "key=swarm:test,value=true",
    `key=swarm:test-run,value=${testRunId}`,
    "--count",
    "1",
  ];
}

interface TaskDescription {
  taskArn: string;
  lastStatus: string;
  attachments?: { type: string; details: { name: string; value: string }[] }[];
}

export async function runningTargetTasks(): Promise<string[]> {
  const found = await awsJson<{ taskArns: string[] }>([
    "ecs",
    "list-tasks",
    "--cluster",
    RUN_CLUSTER,
    "--family",
    SYNTHETIC_TARGET_FAMILY,
    "--desired-status",
    "RUNNING",
  ]);
  return found.taskArns;
}

async function publicIp(task: string): Promise<string | null> {
  const described = await awsJson<{ tasks: TaskDescription[] }>([
    "ecs",
    "describe-tasks",
    "--cluster",
    RUN_CLUSTER,
    "--tasks",
    task,
  ]);
  const eni = described.tasks[0]?.attachments
    ?.find((a) => a.type === "ElasticNetworkInterface")
    ?.details.find((d) => d.name === "networkInterfaceId")?.value;
  if (!eni) return null;
  const nics = await awsJson<{ NetworkInterfaces: { Association?: { PublicIp?: string } }[] }>([
    "ec2",
    "describe-network-interfaces",
    "--network-interface-ids",
    eni,
  ]);
  return nics.NetworkInterfaces[0]?.Association?.PublicIp ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts the synthetic target and prints its URL. It is stopped with `swarm synthetic-target stop`. */
export async function startSyntheticTarget(): Promise<string> {
  const existing = await runningTargetTasks();
  if (existing.length > 0) {
    const ip = await publicIp(existing[0]!);
    if (ip) {
      const url = `http://${ip}:${SYNTHETIC_TARGET_PORT}/`;
      console.log(`Already running: ${url}`);
      return url;
    }
  }
  const stack = await awsJson<{
    Stacks: { Outputs: { OutputKey: string; OutputValue: string }[] }[];
  }>(["cloudformation", "describe-stacks", "--stack-name", RUNS_STACK]);
  const network = parseNetwork(stack.Stacks[0]?.Outputs ?? []);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const runId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-${Math.random().toString(36).slice(2, 6)}`;
  const started = await awsJson<{ tasks: { taskArn: string }[]; failures: { reason: string }[] }>(
    runTaskArgs(network, runId),
  );
  const task = started.tasks[0]?.taskArn;
  if (!task) throw new Error(`Could not start the task: ${JSON.stringify(started.failures)}`);
  console.log(`Started ${task.split("/").pop()}; waiting for it to run…`);

  const waited = await aws([
    "ecs",
    "wait",
    "tasks-running",
    "--cluster",
    RUN_CLUSTER,
    "--tasks",
    task,
    "--profile",
    "swarm",
    "--region",
    REGION,
  ]);
  if (waited.code !== 0) throw new Error(`The task did not reach RUNNING: ${waited.stderr.trim()}`);
  const ip = await publicIp(task);
  if (!ip) throw new Error("The task has no public IP");
  const url = `http://${ip}:${SYNTHETIC_TARGET_PORT}/`;
  for (let i = 0; i < 40; i++) {
    if (await healthy(url)) {
      console.log(`Synthetic target is up: ${url}`);
      console.log(`Stop it when you are done: swarm synthetic-target stop`);
      return url;
    }
    await sleep(3000);
  }
  throw new Error(`The synthetic target did not answer at ${url}`);
}

/** Stops every running synthetic target task (and nothing else). */
export async function stopSyntheticTarget(): Promise<number> {
  const tasks = await runningTargetTasks();
  for (const task of tasks) {
    await awsJson([
      "ecs",
      "stop-task",
      "--cluster",
      RUN_CLUSTER,
      "--task",
      task,
      "--reason",
      "swarm synthetic-target stop",
    ]);
  }
  console.log(
    tasks.length === 0 ? "No synthetic target is running." : `Stopped ${tasks.length} task(s).`,
  );
  return tasks.length;
}

export async function syntheticTargetStatus(): Promise<void> {
  const tasks = await runningTargetTasks();
  if (tasks.length === 0) {
    console.log("No synthetic target is running.");
    return;
  }
  for (const task of tasks) {
    const ip = await publicIp(task);
    console.log(
      `${task.split("/").pop()}  ${ip ? `http://${ip}:${SYNTHETIC_TARGET_PORT}/` : "(no public IP yet)"}`,
    );
  }
}
