import { runtimeConfig } from "@swarm/shared/server";
import { InternalApi, identityFromEnv } from "./internal.js";
import { runTask, waitForProxy } from "./task.js";

/** The agent container's entrypoint: fetch the run's input, run the agents, exit non-zero on a platform failure. */
async function main(): Promise<void> {
  const api = new InternalApi(identityFromEnv());
  const input = await api.getInput();
  const proxy = { host: "127.0.0.1", port: runtimeConfig.proxyPort };
  await waitForProxy(proxy);

  let aborted = false;
  process.once("SIGTERM", () => {
    aborted = true;
  });

  const result = await runTask({ input, sink: api, proxy, aborted: () => aborted });
  console.log(
    JSON.stringify({
      msg: "agent_finished",
      checks: result.checks,
      findings: result.findings.length,
      gaps: result.gaps,
      stoppedBy: result.stoppedBy,
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
