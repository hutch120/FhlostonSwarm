import { runtimeConfig } from "@swarm/shared/server";
import { PlaywrightDriver } from "./explorer/playwright.js";
import { InternalApi, identityFromEnv, loginKeyFor } from "./internal.js";
import { BedrockLlm } from "./llm/bedrock.js";
import { runTask, waitForProxy } from "./task.js";

/** The agent container's entrypoint: fetch the run's input, run the agents, exit non-zero on a platform failure. */
async function main(): Promise<void> {
  const identity = identityFromEnv();
  const api = new InternalApi(identity);
  const input = await api.getInput();
  const proxy = {
    host: "127.0.0.1",
    port: runtimeConfig.proxyPort,
    loginKey: loginKeyFor(identity.token),
  };
  await waitForProxy(proxy);

  let aborted = false;
  process.once("SIGTERM", () => {
    aborted = true;
  });

  // Evidence is best effort: the events are what the run is judged on.
  const post = async (name: Parameters<InternalApi["postEvidence"]>[0], body: object | null) => {
    if (!body) return;
    try {
      await api.postEvidence(name, body);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: "evidence_failed", name, error: (err as Error).message }),
      );
    }
  };

  // Usage goes out as it accrues, one post at a time, so a task that is killed still has its cost.
  let usageQueue: Promise<void> = Promise.resolve();
  const reportUsage = (usage: object) => {
    usageQueue = usageQueue.then(() => post("usage", usage));
  };

  const result = await runTask({
    input,
    sink: api,
    proxy,
    aborted: () => aborted,
    llm: new BedrockLlm({ modelId: input.budgets.llm.modelId, region: identity.region }),
    driverFactory: (options) => PlaywrightDriver.launch(options),
    onUsage: reportUsage,
  });

  await usageQueue;
  await post("app-profile", result.profile);
  await post("usage", result.usage);
  await post("explorer-log", result.explorerLog);
  await post("engagement", result.engagement);
  await post("dynamic-results", result.dynamic);

  console.log(
    JSON.stringify({
      msg: "agent_finished",
      checks: result.checks,
      findings: result.findings.length,
      gaps: result.gaps,
      stoppedBy: result.stoppedBy,
      profile: result.profile !== null,
      verification: result.verification,
      llm: result.usage,
    }),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(JSON.stringify({ msg: "agent_failed", error: (err as Error).message }));
    process.exit(1);
  },
);
