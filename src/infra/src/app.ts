import { App, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { SwarmConfig } from "./config.js";
import { ApiStack } from "./stacks/api-stack.js";
import { DataStack } from "./stacks/data-stack.js";
import { DnsStack } from "./stacks/dns-stack.js";
import { EdgeStack } from "./stacks/edge-stack.js";
import { OpsStack } from "./stacks/ops-stack.js";
import { SesStack } from "./stacks/ses-stack.js";

/** Builds the single-environment CDK app (no stages, no stage prefixes). */
export function buildApp(config: SwarmConfig, app = new App()): App {
  const env = { account: config.account, region: config.region };

  new DataStack(app, "SwarmData", { env, config });
  const dns = new DnsStack(app, "SwarmDns", { env, config });
  const ses = new SesStack(app, "SwarmSes", { env, config, zone: dns.zone });
  const api = new ApiStack(app, "SwarmApi", {
    env,
    config,
    configurationSet: ses.configurationSet,
    feedbackTopic: ses.feedbackTopic,
  });
  const edge = new EdgeStack(app, "SwarmEdge", {
    env,
    config,
    zone: dns.zone,
    apiDomain: api.apiDomain,
  });
  new OpsStack(app, "SwarmOps", { env, config });
  edge.addStackDependency(dns);
  ses.addStackDependency(dns);

  Tags.of(app).add("swarm:test", "false");
  Tags.of(app).add("swarm:project", "fhloston-swarm");
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return app;
}
