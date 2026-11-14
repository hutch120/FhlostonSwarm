#!/usr/bin/env node
import { Command } from "commander";
import { cdk, type CdkAction } from "./utils/deploy.js";
import { grantCredit } from "./utils/grant-credit.js";
import { gate, learn, rollback, setEnabled, status, versions } from "./utils/learning.js";
import { login } from "./utils/login.js";
import { requireSwarmAccount } from "./utils/aws.js";
import { initSecrets } from "./utils/secrets.js";
import { testCleanup } from "./utils/test-cleanup.js";
import {
  startSyntheticTarget,
  stopSyntheticTarget,
  syntheticTargetStatus,
} from "./utils/synthetic-target.js";

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
  .command("grant-credit")
  .description(
    "Grant comp (staff-granted) credits of a scan depth to an account email; audit-logged. Until payments exist this is the only way for a customer to start a run",
  )
  .argument("<email>", "the account's email address")
  .argument("<tier>", "scan depth: scout, sweep, probe or siege")
  .argument("[count]", "how many credits (default 1)", "1")
  .requiredOption("--reason <text>", "why the credit is granted (recorded in the audit log)")
  .action(async (email: string, tier: string, count: string, opts: { reason: string }) => {
    try {
      await requireSwarmAccount();
      await grantCredit({ email, tier, count: Number(count), reason: opts.reason });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("test-cleanup")
  .description(
    "List (and with --delete, remove) test data: _test/ objects, records with test:true, swarm-test-* resources and running tasks",
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

const guarded =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await requireSwarmAccount();
      await fn(...args);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  };

program
  .command("learn")
  .description(
    "Run a learning pass: propose changes to the dynamic layer (learned items and agents) from a closed run and/or the allow-listed sources, and print the diff",
  )
  .option("--dry-run", "Work out the proposal and print it; write nothing")
  .option("--apply", "Validate, apply and publish the change as a new version")
  .option("--run <id>", "Review this closed run (default: the sources alone)")
  .option("--force", "Ask the model even when neither the run nor the sources call for a change")
  .action(guarded(learn));

const learning = program
  .command("learning")
  .description(
    "The dynamic layer: status, versions, rollback, kill switch and the regression gate",
  );
learning
  .command("status")
  .description(
    "The active version, counts, the regression gate, the last passes and whether the learner model can be invoked",
  )
  .option("--test", "The test accounts' layer (learning/test/)")
  .action(guarded(status));
learning
  .command("versions")
  .description("Every version of the layer, newest last; * marks the one runs use")
  .option("--test", "The test accounts' layer")
  .action(guarded(versions));
learning
  .command("rollback")
  .description("Point runs at an earlier version (nothing is deleted)")
  .argument("<version>", "the version number")
  .option("--test", "The test accounts' layer")
  .action(guarded((version: string, opts: { test?: boolean }) => rollback(Number(version), opts)));
learning
  .command("disable")
  .description("Kill switch: runs use the baseline only and nothing is learned")
  .option("--test", "The test accounts' layer")
  .action(guarded((opts: { test?: boolean }) => setEnabled(false, opts)));
learning
  .command("enable")
  .description("Switch the layer back on")
  .option("--test", "The test accounts' layer")
  .action(guarded((opts: { test?: boolean }) => setEnabled(true, opts)));
learning
  .command("gate")
  .description(
    "Record the synthetic-target regression a candidate needs before it is promoted, from a finished run of the synthetic target",
  )
  .requiredOption("--run <id>", "the run of the synthetic target")
  .action(guarded((opts: { run: string }) => gate(opts.run)));

const syntheticTarget = program
  .command("synthetic-target")
  .description(
    "The deliberately vulnerable test app: started on demand as a Fargate task, stopped after each use",
  );

for (const [name, description, run] of [
  ["start", "Start it and print its URL (waits until it answers)", startSyntheticTarget],
  ["stop", "Stop every running synthetic target task", stopSyntheticTarget],
  ["status", "Show whether it is running, and where", syntheticTargetStatus],
] as const) {
  syntheticTarget
    .command(name)
    .description(description)
    .action(async () => {
      try {
        await requireSwarmAccount();
        await run();
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });
}

await program.parseAsync();
