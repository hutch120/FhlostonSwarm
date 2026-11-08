import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROFILE, requireSwarmAccount } from "./aws.js";

export type CdkAction = "deploy" | "diff" | "synth";

const INFRA_DIR = fileURLToPath(new URL("../src/infra", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../src/web", import.meta.url));

export function cdkArgs(action: CdkAction, extra: string[]): string[] {
  const args: string[] = [action];
  // Stack ids all start with "Swarm"; deploy/diff cover every stack unless some are named.
  if (action !== "synth" && !extra.some((a) => a.startsWith("Swarm"))) args.push("--all");
  return [...args, "--profile", DEFAULT_PROFILE, ...extra];
}

/** Builds the SPA so the edge stack publishes the real app (src/web/dist), not the placeholder. */
async function buildWeb(): Promise<void> {
  const viteDir = dirname(createRequire(import.meta.url).resolve("vite/package.json"));
  const vite = join(viteDir, "bin", "vite.js");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [vite, "build"], { cwd: WEB_DIR, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`Web build failed (exit ${code}).`);
}

/** Runs the CDK CLI for src/infra, after confirming the swarm account. */
export async function cdk(action: CdkAction, extra: string[]): Promise<void> {
  await requireSwarmAccount();
  await buildWeb();
  const cdkBin = createRequire(import.meta.url).resolve("aws-cdk/bin/cdk");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cdkBin, ...cdkArgs(action, extra)], {
      cwd: INFRA_DIR,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`cdk ${action} failed (exit ${code}).`);
}
