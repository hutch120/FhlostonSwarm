import { spawn } from "node:child_process";

export const ACCOUNT_ID = "885922397779";
export const REGION = "ap-southeast-2";
export const DEFAULT_PROFILE = "swarm";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the AWS CLI. With `inherit`, output goes straight to the terminal (needed for SSO prompts). */
export function aws(args: string[], opts: { inherit?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, {
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? new Error("AWS CLI not found. Install AWS CLI v2: https://aws.amazon.com/cli/")
          : err,
      ),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function getConfig(profile: string, key: string): Promise<string | undefined> {
  const r = await aws(["configure", "get", key, "--profile", profile]);
  const value = r.stdout.trim();
  return r.code === 0 && value ? value : undefined;
}

export async function setConfig(profile: string, key: string, value: string): Promise<void> {
  const r = await aws(["configure", "set", key, value, "--profile", profile]);
  if (r.code !== 0) throw new Error(`Failed to set ${key}: ${r.stderr.trim()}`);
}
