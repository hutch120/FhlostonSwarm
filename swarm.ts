#!/usr/bin/env node
import { Command } from "commander";
import { login } from "./utils/login.js";

const program = new Command();

program.name("swarm").description("Fhloston Swarm CLI").version("0.1.0");

program
  .command("login")
  .description("Sign in to the Swarm AWS account (default: browser console sign-in via `aws login`)")
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

await program.parseAsync();
