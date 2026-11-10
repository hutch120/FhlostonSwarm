import { proxyStatsSchema, runtimeConfig } from "@swarm/shared/server";
import { InternalApi, identityFromEnv, loginKeyFor } from "./internal.js";
import { createProxy } from "./proxy.js";

/**
 * The scope proxy sidecar: one per task, next to the agent container. It takes its allow-list from the
 * run's input, serves on localhost, and posts its request log and counters as evidence when it stops
 * (and every 30 seconds, in case it is killed).
 */
async function main(): Promise<void> {
  const identity = identityFromEnv();
  const api = new InternalApi(identity);
  const input = await api.getInput();
  const proxy = createProxy({
    scope: input.scope,
    requestsPerSecond: input.budgets.requestsPerSecond,
    requestCap: input.budgets.maxRequests,
    loginSubmissions: input.scope.loginSubmissions,
    loginKey: loginKeyFor(identity.token),
  });
  await proxy.listen(runtimeConfig.proxyPort, "127.0.0.1");
  console.log(JSON.stringify({ msg: "proxy_ready", port: runtimeConfig.proxyPort }));

  const flush = async () => {
    try {
      await api.postEvidence("proxy-log", proxy.log());
      await api.postEvidence("proxy-stats", proxyStatsSchema.parse(proxy.stats()));
    } catch (err) {
      console.error(JSON.stringify({ msg: "evidence_failed", name: (err as Error).name }));
    }
  };
  const timer = setInterval(() => void flush(), 30_000);
  const stop = async () => {
    clearInterval(timer);
    await flush();
    await proxy.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: "proxy_failed", error: (err as Error).message }));
  process.exit(1);
});
