#!/usr/bin/env node
import { Command } from "commander";
import { cdk, type CdkAction } from "./utils/deploy.js";
import { login } from "./utils/login.js";
import { requireSwarmAccount } from "./utils/aws.js";
import { initSecrets } from "./utils/secrets.js";
import { testCleanup } from "./utils/test-cleanup.js";

const program = new Command();

program.name("swarm").description("Fhloston Swarm CLI").version("0.1.0");

program
  .command("login")
  .description(
    "Sign in to the Swarm AWS account (default: browser console sign-in via `aws login`)",
  )
  .option("--sso", "Use IAM Identity Center (SSO) instead of console sign-in")
  .option("--start-url <url>", "SSO start URL (implies --sso)")
  .option("--role <name>", "SSO permission set / role name")
  .option("--profile <name>", "AWS CLI profile name")
  .option("--remote", "Console sign-in without a local browser (paste the code manually)")
  .option("--no-browser", "SSO only: print the URL and code instead of opening a browser")
  .action(async (opts) => {
    try {
      await login(opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

for (const action of ["deploy", "diff", "synth"] as CdkAction[]) {
  program
    .command(action)
    .description(
      `Run \`cdk ${action}\` for src/infra with the swarm profile (checks the account first)`,
    )
    .argument("[cdk-args...]", "extra arguments passed to the CDK CLI (use -- before options)")
    .allowUnknownOption()
    .action(async (extra: string[]) => {
      try {
        await cdk(action, extra);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });
}

program
  .command("init-secrets")
  .description(
    "Create the auth pepper and JWT key as SSM SecureStrings if missing (never overwrites)",
  )
  .action(async () => {
    try {
      await requireSwarmAccount();
      await initSecrets();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("test-cleanup")
  .description(
    "List (and with --delete, remove) test data: _test/ objects, records with test:true, swarm-test-* resources",
  )
  .option("--delete", "Actually delete what is listed (default is a dry run)")
  .action(async (opts: { delete?: boolean }) => {
    try {
      await requireSwarmAccount();
      await testCleanup(opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
