import {
  BedrockLlm,
  runLearningPass,
  type LearnResult,
  type LlmClient,
  type RunData,
} from "../src/agents/src/learning/index.js";
import { learnFromRun, loadRunData } from "../src/api/src/learning.js";
import { keys } from "../src/api/src/storage/keys.js";
import { S3ObjectStore, type ObjectStore } from "../src/api/src/storage/store.js";
import { runReportSchema, tiers, type RunReport } from "@swarm/shared";
import {
  dynamicResultsSchema,
  engagementSchema,
  gateFor,
  layerRoot,
  learningConfig,
  listVersions,
  readActive,
  readLogs,
  readPointer,
  readSnapshot,
  readStats,
  setPointer,
  updateStats,
  type DynamicResults,
  type Gate,
} from "@swarm/shared/server";
import expected from "../src/synthetic-target/expected.json" with { type: "json" };
import { ACCOUNT_ID, DEFAULT_PROFILE, REGION, aws } from "./aws.js";
import { DATA_BUCKET } from "./test-cleanup.js";

/**
 * `swarm learn` and `swarm learning ...`: the staff view of the dynamic layer (PLAN.md section 9).
 * They read and write the live data bucket with the swarm profile; every command is safe to run
 * while runs are going (the layer is versioned and its writes are conditional).
 */

async function connect(): Promise<{ store: ObjectStore; by: string }> {
  // The AWS SDK reads these, so it uses the same profile and region as every other swarm command.
  process.env["AWS_PROFILE"] = DEFAULT_PROFILE;
  process.env["AWS_REGION"] = REGION;
  const identity = await aws([
    "sts",
    "get-caller-identity",
    "--profile",
    DEFAULT_PROFILE,
    "--output",
    "json",
  ]);
  if (identity.code !== 0) throw new Error("Could not read the caller identity. Run: swarm login");
  const { Account, Arn } = JSON.parse(identity.stdout) as { Account: string; Arn: string };
  if (Account !== ACCOUNT_ID)
    throw new Error(`Profile is account ${Account}, expected ${ACCOUNT_ID}.`);
  return { store: new S3ObjectStore(DATA_BUCKET), by: Arn };
}

const learnerModels = () => ({
  llm: new BedrockLlm({ modelId: learningConfig.learnerModelId, region: REGION }),
  fallbackLlm: new BedrockLlm({ modelId: learningConfig.fallbackModelId, region: REGION }),
});

/** The owner of a run, found by looking for its summary under every account (staff only, rare). */
export async function findRunOwner(store: ObjectStore, runId: string): Promise<string> {
  for (const folder of await store.folders("users/")) {
    const owner = folder.slice("users/".length).replace(/\/$/, "");
    if (/^[0-9a-f]{64}$/.test(owner) && (await store.get(keys.runSummary(owner, runId))))
      return owner;
  }
  throw new Error(`No run ${runId} was found.`);
}

function print(result: LearnResult | { outcome: string; note?: string }, dry: boolean): void {
  console.log(
    `${dry ? "Dry run: " : ""}${result.outcome}${"note" in result && result.note ? `: ${result.note}` : ""}`,
  );
  if (!("applied" in result)) return;
  if (result.version !== null)
    console.log(`${dry ? "Would write" : "Wrote"} version ${result.version}`);
  if (result.model) console.log(`Model: ${result.model}`);
  for (const line of result.lifecycle) console.log(`  lifecycle: ${line}`);
  for (const line of result.applied) console.log(`  applied: ${line}`);
  for (const r of result.rejected) console.log(`  rejected ${r.what}: ${r.why}`);
  for (const problem of result.problems) console.log(`  source problem: ${problem}`);
  if (result.sources.length > 0) {
    console.log(
      `Sources read: ${result.sources.map((s) => `${s.id} (${s.fetchedAt.slice(0, 10)})`).join(", ")}`,
    );
  }
  if (result.cost) {
    console.log(
      `Learner: ${result.cost.calls} call(s), ${result.cost.inputTokens} in / ${result.cost.outputTokens} out tokens, about US$${result.cost.usd.toFixed(4)}, ${result.cost.seconds}s`,
    );
  }
  if (dry && result.proposal) console.log(`Proposal:\n${JSON.stringify(result.proposal, null, 2)}`);
}

export interface LearnArgs {
  dryRun?: boolean;
  apply?: boolean;
  run?: string;
  force?: boolean;
}

/** `swarm learn --dry-run | --apply [--run <id>]`: propose from a run and/or the sources, and print the diff. */
export async function learn(args: LearnArgs): Promise<void> {
  if (!args.dryRun === !args.apply) throw new Error("Choose exactly one of --dry-run and --apply.");
  const { store } = await connect();
  const dry = args.dryRun === true;

  if (args.run && args.apply && !args.force) {
    // Same as the state machine's Learn step, including the learner's line in the run's cost.
    const owner = await findRunOwner(store, args.run);
    print(
      await learnFromRun(
        { store, ...learnerModels(), fetch: globalThis.fetch, now: Date.now },
        { emailHash: owner, runId: args.run },
      ),
      false,
    );
    return;
  }

  let run: RunData | null = null;
  if (args.run) {
    run = await loadRunData(store, await findRunOwner(store, args.run), args.run);
    if (!run) throw new Error(`Run ${args.run} has no report to review.`);
  }
  const result = await runLearningPass({
    storage: store,
    root: layerRoot(run?.test ?? false),
    ...learnerModels(),
    fetch: globalThis.fetch,
    now: () => new Date(),
    holder: "staff-cli",
    trigger: run ? "run" : "manual",
    apply: !dry,
    run,
    force: args.force ?? run === null,
  });
  print(result, dry);
}

/** Whether the configured learner model can be invoked here, without spending more than a token. */
async function probe(llm: LlmClient): Promise<string> {
  try {
    await llm.converse({
      system: "Answer with one word.",
      messages: [{ role: "user", content: [{ type: "text", text: "Say ok" }] }],
      tools: [],
      maxTokens: 5,
    });
    return "can be invoked";
  } catch (err) {
    return `cannot be invoked (${(err as Error).name})`;
  }
}

export async function status(options: { test?: boolean }): Promise<void> {
  const { store } = await connect();
  const root = layerRoot(options.test === true);
  const active = await readActive(store, root, new Date());
  const pointer = (await readPointer(store, root))?.value;
  console.log(`Layer: ${root} (${learningConfig.enabled ? "enabled in config" : "OFF in config"})`);
  if (!pointer) console.log("No layer yet: it is created the first time a run asks for it.");
  else {
    console.log(
      `Pointer: version ${pointer.version}, ${pointer.enabled ? "on" : "KILL SWITCH ON (runs use the baseline only)"}, set ${pointer.updatedAt} by ${pointer.by}`,
    );
  }
  if (active) {
    const { snapshot, stats } = active;
    const count = (list: { status: string }[]) =>
      ["active", "candidate", "retired"]
        .map((s) => `${list.filter((x) => x.status === s).length} ${s}`)
        .join(", ");
    console.log(`Items: ${count(snapshot.items)} (cap ${learningConfig.limits.maxActiveItems})`);
    console.log(
      `Dynamic agents: ${count(snapshot.agents)} (cap ${learningConfig.limits.maxDynamicAgents})`,
    );
    console.log(`Runs reviewed: ${stats.runs}`);
    console.log(
      stats.gate
        ? `Regression gate: ${stats.gate.passed ? "passed" : "FAILED"} for version ${stats.gate.version} (${stats.gate.found}/${stats.gate.expected} found, ${stats.gate.stray} stray) at ${stats.gate.recordedAt}`
        : "Regression gate: none recorded",
    );
  } else if (pointer) {
    const stats = (await readStats(store, root)).value;
    console.log(`Runs reviewed: ${stats.runs}`);
  }
  for (const log of (await readLogs(store, root, 3)).reverse()) {
    console.log(
      `Last passes: ${log.at} ${log.outcome}${log.toVersion ? ` -> v${log.toVersion}` : ""} (${log.model ?? "no model"})`,
    );
  }
  console.log(
    `Learner model ${learningConfig.learnerModelId}: ${await probe(learnerModels().llm)}`,
  );
  console.log(
    `Fallback model ${learningConfig.fallbackModelId}: ${await probe(learnerModels().fallbackLlm)}`,
  );
}

export async function versions(options: { test?: boolean }): Promise<void> {
  const { store } = await connect();
  const root = layerRoot(options.test === true);
  const current = (await readPointer(store, root))?.value.version;
  for (const n of await listVersions(store, root)) {
    const snapshot = await readSnapshot(store, root, n);
    if (!snapshot) continue;
    console.log(
      `${n === current ? "*" : " "} v${n}  ${snapshot.createdAt}  parent ${snapshot.parent ?? "-"}  ${snapshot.items.filter((i) => i.status !== "retired").length} items, ${snapshot.agents.filter((a) => a.status !== "retired").length} agents  ${snapshot.reason}`,
    );
  }
}

export async function rollback(version: number, options: { test?: boolean }): Promise<void> {
  if (!Number.isInteger(version) || version < 1) throw new Error("Give a version number, e.g. 3.");
  const { store, by } = await connect();
  const pointer = await setPointer(store, layerRoot(options.test === true), {
    version,
    by,
    note: `rollback to ${version}`,
    now: new Date(),
  });
  console.log(`Runs now use version ${pointer.version}. The versions after it are kept.`);
}

export async function setEnabled(enabled: boolean, options: { test?: boolean }): Promise<void> {
  const { store, by } = await connect();
  const pointer = await setPointer(store, layerRoot(options.test === true), {
    enabled,
    by,
    note: enabled ? "kill switch off" : "kill switch on",
    now: new Date(),
  });
  console.log(
    enabled
      ? `The layer is on (version ${pointer.version}).`
      : "Kill switch on: runs use the baseline only and nothing is learned.",
  );
}

// The synthetic-target regression gate ---------------------------------------------------------------

/**
 * Compares a synthetic-target run with the seeded ground truth. `found` counts the seeded issues the
 * run raised (among those its depth and logins can reach); `stray` counts findings that are not
 * seeded, and what a candidate agent in shadow said it would have raised that is not a learned
 * issue the target seeds on purpose. A run passes when nothing is missing and nothing is stray.
 */
export function evaluateGate(input: {
  report: Pick<RunReport, "tier" | "findings">;
  logins: number;
  results: DynamicResults | null;
  groundTruth?: typeof expected;
}): { found: number; expected: number; stray: number } {
  const truth = input.groundTruth ?? expected;
  const group = new Set<string>(tiers[input.report.tier].agents);
  const want = truth.findings.filter((f) => {
    const needs = "minLogins" in f ? f.minLogins : "needsLogin" in f && f.needsLogin ? 1 : 0;
    return group.has(f.agent) && input.logins >= (needs ?? 0);
  });
  const matches = (agent: string, title: string) =>
    want.some((w) => w.agent === agent && title.includes(w.titleIncludes));
  const learned = (title: string) => truth.learned.some((l) => title.includes(l.titleIncludes));
  const found = want.filter((w) =>
    input.report.findings.some((f) => f.agent === w.agent && f.title.includes(w.titleIncludes)),
  ).length;
  const stray =
    input.report.findings.filter(
      (f) => !matches(f.agent, f.title) && !(f.agent.startsWith("dyn-") && learned(f.title)),
    ).length + (input.results?.wouldRaise.filter((w) => !learned(w.title)).length ?? 0);
  return { found, expected: want.length, stray };
}

/** `swarm learning gate --run <id>`: records the regression a candidate must pass before it is promoted. */
export async function gate(runId: string): Promise<void> {
  const { store } = await connect();
  const owner = await findRunOwner(store, runId);
  const run = await loadRunData(store, owner, runId);
  if (!run) throw new Error(`Run ${runId} has no report to check.`);
  const report = runReportSchema.parse(run.report);
  const plan = run.engagement ? engagementSchema.parse(run.engagement) : null;
  const results = run.results ? dynamicResultsSchema.parse(run.results) : null;
  const version = plan?.dynamic.version;
  if (!version)
    throw new Error("The run did not use the learning layer, so it proves nothing about it.");
  const score = evaluateGate({ report, logins: plan?.roles.length ?? 0, results });
  const recorded: Gate = gateFor({ version, runId, ...score, now: new Date() });
  // The gate belongs to the layer the run was pinned to: a test account's run proves the test layer,
  // a staff scan of the synthetic target proves the live one.
  await updateStats(store, layerRoot(run.test), (s) => ({ ...s, gate: recorded }));
  console.log(
    `${recorded.passed ? "Passed" : "FAILED"}: ${score.found} of ${score.expected} seeded issues found, ${score.stray} stray, against ${run.test ? "test" : "live"} layer version ${version}.`,
  );
}
