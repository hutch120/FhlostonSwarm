import { ACCOUNT_ID, REGION, aws, awsJson } from "./aws.js";

export const DATA_BUCKET = `swarm-data-${ACCOUNT_ID}`;
export const TEST_PREFIX = "_test/";
/** The learning layer test accounts' runs use, so a test never changes what a customer's run uses. */
export const TEST_LAYER_PREFIX = "learning/test/";
export const TEST_NAME_PREFIX = "swarm-test-";
const MAX_RECORD_BYTES = 1024 * 1024;

export interface TestItems {
  /** Keys under `_test/` in the data bucket. */
  prefixKeys: string[];
  /** Keys of the test accounts' own learning layer (`learning/test/`). */
  layerKeys: string[];
  /** Keys elsewhere in the data bucket whose JSON carries `"test": true`. */
  recordKeys: string[];
  /** `swarm-test-*` S3 buckets. */
  buckets: string[];
  /** `swarm-test-*` CloudFormation stacks. */
  stacks: string[];
  /** Running `swarm-test-*` ECS tasks (the synthetic target); stopped with --delete. */
  tasks: string[];
  /** Any other resource tagged `swarm:test=true` (listed only, never auto-deleted). */
  taggedArns: string[];
}

export function isTestRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { test?: unknown }).test === true;
}

export function isTestResourceName(name: string): boolean {
  return name.startsWith(TEST_NAME_PREFIX);
}

/** Tagged resources that the name-based finders above already cover (S3 buckets, stacks). */
export function isCoveredByName(arn: string): boolean {
  const bucket = /^arn:aws:s3:::([^/]+)$/.exec(arn)?.[1];
  const stack = /^arn:aws:cloudformation:[^:]*:\d+:stack\/([^/]+)\//.exec(arn)?.[1];
  return [bucket, stack].some((name) => name !== undefined && isTestResourceName(name));
}

/**
 * ECS tasks are covered by the running-task finder; a stopped task cannot be deleted and ages out of
 * ECS by itself, so a tagged task is never listed as something to remove by hand.
 */
export function isEcsTask(arn: string): boolean {
  return /^arn:aws:ecs:[^:]*:\d+:task\/[^/]+\/[0-9a-f]+$/.test(arn);
}

/**
 * The synthetic target's task definition and security group are permanent, tagged `swarm:test=true`
 * on purpose (they are test infrastructure). Only a *running* task is something to clean up.
 */
export function isPermanentTestInfrastructure(
  arn: string,
  testGroupIds: readonly string[],
): boolean {
  const taskDefinition = /^arn:aws:ecs:[^:]*:\d+:task-definition\/([^:]+):\d+$/.exec(arn)?.[1];
  const group = /^arn:aws:ec2:[^:]*:\d+:security-group\/(sg-[0-9a-f]+)$/.exec(arn)?.[1];
  return (
    (taskDefinition !== undefined && isTestResourceName(taskDefinition)) ||
    (group !== undefined && testGroupIds.includes(group))
  );
}

async function listKeys(query: string, prefix?: string): Promise<string[]> {
  const args = ["s3api", "list-objects-v2", "--bucket", DATA_BUCKET, "--query", query];
  if (prefix) args.push("--prefix", prefix);
  return (await awsJson<string[] | null>(args)) ?? [];
}

async function readJson(key: string): Promise<unknown> {
  const r = await aws(["s3", "cp", `s3://${DATA_BUCKET}/${key}`, "-", "--profile", "swarm"]);
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** Finds everything that matches the test-data markers; reads nothing else and prints no contents. */
export async function findTestItems(): Promise<TestItems> {
  const prefixKeys = await listKeys("Contents[].Key", TEST_PREFIX);
  const layerKeys = await listKeys("Contents[].Key", TEST_LAYER_PREFIX);

  const candidates = await listKeys(
    `Contents[?ends_with(Key, '.json') && Size <= \`${MAX_RECORD_BYTES}\` && !starts_with(Key, '${TEST_PREFIX}')].Key`,
  );
  const recordKeys: string[] = [];
  for (const key of candidates) {
    if (isTestRecord(await readJson(key))) recordKeys.push(key);
  }

  const bucketNames = await awsJson<string[] | null>([
    "s3api",
    "list-buckets",
    "--query",
    `Buckets[?starts_with(Name, '${TEST_NAME_PREFIX}')].Name`,
  ]);
  const stackNames = await awsJson<string[] | null>([
    "cloudformation",
    "list-stacks",
    "--query",
    `StackSummaries[?starts_with(StackName, '${TEST_NAME_PREFIX}') && StackStatus!='DELETE_COMPLETE'].StackName`,
  ]);
  const tagged = await awsJson<{ ResourceTagMappingList: { ResourceARN: string }[] }>([
    "resourcegroupstaggingapi",
    "get-resources",
    "--tag-filters",
    "Key=swarm:test,Values=true",
  ]);
  const groups = await awsJson<{ SecurityGroups: { GroupId: string }[] }>([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=group-name,Values=${TEST_NAME_PREFIX}*`,
  ]);
  const testGroupIds = groups.SecurityGroups.map((g) => g.GroupId);
  const tasks = await runningTestTasks();

  return {
    prefixKeys,
    layerKeys,
    recordKeys,
    buckets: bucketNames ?? [],
    stacks: stackNames ?? [],
    tasks,
    taggedArns: tagged.ResourceTagMappingList.map((r) => r.ResourceARN).filter(
      (arn) =>
        !isCoveredByName(arn) &&
        !isEcsTask(arn) &&
        !isPermanentTestInfrastructure(arn, testGroupIds),
    ),
  };
}

const RUN_CLUSTER = "swarm-runs";

/** Running tasks of any `swarm-test-*` task definition family in the runs cluster. */
async function runningTestTasks(): Promise<string[]> {
  try {
    const families = await awsJson<{ families: string[] }>([
      "ecs",
      "list-task-definition-families",
      "--family-prefix",
      TEST_NAME_PREFIX,
      "--status",
      "ACTIVE",
    ]);
    const arns: string[] = [];
    for (const family of families.families) {
      const found = await awsJson<{ taskArns: string[] }>([
        "ecs",
        "list-tasks",
        "--cluster",
        RUN_CLUSTER,
        "--family",
        family,
        "--desired-status",
        "RUNNING",
      ]);
      arns.push(...found.taskArns);
    }
    return arns;
  } catch {
    // No cluster yet (the runs stack is not deployed).
    return [];
  }
}

function check(r: { code: number; stderr: string }, what: string): void {
  if (r.code !== 0) throw new Error(`Failed to delete ${what}: ${r.stderr.trim()}`);
}

async function deleteItems(items: TestItems): Promise<void> {
  if (items.prefixKeys.length > 0) {
    check(
      await aws([
        "s3",
        "rm",
        `s3://${DATA_BUCKET}/${TEST_PREFIX}`,
        "--recursive",
        "--profile",
        "swarm",
      ]),
      TEST_PREFIX,
    );
  }
  if (items.layerKeys.length > 0) {
    check(
      await aws([
        "s3",
        "rm",
        `s3://${DATA_BUCKET}/${TEST_LAYER_PREFIX}`,
        "--recursive",
        "--profile",
        "swarm",
      ]),
      TEST_LAYER_PREFIX,
    );
  }
  for (const key of items.recordKeys) {
    check(
      await aws([
        "s3api",
        "delete-object",
        "--bucket",
        DATA_BUCKET,
        "--key",
        key,
        "--profile",
        "swarm",
      ]),
      key,
    );
  }
  for (const bucket of items.buckets) {
    check(await aws(["s3", "rb", `s3://${bucket}`, "--force", "--profile", "swarm"]), bucket);
  }
  for (const stack of items.stacks) {
    check(
      await aws([
        "cloudformation",
        "delete-stack",
        "--stack-name",
        stack,
        "--region",
        REGION,
        "--profile",
        "swarm",
      ]),
      stack,
    );
  }
  for (const task of items.tasks) {
    check(
      await aws([
        "ecs",
        "stop-task",
        "--cluster",
        RUN_CLUSTER,
        "--task",
        task,
        "--reason",
        "swarm test-cleanup",
        "--region",
        REGION,
        "--profile",
        "swarm",
      ]),
      task,
    );
  }
}

export async function testCleanup(opts: { delete?: boolean }): Promise<void> {
  const items = await findTestItems();
  const sections: [string, string[]][] = [
    [`Objects under s3://${DATA_BUCKET}/${TEST_PREFIX}`, items.prefixKeys],
    [`Test learning layer under s3://${DATA_BUCKET}/${TEST_LAYER_PREFIX}`, items.layerKeys],
    [`Records marked "test": true in s3://${DATA_BUCKET}`, items.recordKeys],
    [`${TEST_NAME_PREFIX}* S3 buckets`, items.buckets],
    [`${TEST_NAME_PREFIX}* CloudFormation stacks`, items.stacks],
    [`Running ${TEST_NAME_PREFIX}* ECS tasks (the synthetic target)`, items.tasks],
    ["Other resources tagged swarm:test=true (delete manually)", items.taggedArns],
  ];
  let total = 0;
  for (const [title, entries] of sections) {
    total += entries.length;
    console.log(`${title}: ${entries.length}`);
    for (const entry of entries) console.log(`  ${entry}`);
  }

  if (total === 0) {
    console.log("\nNothing to clean up.");
    return;
  }
  if (!opts.delete) {
    console.log("\nDry run. Re-run with --delete to remove the items above.");
    return;
  }
  await deleteItems(items);
  console.log(
    "\nDeleted. Resources tagged swarm:test=true that are not listed as deletable above need manual removal.",
  );
}
